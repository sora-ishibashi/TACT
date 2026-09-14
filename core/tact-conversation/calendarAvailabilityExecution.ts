// TACT Conversation — TIME-P1c Calendar Wiring: the composition-root bridge
// that connects
//   Work.metadata (TemporalRequirement, TIME-P1b/TIME-P1c)
//     -> core/tact-work/candidateSchedule.ts's generateCandidateSchedule()
//        (temporal range resolution + slot engine + snapshot, provider-neutral)
//     -> a CalendarAvailabilityProvider implemented HERE that drives the
//        REAL canonical Execution Boundary
//        (core/tact-integration/execution.ts's executeReadIntegrationAction())
//     -> the real Composio Google Calendar adapter
//        (core/tact-integration/providers/composio/adapter.ts,
//        service="google_calendar", operation="availability_read")
//
// This is the single place in the codebase where core/tact-work's
// provider-neutral scheduling pipeline and core/tact-integration's canonical
// Connection/Policy/Execution boundary are wired together for Calendar —
// mirroring the existing role core/tact-conversation/orchestration.ts's
// resolveIntegrationConnectionViaTactIntegrationForTesting() already plays
// for Slack/Gmail/Notion (this file reuses that exact function unchanged,
// rather than re-deriving connection resolution).
//
// Deliberately NOT wired into orchestration.ts's live Slack/chat turn flow,
// the Capability Registry (core/tact-core/capabilities/registry.ts), or
// classifyIntent()/TactIntent's closed union (TIME-P1c Calendar Wiring
// phase, explicit STOP condition: no broad Integration architecture
// rewrite, no natural-language routing change). The reason is structural,
// not just caution: core/tact-orchestrator/types.ts's
// CapabilityInvocationRequest (the shape a free-text Capability Registry
// handler receives) has no field for a resolved TemporalRequirement or a
// reference instant, so there is no existing free-text entry point this
// function could safely attach to without inventing that shape first — a
// separate, higher-stakes design decision this phase does not make (see the
// final report's "next risky step"). This function is instead a fully
// explicit, DI-testable entry point a later, explicitly-approved wiring
// phase can call directly once that gap is resolved.
//
// Read-only / no Approval (Section 8 precedent, calendarAvailability.ts):
// this file never imports core/tact-work/approval.ts and never emits an
// Approval — executeReadIntegrationAction() (the only execution path this
// file calls) structurally has no Approval concept for reads.
//
// Connection trust boundary (absolute condition, Section 10/11 of this
// phase's instructions): this function NEVER accepts a connectionId as a
// parameter. It always re-derives the caller's Google Calendar connection
// from scratch via resolveIntegrationConnectionViaTactIntegrationForTesting()
// (userId-scoped, active-only lookup) on every call — there is structurally
// no argument here through which a caller, an LLM, or Work/Task metadata
// could inject an arbitrary connectionId. A connection belonging to a
// different user never appears in that userId-scoped lookup at all (it
// resolves to "none", exactly like never having connected), and even if
// this function had a latent bug, executeReadIntegrationAction() itself
// re-validates connection ownership + active status a second time
// (validateConnectionForExecution()) before any provider call — defense in
// depth, not a single point of trust.

import { getWork, updateWorkCandidateSnapshotMetadata } from "../tact-work/store";
import { readTemporalRequirementMetadata } from "../tact-work/temporalRequirements";
import {
  generateCandidateSchedule,
  preflightCandidateSchedule,
  type GenerateCandidateScheduleError,
} from "../tact-work/candidateSchedule";
import type { CandidateSlotSnapshotMetadata } from "../tact-work/candidateSchedule";
import type { CandidateSlot } from "../tact-work/slotEngine";
import type {
  AvailabilityResult,
  BusyInterval,
  CalendarAvailabilityError,
  CalendarAvailabilityProvider,
  CalendarAvailabilityProviderResult,
} from "../tact-work/calendarAvailability";
import {
  executeReadIntegrationAction,
  type IntegrationActionExecutionOutcome,
} from "../tact-integration/execution";
import { listConnectionsForUser } from "../tact-integration/connection";
import type { IntegrationService } from "../tact-integration/types";
import { resolveIntegrationConnectionViaTactIntegrationForTesting } from "./orchestration";

const GOOGLE_CALENDAR_SERVICE: IntegrationService = "google_calendar";
const AVAILABILITY_READ_OPERATION = "availability_read";

