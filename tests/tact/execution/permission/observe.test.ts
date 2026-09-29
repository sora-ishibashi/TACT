// =========================
// TACT Canonical Execution — Permission + Attention Pipeline Regression (SOR-52)
// =========================
//
// 対象: core/tact-execution/permission/observe.tsのobserveExecutionPermission()。
// evaluate→persist decision→derive Attention candidate→persist Attention
// という1本のpipeline全体を、DI seamで実Supabase接続なしに検証する
// (evaluatePermission()自体はpure、persistPermissionDecision()/
// persistExecutionAttention()はfake実装を注入する)。

import { observeExecutionPermission, type ObserveExecutionPermissionDeps } from "../../../../core/tact-execution/permission/observe";
import { deriveExecutionAttentionCandidate } from "../../../../core/tact-execution/permission/attention";
import type { PersistPermissionDecisionOutcome } from "../../../../core/tact-execution/permission/store";
import type { PersistExecutionAttentionOutcome } from "../../../../core/tact-execution/permission/attentionStore";
import type { PermissionDecision } from "../../../../core/tact-execution/permission/types";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeNotionExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
    schemaVersion: 1,
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: null,
    correlationStatus: "pending",
    connectionId: "connection-1",
    actorKind: "ai_agent",
    actorId: "principal-1",
    agentId: "agent-1",
    onBehalfOfActorKind: null,
    onBehalfOfActorId: null,
    provider: "mcp",
    sourceType: "sdk_callback",
    externalEventId: "invocation-1",
    adapterVersion: "notion-mcp-v1",
    sourceMetadata: null,
    rawPayloadRef: null,
    observationMode: null,
    preExecutionVisible: false,
    actionCategory: "read",
    operation: "notion_read",
    resourceType: "notion_page",
    resourceIdentifier: "page-1",
    targetProvider: "notion",
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

function makeDecision(status: PermissionDecision["status"], overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    executionId: "exec-1",
    status,
    reasonCode: "test_reason",
    policyId: status === "unknown" ? null : "test-policy",
    evaluatorVersion: "permission-evaluator-v1",
    evaluatedAt: "2026-09-20T00:00:01.000Z",
    ...overrides,
  };
}

function persistedDecisionOutcome(decision: PermissionDecision, decisionId = "decision-1"): PersistPermissionDecisionOutcome {
  return { status: "persisted", decision, decisionId };
}

