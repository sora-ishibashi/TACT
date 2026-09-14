// TACT Work — TIME-P1c: orchestrates
//   TemporalRequirement -> Availability Request -> Provider (READ) ->
//   Canonical Busy Intervals -> Slot Engine -> Candidate Slots -> result
//
// This is intentionally NOT wired into core/tact-conversation/orchestration.ts's
// live Slack/chat turn flow yet (per product decision — TIME-P1c ships the
// provider-neutral foundation with a Fake provider first; real Composio
// Google Calendar wiring, and the Capability Registry / decomposer / rule
// router changes needed to route a live request here, are deferred to a
// later phase). This file is a pure, fully unit-testable entry point that a
// later wiring phase can call directly.
//
// READ ONLY / NO APPROVAL (Section 22): this function never calls anything
// that writes to a calendar, never creates a TACT Approval, and candidate
// generation alone never books anything — CalendarAvailabilityProvider
// structurally has no write method (calendarAvailability.ts), and nothing
// here calls core/tact-work/approval.ts.

import type { TemporalRequirement } from "./temporalRequirements";
import { resolveTemporalDateRange, type ResolvedTemporalRange } from "./temporalRange";
import {
  normalizeBusyIntervals,
  type CalendarAvailabilityProvider,
  type CalendarAvailabilitySourceScope,
} from "./calendarAvailability";
import {
  generateCandidateSlots,
  DEFAULT_CANDIDATE_COUNT,
  type CandidateSlot,
  type DailyWindow,
} from "./slotEngine";
import { isKnownTimeZone } from "./timezone";

// =========================
// Clarification-answer parsers (TIME-P1c only)
// =========================
//
// Deliberately separate from core/tact-work/temporalRequirements.ts's own
// extractTemporalRequirement(): timezone and daily-window are never inferred
// from the original free-text request (Section 7/12 absolute conditions),
// only from a direct answer to a Clarification this module itself asks. Both
// parsers fail closed (return undefined) rather than guess.

// Accepts only an exact IANA identifier the runtime itself recognizes (e.g.
// "Asia/Tokyo"). Never derives a timezone from a city name, abbreviation
// (e.g. "JST"), or offset (e.g. "+09:00") — those are all forms of guessing.
export function extractTimezoneAnswer(input: string): string | undefined {
  const trimmed = input.trim();
  return trimmed && isKnownTimeZone(trimmed) ? trimmed : undefined;
}

const DAILY_WINDOW_PATTERN = /([01]?\d|2[0-3]):([0-5]\d)\s*(?:〜|～|-|–|to)\s*([01]?\d|2[0-3]):([0-5]\d)/;

export function extractDailyWindowAnswer(input: string): DailyWindow | undefined {

  const match = input.match(DAILY_WINDOW_PATTERN);

  if (!match) {
    return undefined;
  }

  const startMinuteOfDay = Number(match[1]) * 60 + Number(match[2]);
  const endMinuteOfDay = Number(match[3]) * 60 + Number(match[4]);

  return endMinuteOfDay > startMinuteOfDay ? { startMinuteOfDay, endMinuteOfDay } : undefined;

}

// =========================
// Candidate snapshot persistence (Section 19/23)
// =========================
//
// Mirrors core/tact-work/temporalRequirements.ts's
// toTemporalRequirementMetadata()/readTemporalRequirementMetadata() pattern:
// a versioned, defensively-validated shape stored under its own
// Work.metadata key, so a later "2番で" reference resolves against exactly
// the snapshot originally shown (Section 19 — TOCTOU-safe pinning) rather
// than a silently recomputed, possibly-different set of candidates.

export interface CandidateSlotSnapshotMetadata {
  readonly version: 1;
  // The referenceInstantUtc this snapshot was generated against — not a
  // freshness guarantee (Section 20: a candidate generated at T1 may no
  // longer be free at T2), just an audit trail of when it was produced.
  readonly generatedAtUtc: string;
  readonly sourceScope: CalendarAvailabilitySourceScope;
  readonly candidates: readonly CandidateSlot[];
}

export function toCandidateSlotSnapshotMetadata(
  candidates: readonly CandidateSlot[],
  generatedAtUtc: string,
  sourceScope: CalendarAvailabilitySourceScope
): CandidateSlotSnapshotMetadata {
  return { version: 1, generatedAtUtc, sourceScope, candidates };
}

function isCandidateSlot(value: unknown): value is CandidateSlot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.index === "number" &&
    typeof candidate.startUtc === "string" &&
    typeof candidate.endUtc === "string" &&
    typeof candidate.timezone === "string"
  );
}

