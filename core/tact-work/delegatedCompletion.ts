import type { ContextResolutionResult } from "../tact-context-resolution";
import {
  getWork,
  markWorkResultDelivered,
  updateWorkEvidenceRefs,
  updateWorkStatus,
} from "./store";
import { reconcileWorkCompletionStatus } from "./completion";
import { emitAuditSafely } from "./audit";
import { buildWorkEvidenceReferences } from "./delegatedIntent";
import type { ResolvedWorkIntent } from "./types";

export type DelegatedWorkCompletionState = "awaiting_delivery" | "blocked" | "completed";

export interface DelegatedWorkCompletionEvaluation {
  state: DelegatedWorkCompletionState;
  unmetConditions: string[];
}
function sourceIsComplete(
  result: ContextResolutionResult,
  source: "notion" | "gmail"
): boolean {
  const status = result.sources[source];
  // A deliberate search that returns nothing still satisfies a request to
  // check. It must be reported as "not found", never as proof of absence.
  return status === "available" || status === "no_match";
}

export function evaluateDelegatedWorkCompletion(
  intent: ResolvedWorkIntent,
  contextResolution: ContextResolutionResult,
  resultDelivered: boolean
): DelegatedWorkCompletionEvaluation {
  const unmetConditions: string[] = [];

  if (intent.requiredCapabilities.includes("organizational_context.read") && !sourceIsComplete(contextResolution, "notion")) {
    unmetConditions.push("organizational_context_checked");
  }
  if (intent.requiredCapabilities.includes("communication.read") && !sourceIsComplete(contextResolution, "gmail")) {
    unmetConditions.push("communication_checked");
  }
  // An act Work is intentionally never completed by the read-side Context-P2
  // finalizer. The protected-write resume path is the only path allowed to
  // satisfy communication_sent after a valid Approval.
  if (intent.requiredCapabilities.includes("communication.write")) {
    unmetConditions.push("communication_sent");
  }
  if (!resultDelivered) unmetConditions.push("result_delivered");

  if (unmetConditions.some((condition) => condition !== "result_delivered")) {
    return { state: "blocked", unmetConditions };
  }
  if (!resultDelivered) {
    return { state: "awaiting_delivery", unmetConditions };
  }
  return { state: "completed", unmetConditions };
}

/**
 * Finalizes a delegated inspect Work only after the response has been saved in
 * the canonical Conversation. The existing reconciliation routine still owns
 * valid task/run terminal-state transitions.
 */
export async function finalizeDelegatedWorkAfterDelivery(params: {
  workId: string;
  userId: string;
  accessToken: string;
  intent: ResolvedWorkIntent;
  contextResolution: ContextResolutionResult;
}): Promise<DelegatedWorkCompletionEvaluation> {
  const evidenceRefs = buildWorkEvidenceReferences(params.contextResolution);
  await updateWorkEvidenceRefs(params.workId, params.userId, params.accessToken, evidenceRefs);
  await markWorkResultDelivered(params.workId, params.userId, params.accessToken);

  const evaluation = evaluateDelegatedWorkCompletion(
    params.intent,
    params.contextResolution,
    true
  );

  await emitAuditSafely(
    {
      workId: params.workId,
      category: "work",
      eventType: "work.completion.evaluated",
      actor: { kind: "system", id: "work-completion" },
      details: {
        requestType: params.intent.requestType,
        completionConditionCount: params.intent.completionConditions.length,
        evidenceReferenceCount: evidenceRefs.length,
        resultState: evaluation.state,
      },
    },
    params.userId,
    params.accessToken
  );

  if (evaluation.state === "blocked") {
    await updateWorkStatus(params.workId, params.userId, params.accessToken, "waiting_for_input");
    await emitAuditSafely(
      {
        workId: params.workId,
        category: "work",
        eventType: "work.blocked",
        actor: { kind: "system", id: "work-completion" },
        details: { unmetConditionCount: evaluation.unmetConditions.length },
      },
      params.userId,
      params.accessToken
    );
    return evaluation;
  }

  await reconcileWorkCompletionStatus(params.workId, params.userId, params.accessToken);
  await emitAuditSafely(
    {
      workId: params.workId,
      category: "work",
      eventType: "work.completed",
      actor: { kind: "system", id: "work-completion" },
      details: {
        requestType: params.intent.requestType,
        evidenceReferenceCount: evidenceRefs.length,
      },
    },
    params.userId,
    params.accessToken
  );
  return evaluation;
}

// =========================
// finalizeSemanticWorkAfterProtectedWrite
// (Architecture audit finding F-02 fix: GMAIL-P1 Completion Ownership Audit)
// =========================
//
// Write-side counterpart to finalizeDelegatedWorkAfterDelivery() above.
// The protected-write resume path (core/tact-integration/execution.ts's
// executeApprovedIntegrationAction(), reached via core/tact-conversation's
// executePreparedTaskResume()) is a pre-existing, provider-neutral boundary
// that has no knowledge of Work.requestType/completionConditions/
// requiredCapabilities — it only ever calls the generic
// reconcileWorkCompletionStatus(), which (per the fix in ./completion.ts)
// now refuses to mark a durable semantic delegated Work "completed" until
// Work.resultDeliveredAt is set.
//
// This function is the one place that marks that same canonical delivery
// boundary for the write/"act" path, once the resume path has produced a
// *definitive* Run/Task outcome (success, failure, or an already-executed
// replay of a prior decision — never for an ambiguous/execution_error
// outcome, where nothing has actually been confirmed). It is intentionally
// symmetrical with finalizeDelegatedWorkAfterDelivery(): mark delivery,
// then defer the actual terminal-state decision entirely to the same
// shared reconcileWorkCompletionStatus() — no second completion evaluator,
// no per-provider-specific branch, no new Work status.
//
// Safe to call unconditionally for every resumed protected write: it is a
// no-op for a classic (non-semantic) Work (Work.requestType == null),
// which remains fully owned by the existing
// reconcileAfterTaskUpdate() -> reconcileWorkCompletionStatus() call inside
// core/tact-integration/execution.ts, unchanged.

export interface FinalizeSemanticWorkAfterProtectedWriteDeps {

  getWork: typeof getWork;

  markWorkResultDelivered: typeof markWorkResultDelivered;

  reconcileWorkCompletionStatus: typeof reconcileWorkCompletionStatus;

}

const defaultFinalizeSemanticWorkAfterProtectedWriteDeps: FinalizeSemanticWorkAfterProtectedWriteDeps = {
  getWork,
  markWorkResultDelivered,
  reconcileWorkCompletionStatus,
};

export async function finalizeSemanticWorkAfterProtectedWrite(
  workId: string,
  userId: string,
  accessToken: string,
  deps: FinalizeSemanticWorkAfterProtectedWriteDeps = defaultFinalizeSemanticWorkAfterProtectedWriteDeps
): Promise<void> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work || work.requestType == null) {
    // Classic (non-semantic) Work, or ownership could not be re-confirmed —
    // either way, this function has nothing to do. Completion for a classic
    // Work remains entirely owned by the existing generic reconciliation
    // already performed inside core/tact-integration/execution.ts.
    return;
  }

  await deps.markWorkResultDelivered(workId, userId, accessToken);
  await deps.reconcileWorkCompletionStatus(workId, userId, accessToken);

}
