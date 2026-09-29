// =========================
// TACT Canonical Execution — SOR-77 getExecutionCorrectionContext()
// =========================
//
// 対象: core/tact-execution/correlation/store.tsのgetExecutionCorrectionContext()。
// 絶対条件(SOR-77指示「do not add duplicate columns if append-only
// correlation history can derive these values reliably」): predicted/
// correctionはいずれも新しい列を持たず、既存のtact_execution_work_
// correlations historyから導出されるだけ——このfileはその導出ロジック
// (特に「訂正の後に無関係な自動再評価が積まれた場合」のedge case)を
// 検証する。実Supabase接続は一切行わない。

import {
  getExecutionCorrectionContext,
  type GetExecutionCorrectionContextDeps,
} from "../../../../core/tact-execution/correlation/store";
import type { WorkCorrelationDecision } from "../../../../core/tact-execution/correlation/types";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: null,
    correlationStatus: "unresolved",
    connectionId: null,
    actorKind: "human",
    actorId: "U123",
    agentId: null,
    onBehalfOfActorKind: null,
    onBehalfOfActorId: null,
    provider: "slack",
    sourceType: "webhook",
    externalEventId: "Ev1",
    adapterVersion: "v1",
    sourceMetadata: null,
    rawPayloadRef: null,
    actionCategory: "create",
    operation: "app_mention",
    resourceType: null,
    resourceIdentifier: null,
    targetProvider: null,
    status: "succeeded",
    errorCode: null,
    errorMessage: null,
    permissionStatus: "pending",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    providerOccurredAt: null,
    observedAt: "2026-09-20T12:00:00.000Z",
    persistedAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

