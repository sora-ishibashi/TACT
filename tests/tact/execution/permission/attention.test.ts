// =========================
// TACT Canonical Execution — Attention Candidate Regression (SOR-51 / SOR-52)
// =========================
//
// 対象: core/tact-execution/permission/attention.tsのderiveExecutionAttentionCandidate()
// (純粋関数、DBアクセスなし)。SOR-52でreason vocabularyがproduct-facing
// (permission_mismatch/approval_required)へ変わり、unknownはM-0で
// Attention対象外になった。

import { deriveExecutionAttentionCandidate } from "../../../../core/tact-execution/permission/attention";
import type { PermissionDecision } from "../../../../core/tact-execution/permission/types";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: null,
    correlationStatus: "pending",
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
    resourceType: "slack_message",
    resourceIdentifier: null,
    targetProvider: "slack",
    status: "succeeded",
    errorCode: null,
    errorMessage: null,
    permissionStatus: "pending",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    providerOccurredAt: null,
    observedAt: "2026-09-20T00:00:00.000Z",
    persistedAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeDecision(overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    executionId: "exec-1",
    status: "allowed",
    reasonCode: "human_slack_mention_allowed",
    policyId: "human-slack-mention-allowed",
    evaluatorVersion: "permission-evaluator-v1",
    evaluatedAt: "2026-09-20T00:00:01.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Required test 1: MATCH(allowed) -> Attentionなし ----
  {
    const candidate = deriveExecutionAttentionCandidate(makeExecution(), makeDecision({ status: "allowed" }));

    results.push(check("[Required test 1] MATCH(allowed)はAttention Candidateを生成しない(null)", candidate === null));
  }

  // ---- Required test 2 / 8: MISMATCH(denied) -> reason='permission_mismatch' ----
  {
    const candidate = deriveExecutionAttentionCandidate(
      makeExecution(),
      makeDecision({ status: "denied", reasonCode: "ai_agent_slack_message_send_denied", policyId: "ai-agent-slack-message-send-denied" })
    );

    results.push(
      check(
        "[Required test 2] MISMATCH(denied)はreason='permission_mismatch'のAttention Candidateを生成する",
        candidate !== null &&
          candidate.reason === "permission_mismatch" &&
          candidate.reasonCode === "ai_agent_slack_message_send_denied"
      )
    );
  }

  // ---- Required test 3 / 8: APPROVAL_REQUIRED -> reason='approval_required', distinct from permission_mismatch ----
  {
    const candidate = deriveExecutionAttentionCandidate(
      makeExecution({ actorKind: "ai_agent", agentId: "agent-1", provider: "mcp", targetProvider: "notion" }),
      makeDecision({
        status: "approval_required",
        reasonCode: "notion_m0_update_page_approval_required",
        policyId: "notion-ai-agent-update-page-approval-required",
      })
    );

    results.push(
      check(
        "[Required test 3 / 8] APPROVAL_REQUIRED produces reason='approval_required' (never 'permission_mismatch')",
        candidate !== null &&
          candidate.reason === "approval_required" &&
          candidate.reasonCode === "notion_m0_update_page_approval_required"
      )
    );
  }

  // ---- Required test 4: UNKNOWN -> Attentionなし(M-0原則) ----
  {
    const candidate = deriveExecutionAttentionCandidate(
      makeExecution(),
      makeDecision({ status: "unknown", policyId: null, reasonCode: "no_matching_policy" })
    );

    results.push(
      check(
        "[Required test 4] UNKNOWNはM-0原則によりAttention Candidateを生成しない(null、危険側に勝手に倒さない)",
        candidate === null
      )
    );
  }

  // ---- 必要なfieldが揃っている(executionId/userId/provider/operation/occurredAt) ----
  {
    const execution = makeExecution({ id: "exec-99", userId: "user-99", provider: "gmail", operation: "search_messages" });
    const candidate = deriveExecutionAttentionCandidate(execution, makeDecision({ executionId: "exec-99", status: "denied" }));

    results.push(
      check(
        "[Shape] executionId/userId/provider/operation/occurredAtが失われず伝播する",
        candidate !== null &&
          candidate.executionId === "exec-99" &&
          candidate.userId === "user-99" &&
          candidate.provider === "gmail" &&
          candidate.operation === "search_messages" &&
          candidate.occurredAt === "2026-09-20T00:00:01.000Z"
      )
    );
  }

  return summarize("TACT Canonical Execution — Attention Candidate", results);

}
