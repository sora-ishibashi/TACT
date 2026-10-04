// =========================
// TACT Canonical Execution — Permission + Attention Pipeline Regression (SOR-52 / SOR-178)
// =========================
//
// 対象: core/tact-execution/permission/observe.tsのobserveExecutionPermission()。
// evaluate→persist decision→(approval_required: derive Attention
// candidate→persist Attention / denied・unknown: SecurityFinding導出→
// 永続化→Attention ensure/link)という1本のpipeline全体を、DI seamで実
// Supabase接続なしに検証する(evaluatePermission()自体はpure、
// persistPermissionDecision()/persistExecutionAttention()/
// observeRunsPermissionSecurityFinding()はfake実装を注入する)。
//
// SOR-178 cutover: denied/unknownはもうpersistExecutionAttention()を
// 呼ばない(attentionCallsは常に0のまま)。その代わりに
// observeRunsPermissionSecurityFinding()(新しいdeps)が呼ばれる
// ——findingCallsで追跡する。approval_requiredのみ既存のpersistExecutionAttention()
// 経路が変わらず使われる。

import { observeExecutionPermission, type ObserveExecutionPermissionDeps } from "@tact/runs-core/tact-execution/permission/observe";
import { deriveExecutionAttentionCandidate } from "@tact/runs-core/tact-execution/permission/attention";
import type { PersistPermissionDecisionOutcome } from "@tact/runs-core/tact-execution/permission/store";
import type { PersistExecutionAttentionOutcome } from "@tact/runs-core/tact-execution/permission/attentionStore";
import type { PermissionDecision } from "@tact/runs-core/tact-execution/permission/types";
import type { CanonicalExecution } from "@tact/runs-core/tact-execution/types";
import type { ObserveSecurityFindingOutcome } from "@tact/runs-core/tact-execution/securityFinding/observe";
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
    outcomeStatus: "unknown",
    outcomeKind: null,
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
  findingCalls: Array<{ execution: CanonicalExecution; decision: PermissionDecision; permissionDecisionId: string }>;
  failures: Array<{ stage: string; error: unknown }>;
} {

  const attentionCalls: Array<{ candidate: unknown; decisionId: string }> = [];
  const findingCalls: Array<{ execution: CanonicalExecution; decision: PermissionDecision; permissionDecisionId: string }> = [];
  const failures: Array<{ stage: string; error: unknown }> = [];

  const deps: ObserveExecutionPermissionDeps = {
    evaluatePermission: async (execution) => makeDecision("allowed", { executionId: execution.id }),
    persistPermissionDecision: async (decision) => persistedDecisionOutcome(decision),
    deriveExecutionAttentionCandidate,
    persistExecutionAttention: async (candidate, decisionId) => {
      attentionCalls.push({ candidate, decisionId });
      return { status: "persisted", attention: { id: "attention-1" } as never } as PersistExecutionAttentionOutcome;
    },
    observeRunsPermissionSecurityFinding: async (execution, decision, permissionDecisionId) => {
      findingCalls.push({ execution, decision, permissionDecisionId });
      return { status: "linked", findingId: "finding-1", attentionId: "attention-1", episodeCreated: true } as ObserveSecurityFindingOutcome;
    },
    configuredUnknownAlertRules: [],
    onFailure: (stage, error) => { failures.push({ stage, error }); },
    ...overrides,
  };

  return { deps, attentionCalls, findingCalls, failures };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Required test 1: MATCH(allowed) -> Attentionなし・SecurityFindingなし ----
  {
    const { deps, attentionCalls, findingCalls, failures } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("allowed", { executionId: execution.id }),
    });

    const outcome = await observeExecutionPermission(makeNotionExecution(), deps);

    results.push(check(
      "[Required test 1] MATCH(allowed)はPermission Decisionを永続化するがAttention/SecurityFindingは一切persistしない",
      outcome.status === "persisted" && attentionCalls.length === 0 && findingCalls.length === 0 && failures.length === 0
    ));
  }

  // ---- SOR-178 cutover: MISMATCH(denied) -> SecurityFinding経路へ(persistExecutionAttentionは呼ばれない) ----
  {
    const { deps, attentionCalls, findingCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
    });

    await observeExecutionPermission(makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" }), deps);

    results.push(check(
      "[SOR-178 cutover] MISMATCH(denied)はobserveRunsPermissionSecurityFinding()経由になり、persistExecutionAttention()は一切呼ばれない",
      findingCalls.length === 1 &&
        findingCalls[0].decision.status === "denied" &&
        findingCalls[0].permissionDecisionId === "decision-1" &&
        attentionCalls.length === 0
    ));
  }

  // ---- Required test 3/8: APPROVAL_REQUIRED -> approval_required Attention(既存経路、変更なし) ----
  {
    const { deps, attentionCalls, findingCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("approval_required", { executionId: execution.id }),
    });

    await observeExecutionPermission(makeNotionExecution({ actionCategory: "update", operation: "notion_update_page" }), deps);

    results.push(check(
      "[Required test 3/8] APPROVAL_REQUIREDはreason='approval_required'のAttentionをpersistする(既存経路、SecurityFindingは呼ばれない)",
      attentionCalls.length === 1 &&
        (attentionCalls[0].candidate as { reason: string }).reason === "approval_required" &&
        findingCalls.length === 0
    ));
  }

  // ---- SOR-178 cutover: UNKNOWN -> SecurityFinding経路を試みる(eligibility自体はderive.ts側の責務、observe.tsは常に呼ぶ) ----
  {
    const { deps, attentionCalls, findingCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("unknown", { executionId: execution.id, policyId: null }),
    });

    await observeExecutionPermission(makeNotionExecution({ actionCategory: "share", operation: "notion_share" }), deps);

    results.push(check(
      "[SOR-178 cutover] UNKNOWNはobserveRunsPermissionSecurityFinding()を呼ぶ(eligibility自体の判定はderive.ts側の責務)",
      findingCalls.length === 1 && findingCalls[0].decision.status === "unknown" && attentionCalls.length === 0
    ));
  }

  // ---- workId=nullでもSecurityFinding観測を試みる ----
  {
    const { deps, findingCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
    });

    await observeExecutionPermission(makeNotionExecution({ workId: null, actionCategory: "delete", operation: "notion_delete_page" }), deps);

    results.push(check(
      "[SOR-178] workId=nullのExecutionでもSecurityFinding観測が試みられる(Work correlationを待たない)",
      findingCalls.length === 1
    ));
  }

  // ---- duplicate evaluation -> observeRunsPermissionSecurityFinding()を毎回呼ぶ(その冪等性に委ねる) ----
  {
    const { deps, findingCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
    });

    const execution = makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" });
    await observeExecutionPermission(execution, deps);
    await observeExecutionPermission(execution, deps);

    results.push(check(
      "[Required test 6/7 相当] 同一Executionの再評価はobserveRunsPermissionSecurityFinding()を毎回呼ぶ" +
        "(その冪等性—recordSecurityFinding/ensure_security_finding_attention_linkの既存契約—により2件目以降も安全)",
      findingCalls.length === 2
    ));
  }

  // ---- failed Execution + mismatch でもSecurityFinding観測が試みられる(API failureをpermission incidentと誤分類しない) ----
  {
    const { deps, findingCalls } = buildDeps({
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
      "[Required test 9 相当] Execution自体がFAILEDでも、Permission DecisionがMISMATCHならSecurityFinding観測が試みられる",
      findingCalls.length === 1
    ));
  }

  // ---- Required test 10 / Section15: Attention persistence失敗はPermission Decisionの結果を壊さない(approval_required経路) ----
  {
    const { deps, failures } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("approval_required", { executionId: execution.id }),
      persistExecutionAttention: async () => { throw new Error("attention table unavailable"); },
    });

    const outcome = await observeExecutionPermission(makeNotionExecution({ actionCategory: "update", operation: "notion_update_page" }), deps);

    results.push(check(
      "[Required test 10 / Section15] Attention persistenceの失敗はPersistPermissionDecisionOutcomeを変えず、例外も外へ伝播しないが、" +
        "silent failureにはせずonFailure(stage='attention_persistence')として報告される",
      outcome.status === "persisted" &&
        failures.length === 1 &&
        failures[0].stage === "attention_persistence"
    ));
  }

  // ---- SOR-178: SecurityFinding持続化失敗はPermission Decisionの結果を壊さない ----
  {
    const { deps, failures } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
      observeRunsPermissionSecurityFinding: async () => ({ status: "finding_persistence_failed", reason: "unavailable" }),
    });

    const outcome = await observeExecutionPermission(makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" }), deps);

    results.push(check(
      "[SOR-178 Failure isolation] SecurityFinding永続化の失敗はPersistPermissionDecisionOutcomeを変えず、" +
        "onFailure(stage='security_finding_persistence')として報告される",
      outcome.status === "persisted" && failures.length === 1 && failures[0].stage === "security_finding_persistence"
    ));
  }

  // ---- SOR-178: Attention ensure/link失敗はFindingの永続化結果(呼び出し元が見る限り)を壊さない ----
  {
    const { deps, failures } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
      observeRunsPermissionSecurityFinding: async () => ({ status: "attention_link_failed", findingId: "finding-1", reason: "error" }),
    });

    const outcome = await observeExecutionPermission(makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" }), deps);

    results.push(check(
      "[SOR-178 Failure isolation] Attention ensure/link失敗はPersistPermissionDecisionOutcomeを変えず、" +
        "onFailure(stage='security_finding_attention_link')として報告される(Findingは既に確定済み、取り消さない)",
      outcome.status === "persisted" && failures.length === 1 && failures[0].stage === "security_finding_attention_link"
    ));
  }

  // ---- not_eligible(derive.tsがnullを返した)場合はonFailureを呼ばない ----
  {
    const { deps, failures } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("unknown", { executionId: execution.id, policyId: null }),
      observeRunsPermissionSecurityFinding: async () => ({ status: "not_eligible" }),
    });

    const outcome = await observeExecutionPermission(makeNotionExecution({ actionCategory: "read", operation: "notion_read" }), deps);

    results.push(check(
      "[SOR-178] not_eligible(低impact unknown等)はonFailureを呼ばず、正常なoutcomeをそのまま返す",
      outcome.status === "persisted" && failures.length === 0
    ));
  }

  // ---- decisionが実際に永続化されなかった場合(invalid/unavailable等)はAttention/SecurityFindingのどちらも試みない ----
  {
    const { deps, attentionCalls, findingCalls } = buildDeps({
      evaluatePermission: async (execution) => makeDecision("denied", { executionId: execution.id }),
      persistPermissionDecision: async () => ({ status: "unavailable" }),
    });

    await observeExecutionPermission(makeNotionExecution({ actionCategory: "delete", operation: "notion_delete_page" }), deps);

    results.push(check(
      "[Contract] Permission Decision自体が永続化されなかった場合(status=unavailable等)、Attention/SecurityFindingのいずれも試みない" +
        "(存在しないdecisionIdを参照させない)",
      attentionCalls.length === 0 && findingCalls.length === 0
    ));
  }

  // ---- SOR-47 Phase2(Evaluator Cutover、絶対条件): Registry読み込み失敗はobserveExecutionPermission内で握り潰されず、
  // 呼び出し元へ伝播する。persistPermissionDecision/persistExecutionAttention/observeRunsPermissionSecurityFindingの
  // いずれも一切呼ばれない(「読めなかった」ことを「matchしなかった」(正当なunknown decision)へ静かに変換しない、Human Owner指示) ----
  {
    let persistDecisionCalled = false;
    let persistAttentionCalled = false;
    let observeFindingCalled = false;

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
      observeRunsPermissionSecurityFinding: async () => {
        observeFindingCalled = true;
        return { status: "not_eligible" };
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
        "呼び出し元(各adapterの既存Capture Failure Policy)へそのまま伝播する。persistPermissionDecision/persistExecutionAttention/" +
        "observeRunsPermissionSecurityFindingのいずれも一切呼ばれない(誤ったPermission Decision provenance/misleading Attention/Findingを作らない)",
      threw && !persistDecisionCalled && !persistAttentionCalled && !observeFindingCalled
    ));
  }

  return summarize("TACT Canonical Execution — Permission + Attention Pipeline", results);

}