// =========================
// Canonical error taxonomy (Section 17 of this phase's instructions)
// =========================
//
// The 8 required, mutually-distinguishable names are all present verbatim:
// calendar_not_connected / calendar_permission_denied / calendar_provider_failed
// / malformed_provider_result / timezone_required / temporal_requirement_incomplete
// / daily_window_missing / no_available_slots. A few additional codes are
// preserved alongside them (rather than folded into the nearest of the 8)
// because core/tact-work/candidateSchedule.ts's own
// GenerateCandidateScheduleErrorCode already distinguishes them and nothing
// requires discarding that precision at this outer boundary:
//   - reference_instant_invalid / dst_invalid_local_time: distinct from
//     timezone_required (Blocker C/D, TIME-P1c Hardening) — a caller fixing
//     "no timezone was ever given" needs a different fix than one hitting a
//     genuine DST gap/fold.
//   - calendar_connection_ambiguous: the existing "multiple active
//     connections" outcome already used for Slack/Gmail/Notion connection
//     resolution (core/tact-work/execution.ts, ResolveIntegrationConnectionOutcome)
//     — distinct from "not connected at all" (calendar_not_connected).
//   - work_not_found / work_not_running / snapshot_persistence_failed:
//     preconditions this bridge itself checks, outside
//     generateCandidateSchedule()'s own scope.
export type CalendarSchedulingErrorCode =
  | "calendar_not_connected"
  | "calendar_connection_ambiguous"
  | "calendar_permission_denied"
  | "calendar_provider_failed"
  | "malformed_provider_result"
  | "timezone_required"
  | "reference_instant_invalid"
  | "dst_invalid_local_time"
  | "temporal_requirement_incomplete"
  | "daily_window_missing"
  | "no_available_slots"
  | "work_not_found"
  | "work_not_running"
  | "snapshot_persistence_failed";

export interface CalendarSchedulingError {
  readonly code: CalendarSchedulingErrorCode;
  readonly message: string;
}

export interface ExecuteCalendarAvailabilitySchedulingParams {
  readonly workId: string;
  readonly taskId: string;
  readonly userId: string;
  readonly accessToken: string;
  // Injected explicitly — never read from server/process time inside this
  // function or anything it calls (same absolute condition as
  // core/tact-work/candidateSchedule.ts's generateCandidateSchedule()).
  readonly referenceInstantUtc: string;
}

export type ExecuteCalendarAvailabilitySchedulingResult =
  | {
      readonly success: true;
      readonly candidates: readonly CandidateSlot[];
      readonly snapshot: CandidateSlotSnapshotMetadata;
    }
  | { readonly success: false; readonly error: CalendarSchedulingError };

export interface ExecuteCalendarAvailabilitySchedulingDeps {
  getWork: typeof getWork;
  listConnectionsForUser: typeof listConnectionsForUser;
  executeReadIntegrationAction: typeof executeReadIntegrationAction;
  updateWorkCandidateSnapshotMetadata: typeof updateWorkCandidateSnapshotMetadata;
}

const defaultDeps: ExecuteCalendarAvailabilitySchedulingDeps = {
  getWork,
  listConnectionsForUser,
  executeReadIntegrationAction,
  updateWorkCandidateSnapshotMetadata,
};

// =========================
// GenerateCandidateScheduleError -> CalendarSchedulingError
// =========================
//
// Exhaustive switch (no default branch): if candidateSchedule.ts's error
// union ever grows, this fails to compile rather than silently falling
// through to a generic code — the same "compile-time exhaustiveness"
// discipline already used by core/tact-orchestrator/capabilityPlan.ts for
// TactIntent.
function mapScheduleErrorToCalendarSchedulingError(
  error: GenerateCandidateScheduleError
): CalendarSchedulingError {

  switch (error.code) {
    case "timezone_missing":
    case "timezone_unrecognized":
      return { code: "timezone_required", message: error.message };
    case "reference_instant_invalid":
      return { code: "reference_instant_invalid", message: error.message };
    case "dst_invalid_local_time":
      return { code: "dst_invalid_local_time", message: error.message };
    case "daily_window_missing":
      return { code: "daily_window_missing", message: error.message };
    case "temporal_requirement_incomplete":
      return { code: "temporal_requirement_incomplete", message: error.message };
    case "connection_missing":
      return { code: "calendar_not_connected", message: error.message };
    case "permission_denied":
      return { code: "calendar_permission_denied", message: error.message };
    case "provider_failure":
      return { code: "calendar_provider_failed", message: error.message };
    case "malformed_response":
      return { code: "malformed_provider_result", message: error.message };
    case "no_availability":
      return { code: "no_available_slots", message: error.message };
  }

}