export function readCandidateSlotSnapshotMetadata(
  metadata: Record<string, unknown> | null | undefined
): CandidateSlotSnapshotMetadata | undefined {

  const value = metadata?.calendarCandidateSnapshot;

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;

  if (
    candidate.version !== 1 ||
    typeof candidate.generatedAtUtc !== "string" ||
    candidate.sourceScope !== "own_calendar" ||
    !Array.isArray(candidate.candidates) ||
    !candidate.candidates.every(isCandidateSlot)
  ) {
    return undefined;
  }

  return {
    version: 1,
    generatedAtUtc: candidate.generatedAtUtc,
    sourceScope: "own_calendar",
    candidates: candidate.candidates,
  };

}

// =========================
// generateCandidateSchedule
// =========================

export type GenerateCandidateScheduleErrorCode =
  | "timezone_missing"
  | "timezone_unrecognized"
  | "daily_window_missing"
  | "temporal_requirement_incomplete"
  | "connection_missing"
  | "permission_denied"
  | "provider_failure"
  | "malformed_response"
  | "no_availability";

export interface GenerateCandidateScheduleError {
  readonly code: GenerateCandidateScheduleErrorCode;
  readonly message: string;
}

export interface GenerateCandidateScheduleSuccess {
  readonly success: true;
  readonly candidates: readonly CandidateSlot[];
  readonly snapshot: CandidateSlotSnapshotMetadata;
  readonly resolvedRange: ResolvedTemporalRange;
  readonly sourceScope: CalendarAvailabilitySourceScope;
}

export type GenerateCandidateScheduleResult =
  | GenerateCandidateScheduleSuccess
  | { readonly success: false; readonly error: GenerateCandidateScheduleError };

export interface GenerateCandidateScheduleParams {
  readonly requirement: TemporalRequirement;
  // Injected explicitly — never read from server/process time inside this
  // function or anything it calls (Section 7/8 absolute condition).
  readonly referenceInstantUtc: string;
  readonly provider: CalendarAvailabilityProvider;
  readonly granularityMinutes?: number;
}

export async function generateCandidateSchedule(
  params: GenerateCandidateScheduleParams
): Promise<GenerateCandidateScheduleResult> {

  const { requirement } = params;

  if (!requirement.timezone) {
    return { success: false, error: { code: "timezone_missing", message: "どのタイムゾーンで候補を出しますか?" } };
  }

  if (!requirement.dailyWindow) {
    return { success: false, error: { code: "daily_window_missing", message: "何時から何時の間で候補を探しますか?" } };
  }

  if (!requirement.durationMinutes) {
    return { success: false, error: { code: "temporal_requirement_incomplete", message: "会議の所要時間が確定していません。" } };
  }

  const rangeResolution = resolveTemporalDateRange(requirement.date, params.referenceInstantUtc, requirement.timezone);

  if (!rangeResolution.success) {

    if (rangeResolution.code === "timezone_missing") {
      return { success: false, error: { code: "timezone_missing", message: "どのタイムゾーンで候補を出しますか?" } };
    }

    if (rangeResolution.code === "timezone_unrecognized") {
      return { success: false, error: { code: "timezone_unrecognized", message: "指定されたタイムゾーンを認識できませんでした。" } };
    }

    return { success: false, error: { code: "temporal_requirement_incomplete", message: "候補を探す日程の範囲が確定していません。" } };

  }

  const { range } = rangeResolution;

  const providerResult = await params.provider.getAvailability({
    rangeStartUtc: range.startUtc,
    rangeEndUtc: range.endUtc,
    timezone: requirement.timezone,
  });

  if (!providerResult.success) {
    return { success: false, error: { code: providerResult.error.code, message: providerResult.error.message } };
  }

  const availability = providerResult.result;

  const normalizedBusyIntervals = normalizeBusyIntervals(
    availability.busyIntervals,
    availability.rangeStartUtc,
    availability.rangeEndUtc
  );

  const candidates = generateCandidateSlots({
    rangeStartUtc: availability.rangeStartUtc,
    rangeEndUtc: availability.rangeEndUtc,
    timezone: availability.timezone,
    durationMinutes: requirement.durationMinutes,
    busyIntervals: normalizedBusyIntervals,
    dailyWindow: requirement.dailyWindow,
    candidateCount: requirement.candidateCount ?? DEFAULT_CANDIDATE_COUNT,
    granularityMinutes: params.granularityMinutes,
  });

  if (candidates.length === 0) {
    return {
      success: false,
      error: { code: "no_availability", message: "指定の条件では空いている候補が見つかりませんでした。" },
    };
  }

  return {
    success: true,
    candidates,
    snapshot: toCandidateSlotSnapshotMetadata(candidates, params.referenceInstantUtc, availability.sourceScope),
    resolvedRange: range,
    sourceScope: availability.sourceScope,
  };

}