function makeDecision(overrides: Partial<WorkCorrelationDecision> = {}): WorkCorrelationDecision {
  return {
    executionId: "exec-1",
    status: "ambiguous",
    workId: null,
    method: "structural",
    confidence: 0.5,
    reasonCode: "multiple_works_share_structural_context",
    correlatorVersion: "work-correlator-v1",
    candidateWorkIds: ["work-a", "work-b"],
    correlatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

function deps(execution: CanonicalExecution | undefined, history: WorkCorrelationDecision[]): GetExecutionCorrectionContextDeps {
  return {
    getExecutionById: async () => execution,
    listWorkCorrelationDecisionsForExecution: async () => history,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Execution not found (foreign tenant / deleted) -> undefined ----
  {
    const context = await getExecutionCorrectionContext("exec-1", "user-1", deps(undefined, []));
    results.push(check("[Tenant] execution not found returns undefined, never fabricated", context === undefined));
  }

  // ---- No history at all -> predicted=null, correction=null (never fabricated) ----
  {
    const context = await getExecutionCorrectionContext("exec-1", "user-1", deps(makeExecution(), []));
    results.push(check(
      "[No history] predicted and correction are both null when no decision has ever been recorded",
      context?.predicted === null && context?.correction === null && context?.history.length === 0
    ));
  }

  // ---- Auto decisions only, never corrected -> predicted = latest auto decision, correction = null ----
  {
    const history = [
      makeDecision({ correlatedAt: "2026-09-20T12:05:00.000Z", candidateWorkIds: ["work-a", "work-b"] }),
      makeDecision({ correlatedAt: "2026-09-20T12:00:00.000Z", candidateWorkIds: ["work-a"] }),
    ];
    const context = await getExecutionCorrectionContext("exec-1", "user-1", deps(makeExecution(), history));
    results.push(check(
      "[Never corrected] predicted is the newest decision, correction is null",
      context?.correction === null &&
        context?.predicted?.correlatedAt === "2026-09-20T12:05:00.000Z" &&
        JSON.stringify(context?.predicted?.candidateWorkIds) === JSON.stringify(["work-a", "work-b"])
    ));
  }

  // ---- Auto decision, then a human correction -> predicted = the auto decision
  // right before the correction; correction = the manual_override ----
  {
    const autoDecision = makeDecision({
      correlatedAt: "2026-09-20T12:00:00.000Z",
      candidateWorkIds: ["work-a", "work-b"],
      confidence: 0.5,
    });
    const correctionDecision = makeDecision({
      status: "matched",
      workId: "work-a",
      method: "manual_override",
      confidence: null,
      candidateWorkIds: null,
      reasonCode: "human_confirmed_candidate",
      previousWorkId: null,
      changedByActorKind: "human",
      changedByActorId: "user-1",
      correlatedAt: "2026-09-20T12:10:00.000Z",
    });

    const context = await getExecutionCorrectionContext(
      "exec-1",
      "user-1",
      deps(makeExecution({ workId: "work-a", correlationStatus: "matched" }), [correctionDecision, autoDecision])
    );

    results.push(check(
      "[Corrected] predicted is the auto decision that preceded the correction (candidates preserved for audit)",
      context?.predicted?.method === "structural" &&
        JSON.stringify(context?.predicted?.candidateWorkIds) === JSON.stringify(["work-a", "work-b"])
    ));

    results.push(check(
      "[Corrected] correction reflects the manual_override entry with its own actor/reason/timestamp",
      context?.correction?.finalWorkId === "work-a" &&
        context?.correction?.reasonCode === "human_confirmed_candidate" &&
        context?.correction?.changedByActorKind === "human" &&
        context?.correction?.changedByActorId === "user-1" &&
        context?.correction?.correlatedAt === "2026-09-20T12:10:00.000Z"
    ));
  }

  // ---- Edge case (the reason predicted must not just be "newest non-override"):
  // a duplicate webhook retry re-runs the auto pipeline *after* a human "Keep
  // Unassigned" correction (correlationStatus stays non-"matched", so
  // observeExecutionWorkCorrelation() does not block re-evaluation). The
  // newer auto decision must NOT be reported as "predicted" — predicted must
  // still reflect what the human actually reacted to. ----
  {
    const preCorrectionAuto = makeDecision({
      correlatedAt: "2026-09-20T12:00:00.000Z",
      candidateWorkIds: ["work-a", "work-b"],
      reasonCode: "multiple_works_share_structural_context",
    });
    const keepUnassignedCorrection = makeDecision({
      status: "unresolved",
      workId: null,
      method: "manual_override",
      confidence: null,
      candidateWorkIds: null,
      reasonCode: "human_kept_unassigned",
      previousWorkId: null,
      changedByActorKind: "human",
      changedByActorId: "user-1",
      correlatedAt: "2026-09-20T12:10:00.000Z",
    });
    // A later, unrelated auto re-evaluation after the correction (e.g. a
    // duplicate delivery retry). Newest entry in the array.
    const postCorrectionAuto = makeDecision({
      status: "ambiguous",
      candidateWorkIds: ["work-c", "work-d"],
      reasonCode: "multiple_works_share_structural_context",
      correlatedAt: "2026-09-20T13:00:00.000Z",
    });

    const context = await getExecutionCorrectionContext(
      "exec-1",
      "user-1",
      deps(
        makeExecution({ workId: null, correlationStatus: "ambiguous" }),
        [postCorrectionAuto, keepUnassignedCorrection, preCorrectionAuto]
      )
    );

    results.push(check(
      "[Edge case] predicted is the auto decision BEFORE the correction, not a later unrelated re-evaluation",
      JSON.stringify(context?.predicted?.candidateWorkIds) === JSON.stringify(["work-a", "work-b"])
    ));

    results.push(check(
      "[Edge case] correction is still the human's Keep Unassigned decision, and the full trail (including the later re-evaluation) remains visible in history",
      context?.correction?.reasonCode === "human_kept_unassigned" &&
        context?.history.length === 3
    ));
  }

  return summarize("TACT Canonical Execution — SOR-77 getExecutionCorrectionContext", results);

}