// =========================
// executeReadIntegrationAction() outcome -> CalendarAvailabilityProviderResult
// =========================

function isBusyIntervalShape(value: unknown): value is BusyInterval {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).startUtc === "string" &&
    typeof (value as Record<string, unknown>).endUtc === "string"
  );
}

// Strict runtime validation of the JSON round-trip
// (Run.result.output, a string — see core/tact-integration/execution.ts's
// executeIntegrationActionCore()) back into an AvailabilityResult. A value
// with the wrong shape is malformed_provider_result, never a best-effort
// partial parse (same "fail the whole result, never silently drop a piece"
// principle as providers/composio/mappings/googleCalendar.ts's own
// normalizer, applied one layer further out).
function isAvailabilityResultShape(value: unknown): value is AvailabilityResult {

  if (!value || typeof value !== "object") {
    return false;
  }

  const v = value as Record<string, unknown>;

  return (
    typeof v.rangeStartUtc === "string" &&
    typeof v.rangeEndUtc === "string" &&
    typeof v.timezone === "string" &&
    Array.isArray(v.busyIntervals) &&
    v.busyIntervals.every(isBusyIntervalShape) &&
    v.sourceScope === "own_calendar"
  );

}

function parseJsonSafely(raw: string | null | undefined): unknown {

  if (typeof raw !== "string") {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }

}

// core/tact-integration/types.tsのIntegrationErrorCode(generic, provider-
// neutral)を、core/tact-work/calendarAvailability.tsのCalendarAvailabilityErrorCode
// (4値、Calendar-scoped)へ narrowing する——
// providers/composio/adapter.tsのmapCalendarAvailabilityErrorToIntegrationError()
// の、ちょうど逆方向。Run.externalRef.errorCodeとして永続化された値
// (core/tact-integration/execution.tsのexecuteIntegrationActionCore()参照)
// をここで読み戻す。
function mapIntegrationErrorCodeToCalendarAvailabilityError(
  errorCode: unknown,
  message: string | null | undefined
): CalendarAvailabilityError {

  const safeMessage = message ?? "Calendar providerの呼び出しでエラーが発生しました。";

  switch (errorCode) {
    case "connection_missing":
      return { code: "connection_missing", message: safeMessage };
    case "authorization_denied":
    case "authentication_error":
      return { code: "permission_denied", message: safeMessage };
    case "malformed_response":
      return { code: "malformed_response", message: safeMessage };
    case "invalid_action":
    case "provider_execution_failed":
    case "temporary_failure":
    default:
      return { code: "provider_failure", message: safeMessage };
  }

}

function mapExecutionOutcomeToCalendarAvailabilityResult(
  outcome: IntegrationActionExecutionOutcome
): CalendarAvailabilityProviderResult {

  if (outcome.status === "completed") {

    const parsed = parseJsonSafely(outcome.run.result?.output);

    if (!isAvailabilityResultShape(parsed)) {
      return {
        success: false,
        error: {
          code: "malformed_response",
          message: "Provider実行は成功しましたが、結果の形式が検証済みcontractと一致しませんでした。",
        },
      };
    }

    return { success: true, result: parsed };

  }

  if (outcome.status === "failed") {
    return {
      success: false,
      error: mapIntegrationErrorCodeToCalendarAvailabilityError(
        outcome.run.externalRef?.errorCode,
        outcome.run.error
      ),
    };
  }

  if (outcome.status === "connection_unavailable") {
    return {
      success: false,
      error: {
        code: "connection_missing",
        message: "Googleカレンダー接続が現在利用できません(未接続、または有効な接続ではありません)。",
      },
    };
  }

  // Defensive-only: IntegrationActionExecutionOutcome is one shared union
  // across both executeApprovedIntegrationAction() (write) and
  // executeReadIntegrationAction() (read, the only path this file calls).
  // Every remaining member (not_found/work_not_runnable/invalid_action/
  // already_executed/approval_integrity_failed/task_not_executable) is
  // either Approval-specific (unreachable — reads never carry an
  // approvalId) or a precondition this bridge already checked before ever
  // reaching executeReadIntegrationAction() (work_not_runnable). None of
  // them may be silently treated as "no availability" or otherwise
  // fabricate a result (Section 17 absolute condition).
  return {
    success: false,
    error: {
      code: "provider_failure",
      message: `Calendar availability read execution boundary returned an unexpected outcome: "${outcome.status}".`,
    },
  };

}

