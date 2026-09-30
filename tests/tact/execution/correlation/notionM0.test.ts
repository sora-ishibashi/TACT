// =========================
// TACT Canonical Execution — SOR-53 Notion M-0 Acceptance Scenario
// =========================
//
// SOR-53指示「W-001 M-0 acceptance scenario」: M-0専用test Work
// ("W-001"風の識別子)をfixtureとしてのみ使う(production codeには一切
// 現れない)。correlateExecution()(実際のproduction pipeline関数、
// core/tact-execution/correlation/correlate.ts)をDI経由の偽depsで
// end-to-endに検証する——evaluator/correlator自体は一切再実装しない。

import { correlateExecution, type CorrelateExecutionDeps } from "../../../../core/tact-execution/correlation/correlate";
import { toCanonicalCorrelationResult } from "../../../../core/tact-execution/correlation/canonicalResult";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import type { Work } from "../../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../../lib/check";

// M-0専用test Work識別子(fixtureのみ、production codeへは一切書かない)。
const W_001 = "W-001";

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
    actionCategory: "update",
    operation: "notion_update_page",
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
    observedAt: "2026-09-22T00:00:00.000Z",
    persistedAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: W_001,
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function throwingDeps(label: string): CorrelateExecutionDeps {
  return {
    findConversationLink: async () => { throw new Error(`${label}: findConversationLink should not be called`); },
    listWorksForConversation: async () => { throw new Error(`${label}: listWorksForConversation should not be called`); },
    listWorksForNotionResource: async () => { throw new Error(`${label}: listWorksForNotionResource should not be called`); },
    listRecentWorksForUser: async () => { throw new Error(`${label}: listRecentWorksForUser should not be called`); },
    getServiceRoleKey: () => { throw new Error(`${label}: getServiceRoleKey should not be called`); },
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // ---- DoD / Required test 1: explicit valid workId(W-001) -> CORRELATED, takes precedence over any evidence ----
  {
    // captureExecution()(SOR-50)はこの時点で既にtenant/state検証を
    // 終えてexecution.workIdを埋めている前提(resolveTargetWorkForCorrelation()、
    // Path A本体のvalidation)——correlateExecution()自身はこの値を
    // 信用して即決定するだけで、explicit stageの優先順位そのものが
    // 「Notion resourceのevidenceがあっても一切参照しない」ことを保証する。
    const execution = makeNotionExecution({ workId: W_001 });
    const decision = await correlateExecution(execution, throwingDeps("explicit precedence"));

    results.push(check(
      "[DoD / Required test 1] explicit valid workId=W-001 -> matched/explicit, and canonical CORRELATED, without touching any evidence resolver",
      decision.status === "matched" &&
        decision.workId === W_001 &&
        decision.method === "explicit" &&
        toCanonicalCorrelationResult(decision.status) === "CORRELATED"
    ));
  }

  // ---- Required test 8: 同じprincipalを持つ複数Workが存在するだけでは自動確定しない ----
  {
    const sameActorWorks = [
      makeWork({ id: "work-p1", createdByActorId: "principal-1" }),
      makeWork({ id: "work-p2", createdByActorId: "principal-1" }),
    ];

    const deps: CorrelateExecutionDeps = {
      findConversationLink: async () => null,
      listWorksForConversation: async () => [],
      listWorksForNotionResource: async () => [], // no strong Notion evidence
      listRecentWorksForUser: async () => sameActorWorks, // weak: only "same actor" signal
      getServiceRoleKey: () => "service-role-key",
    };

    // このExecutionのactorId("principal-1")が候補Workのcreated_byと
    // 一致するだけでは、temporal/AI-assistedはmatchedを返さない
    // (candidatesはactorIdを一切見ない設計、aiAssisted.ts参照)。
    const execution = makeNotionExecution({ resourceIdentifier: null }); // no strong Notion evidence either
    const decision = await correlateExecution(execution, deps);

    results.push(check(
      "[Required test 8] multiple Works sharing the same principal (createdByActorId) alone does not auto-match",
      decision.status !== "matched" && (decision.status === "ambiguous" || decision.status === "unresolved")
    ));
  }

  // ---- Required test 9: 同じagentだけでは自動確定しない ----
  {
    // agentId自体はWork側に対応するfieldを持たない(過剰なActor
    // Registryを作らない、SOR-51原則の延長)——correlator側のどの
    // stageもagentIdを候補の絞り込みに使わないことを、実際にExecutionの
    // agentIdを変えても結果が変わらないことで示す。
    const works = [makeWork({ id: "work-single" })];

    const deps: CorrelateExecutionDeps = {
      findConversationLink: async () => null,
      listWorksForConversation: async () => [],
      listWorksForNotionResource: async () => [],
      listRecentWorksForUser: async () => works,
      getServiceRoleKey: () => "service-role-key",
    };

    const executionA = makeNotionExecution({ resourceIdentifier: null, agentId: "agent-a" });
    const executionB = makeNotionExecution({ resourceIdentifier: null, agentId: "agent-b" });

    const decisionA = await correlateExecution(executionA, deps);
    const decisionB = await correlateExecution(executionB, deps);

    results.push(check(
      "[Required test 9] a single recent Work is never auto-matched from agentId alone, and changing agentId changes nothing (agentId is not a matching signal anywhere in the pipeline)",
      decisionA.status !== "matched" && decisionB.status !== "matched" && decisionA.status === decisionB.status
    ));
  }

  // ---- Required test 13: manual unassign後、弱いevidenceだけでは再assignしない ----
  {
    // manual unassignの結果(persistManualWorkCorrelationOverride())は
    // execution.correlationStatus="unresolved"・workId=nullへ落ち着く
    // (core/tact-execution/correlation/store.tsのreclassify結果
    // mapping参照)。ここではその後の状態を模したExecutionへ、weak
    // evidence(temporal candidatesのみ、複数候補どころか1件のみ)を
    // 与えて、再度matchedにならないことを確認する。
    const recentWorks = [makeWork({ id: "work-recent-after-unassign" })];

    const deps: CorrelateExecutionDeps = {
      findConversationLink: async () => null,
      listWorksForConversation: async () => [],
      listWorksForNotionResource: async () => [],
      listRecentWorksForUser: async () => recentWorks,
      getServiceRoleKey: () => "service-role-key",
    };

    const postUnassignExecution = makeNotionExecution({
      workId: null,
      correlationStatus: "unresolved",
      resourceIdentifier: null,
    });

    const decision = await correlateExecution(postUnassignExecution, deps);

    results.push(check(
      "[Required test 13] after a manual unassign (workId=null, correlationStatus=unresolved), a lone weak (temporal) candidate still does not get auto-reassigned",
      decision.status !== "matched"
    ));
  }

  // ---- Required test 14: workId=nullのExecutionはcorrelation pipeline自体で失われない(常に何らかのdecisionを返す) ----
  {
    const deps: CorrelateExecutionDeps = {
      findConversationLink: async () => null,
      listWorksForConversation: async () => [],
      listWorksForNotionResource: async () => [],
      listRecentWorksForUser: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };

    const execution = makeNotionExecution({ workId: null, resourceIdentifier: null });
    const decision = await correlateExecution(execution, deps);

    results.push(check(
      "[Required test 14] a workId=null Execution with no evidence anywhere still yields a well-formed decision (unresolved, never thrown away)",
      decision.executionId === execution.id &&
        decision.status === "unresolved" &&
        decision.workId === null &&
        toCanonicalCorrelationResult(decision.status) === "UNASSIGNED"
    ));
  }

  return summarize("TACT Canonical Execution — SOR-53 Notion M-0 Acceptance Scenario (W-001 fixture)", results);
}
