// =========================
// TACT Canonical Execution — Permission Evaluator Regression (SOR-51)
// =========================
//
// 対象: core/tact-execution/permission/evaluate.tsのevaluatePermission()/
// validatePermissionDecision()(いずれも純粋関数、DBアクセスなし)。

import { evaluatePermission, validatePermissionDecision } from "../../../../core/tact-execution/permission/evaluate";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
    schemaVersion: 1,
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
    observationMode: null,
    preExecutionVisible: false,
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

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case1: Allowed(Agent + slack channel READ) ----
  {
    const execution = makeExecution({ actorKind: "ai_agent", actorId: "agent-1", resourceType: "slack_channel", actionCategory: "read" });
    const decision = evaluatePermission(execution);

    results.push(
      check(
        "[Case1/pending->allowed] ai_agent + slack channel readはallowedを返す",
        decision.status === "allowed" && decision.policyId === "ai-agent-slack-channel-read-allowed"
      )
    );
  }

  // ---- Case2: Denied(Agent + slack message SEND) ----
  {
    const execution = makeExecution({ actorKind: "ai_agent", actorId: "agent-1", resourceType: "slack_message", actionCategory: "send" });
    const decision = evaluatePermission(execution);

    results.push(
      check(
        "[Case2/pending->denied] ai_agent + slack message sendはdeniedを返す",
        decision.status === "denied" && decision.policyId === "ai-agent-slack-message-send-denied"
      )
    );
  }

  // ---- SOR-51 M-0: Notion UPDATE_PAGE -> approval_required (independent
  // status, not flattened into denied) ----
  {
    const execution = makeExecution({
      actorKind: "ai_agent",
      actorId: "principal-1",
      agentId: "agent-1",
      provider: "mcp",
      targetProvider: "notion",
      resourceType: "notion_page",
      actionCategory: "update",
      operation: "notion_update_page",
    });
    const decision = evaluatePermission(execution);

    results.push(
      check(
        "[SOR-51 M-0 / Required test 3] Notion UPDATE_PAGE returns approval_required (not denied, not allowed)",
        decision.status === "approval_required" &&
          decision.policyId === "notion-ai-agent-update-page-approval-required"
      )
    );
  }

  // ---- Test: no policy -> unknown(pending->unknown) ----
  {
    const execution = makeExecution({ actorKind: "service", actorId: "svc-1", provider: "notion", resourceType: "page", actionCategory: "update" });
    const decision = evaluatePermission(execution);

    results.push(
      check(
        "[pending->unknown] 未登録の組み合わせはunknownを返し、policyIdはnull(断定しない)",
        decision.status === "unknown" && decision.policyId === null && decision.reasonCode === "no_matching_policy"
      )
    );
  }

  // ---- wrong actor/provider/action/resource -> unknown ----
  {
    const wrongActor = evaluatePermission(makeExecution({ actorKind: "connector" }));
    const wrongProvider = evaluatePermission(makeExecution({ provider: "gmail" }));
    const wrongAction = evaluatePermission(makeExecution({ actionCategory: "delete" }));
    const wrongResource = evaluatePermission(makeExecution({ resourceType: "slack_channel" }));

    results.push(
      check(
        "[wrong actor/provider/action/resource] いずれもunknownへ倒れる(allowedへfallbackしない)",
        wrongActor.status === "unknown" &&
          wrongProvider.status === "unknown" &&
          wrongAction.status === "unknown" &&
          wrongResource.status === "unknown"
      )
    );
  }

  // ---- executionId/evaluatorVersion/evaluatedAtが常に埋まる ----
  {
    const decision = evaluatePermission(makeExecution({ id: "exec-42" }));

    results.push(
      check(
        "[Decision shape] executionId/evaluatorVersion/evaluatedAtが常に設定される",
        decision.executionId === "exec-42" &&
          decision.evaluatorVersion.length > 0 &&
          decision.evaluatedAt.length > 0
      )
    );
  }

  // ---- validatePermissionDecision: 正常 ----
  {
    const decision = evaluatePermission(makeExecution());
    const result = validatePermissionDecision(decision);

    results.push(check("[Validation] evaluatePermission()の出力はそのまま有効", result.ok === true));
  }

  // ---- validatePermissionDecision: 疑わしいmetadata key ----
  {
    const decision = evaluatePermission(makeExecution());
    const result = validatePermissionDecision({ ...decision, metadata: { access_token: "leak" } });

    results.push(
      check(
        "[Validation] metadataに疑わしいkeyが含まれる場合は拒否する",
        result.ok === false && result.errors.some((e) => e.includes("metadata"))
      )
    );
  }

  // ---- validatePermissionDecision: 巨大なmetadata ----
  {
    const decision = evaluatePermission(makeExecution());
    const result = validatePermissionDecision({ ...decision, metadata: { note: "x".repeat(5000) } });

    results.push(
      check(
        "[Validation] 巨大なmetadataは拒否する(巨大なJSON dump禁止)",
        result.ok === false
      )
    );
  }

  return summarize("TACT Canonical Execution — Permission Evaluator", results);

}