// =========================
// executeCalendarAvailabilityScheduling
// =========================

export async function executeCalendarAvailabilityScheduling(
  params: ExecuteCalendarAvailabilitySchedulingParams,
  deps: ExecuteCalendarAvailabilitySchedulingDeps = defaultDeps
): Promise<ExecuteCalendarAvailabilitySchedulingResult> {

  const { workId, taskId, userId, accessToken, referenceInstantUtc } = params;

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { success: false, error: { code: "work_not_found", message: "指定されたWorkが見つかりませんでした。" } };
  }

  // executeReadIntegrationAction() itself also requires work.status ===
  // "running" (validateReadExecutionPreconditions()) — checked again here
  // up front so a missing-connection/temporal-incomplete case is reported
  // BEFORE any provider dispatch is even attempted for a non-running Work,
  // matching this phase's "temporal prerequisites gate provider invocation"
  // requirement as tightly as possible.
  if (work.status !== "running") {
    return {
      success: false,
      error: { code: "work_not_running", message: `Workは現在「${work.status}」状態のため、Calendar読み取りを実行できません。` },
    };
  }

  const requirement = readTemporalRequirementMetadata(work.metadata)?.requirement;

  if (!requirement) {
    return {
      success: false,
      error: { code: "temporal_requirement_incomplete", message: "候補生成に必要な日時情報がまだ確定していません。" },
    };
  }

  // Validate the complete temporal request before connection lookup. This
  // keeps clarification independent from connection state and guarantees no
  // connection resolver/provider path runs for incomplete temporal input.
  const temporalPreflight = preflightCandidateSchedule({ requirement, referenceInstantUtc });

  if (!temporalPreflight.success) {
    return { success: false, error: mapScheduleErrorToCalendarSchedulingError(temporalPreflight.error) };
  }

  // Connection resolution: user-scoped, active-only, re-derived from
  // scratch on every call (see this file's header comment — absolute
  // condition, never accepts a caller-supplied connectionId).
  const connectionResolution = await resolveIntegrationConnectionViaTactIntegrationForTesting(
    { service: GOOGLE_CALENDAR_SERVICE, userId, accessToken },
    { listConnectionsForUser: deps.listConnectionsForUser }
  );

  if (connectionResolution.status === "none") {
    return {
      success: false,
      error: { code: "calendar_not_connected", message: "Googleカレンダーが接続されていません。" },
    };
  }

  if (connectionResolution.status === "multiple") {
    return {
      success: false,
      error: {
        code: "calendar_connection_ambiguous",
        message: "複数の有効なGoogleカレンダー接続が見つかりました。どちらを使うか特定できません。",
      },
    };
  }

  const { connectionId } = connectionResolution;

  const provider: CalendarAvailabilityProvider = {

    async getAvailability(request): Promise<CalendarAvailabilityProviderResult> {

      const outcome = await deps.executeReadIntegrationAction({
        workId,
        userId,
        accessToken,
        taskId,
        connectionId,
        action: {
          service: GOOGLE_CALENDAR_SERVICE,
          operation: AVAILABILITY_READ_OPERATION,
          input: {
            rangeStartUtc: request.rangeStartUtc,
            rangeEndUtc: request.rangeEndUtc,
            timezone: request.timezone,
          },
        },
      });

      return mapExecutionOutcomeToCalendarAvailabilityResult(outcome);

    },

  };

  const scheduleResult = await generateCandidateSchedule({ requirement, referenceInstantUtc, provider });

  if (!scheduleResult.success) {
    return { success: false, error: mapScheduleErrorToCalendarSchedulingError(scheduleResult.error) };
  }

  const persisted = await deps.updateWorkCandidateSnapshotMetadata(
    workId,
    userId,
    accessToken,
    scheduleResult.snapshot
  );

  if (!persisted) {
    // A real Calendar read already succeeded at this point (scheduleResult
    // carries a genuine result) — but this function's contract is "the
    // pinned snapshot was durably stored", and an optimistic-concurrency
    // loss or a vanished Work means it was not. Reporting success here
    // would let a caller believe a snapshot exists (referenceable by index
    // later, per Section 19's TOCTOU-safe pinning) when none was actually
    // persisted.
    return {
      success: false,
      error: {
        code: "snapshot_persistence_failed",
        message: "候補スナップショットの保存に失敗しました(競合状態、またはWorkが更新された可能性があります)。",
      },
    };
  }

  return { success: true, candidates: scheduleResult.candidates, snapshot: scheduleResult.snapshot };

}