function buildDeps(overrides: Partial<ObserveExecutionPermissionDeps> = {}): {
  deps: ObserveExecutionPermissionDeps;
  attentionCalls: Array<{ candidate: unknown; decisionId: string }>;
  failures: Array<{ stage: string; error: unknown }>;
} {

  const attentionCalls: Array<{ candidate: unknown; decisionId: string }> = [];
  const failures: Array<{ stage: string; error: unknown }> = [];

  const deps: ObserveExecutionPermissionDeps = {
    evaluatePermission: async (execution) => makeDecision("allowed", { executionId: execution.id }),
    persistPermissionDecision: async (decision) => persistedDecisionOutcome(decision),
    deriveExecutionAttentionCandidate,
    persistExecutionAttention: async (candidate, decisionId) => {
      attentionCalls.push({ candidate, decisionId });
      return { status: "persisted", attention: { id: "attention-1" } as never } as PersistExecutionAttentionOutcome;
    },
    onFailure: (stage, error) => { failures.push({ stage, error }); },
    ...overrides,
  };

  return { deps, attentionCalls, failures };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Required test 1: MATCH(allowed) -> Attentionなし ----
  {
    const { deps, attentionCalls, failures } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("allowed", { executionId: execution.id }),
    });

    const outcome = await observeExecutionPermission(makeNotionExecution(), deps);

    results.push(check(
      "[Required test 1] MATCH(allowed)はPermission Decisionを永続化するがAttentionは一切persistしない",
      outcome.status === "persisted" && attentionCalls.length === 0 && failures.length === 0
    ));
  }

  // ---- Required test 2/8: MISMATCH(denied) -> permission_mismatch Attention ----
  {
    const { deps, attentionCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
    });

    await observeExecutionPermission(makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" }), deps);

    results.push(check(
      "[Required test 2/8] MISMATCH(denied)はreason='permission_mismatch'のAttentionをpersistする",
      attentionCalls.length === 1 &&
        (attentionCalls[0].candidate as { reason: string }).reason === "permission_mismatch" &&
        attentionCalls[0].decisionId === "decision-1"
    ));
  }

  // ---- Required test 3/8: APPROVAL_REQUIRED -> approval_required Attention(mismatchと区別) ----
  {
    const { deps, attentionCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("approval_required", { executionId: execution.id }),
    });

    await observeExecutionPermission(makeNotionExecution({ actionCategory: "update", operation: "notion_update_page" }), deps);

    results.push(check(
      "[Required test 3/8] APPROVAL_REQUIREDはreason='approval_required'のAttentionをpersistする(permission_mismatchとは別)",
      attentionCalls.length === 1 && (attentionCalls[0].candidate as { reason: string }).reason === "approval_required"
    ));
  }

  // ---- Required test 4: UNKNOWN -> Attentionなし(M-0原則) ----
  {
    const { deps, attentionCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("unknown", { executionId: execution.id, policyId: null }),
    });

    await observeExecutionPermission(makeNotionExecution({ actionCategory: "share", operation: "notion_share" }), deps);

    results.push(check(
      "[Required test 4] UNKNOWNはM-0原則によりAttentionをpersistしない",
      attentionCalls.length === 0
    ));
  }

  // ---- Required test 5: workId=nullでもAttention生成 ----
  {
    const { deps, attentionCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
    });

    await observeExecutionPermission(makeNotionExecution({ workId: null, actionCategory: "delete", operation: "notion_delete_page" }), deps);

    results.push(check(
      "[Required test 5] workId=nullのExecutionでもAttentionが生成される(Work correlationを待たない)",
      attentionCalls.length === 1
    ));
  }

  // ---- Required test 6/7: duplicate evaluation -> Attention二重生成しない(persistExecutionAttention側の冪等性に委ねる) ----
  {
    const { deps, attentionCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
      persistExecutionAttention: async (candidate, decisionId) => {
        attentionCalls.push({ candidate, decisionId });
        // 2回目以降は「既に存在する」を模す(persistExecutionAttention()
        // 自体のunique_violationハンドリングが実際に担う契約を、この
        // pipeline層のtestでも踏襲する)。
        return attentionCalls.length === 1
          ? { status: "persisted", attention: { id: "attention-1" } as never }
          : { status: "already_exists", attention: { id: "attention-1" } as never };
      },
    });

    const execution = makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" });
    await observeExecutionPermission(execution, deps);
    await observeExecutionPermission(execution, deps);

    results.push(check(
      "[Required test 6/7] 同一Executionの再評価(duplicate capture retry等)はpersistExecutionAttention()を毎回呼ぶが、" +
        "その冪等性(execution_id unique)により2件目以降はalready_existsとして扱われ、呼び出し元(observeExecutionPermission)もエラー扱いしない",
      attentionCalls.length === 2
    ));
  }

  // ---- Required test 9: failed Execution + mismatch でもAttention生成される(API failureをpermission incidentと誤分類しない) ----
  {
    const { deps, attentionCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
    });

    const failedExecution = makeNotionExecution({
      status: "failed",
      errorCode: "notion_not_found",
      actionCategory: "delete",
      operation: "notion_delete_page",
    });

    await observeExecutionPermission(failedExecution, deps);

    results.push(check(
      "[Required test 9] Execution自体がFAILEDでも、Permission DecisionがMISMATCHならAttentionが生成される" +
        "(reasonはpermission由来のみ、API failure自体は別concern)",
      attentionCalls.length === 1 && (attentionCalls[0].candidate as { reason: string }).reason === "permission_mismatch"
    ));
  }

  // ---- Required test 10 / Section15: Attention persistence失敗はPermission Decisionの結果を壊さない ----
  {
    const { deps, failures } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
      persistExecutionAttention: async () => { throw new Error("attention table unavailable"); },
    });

    const outcome = await observeExecutionPermission(makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" }), deps);

    results.push(check(
      "[Required test 10 / Section15] Attention persistenceの失敗はPersistPermissionDecisionOutcomeを変えず、例外も外へ伝播しないが、" +
        "silent failureにはせずonFailure(stage='attention_persistence')として報告される",
      outcome.status === "persisted" &&
        failures.length === 1 &&
        failures[0].stage === "attention_persistence"
    ));
  }

  // ---- decisionが実際に永続化されなかった場合(invalid/unavailable等)はAttentionを試みない ----
  {
    const { deps, attentionCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
      persistPermissionDecision: async () => ({ status: "unavailable" }),
    });

    await observeExecutionPermission(makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" }), deps);

    results.push(check(
      "[Contract] Permission Decision自体が永続化されなかった場合(status=unavailable等)、Attention persistenceは試みない" +
        "(存在しないdecisionIdを参照させない)",
      attentionCalls.length === 0
    ));
  }

  // ---- SOR-47 Phase2(Evaluator Cutover、絶対条件): Registry読み込み失敗はobserveExecutionPermission内で握り潰されず、
  // 呼び出し元へ伝播する。persistPermissionDecision/persistExecutionAttentionのいずれも一切呼ばれない
  // (「読めなかった」ことを「matchしなかった」(正当なunknown decision)へ静かに変換しない、Human Owner指示) ----
  {
    let persistDecisionCalled = false;
    let persistAttentionCalled = false;

    const { deps } = buildDeps({
      evaluatePermission: async () => {
        throw new Error("registry unavailable (simulated infrastructure failure)");
      },
      persistPermissionDecision: async (decision) => {
        persistDecisionCalled = true;
        return persistedDecisionOutcome(decision);
      },
      persistExecutionAttention: async () => {
        persistAttentionCalled = true;
        return { status: "persisted", attention: { id: "attention-1" } as never };
      },
    });

    let threw = false;
    try {
      await observeExecutionPermission(makeNotionExecution(), deps);
    } catch {
      threw = true;
    }

    results.push(check(
      "[Phase2/cutover, 絶対条件] Registry読み込み失敗(evaluatePermissionの例外)はobserveExecutionPermission内でcatchされず、" +
        "呼び出し元(各adapterの既存Capture Failure Policy)へそのまま伝播する。persistPermissionDecision/persistExecutionAttentionの" +
        "いずれも一切呼ばれない(誤ったPermission Decision provenance/misleading Attentionを作らない)",
      threw && !persistDecisionCalled && !persistAttentionCalled
    ));
  }

  return summarize("TACT Canonical Execution — Permission + Attention Pipeline", results);

}
