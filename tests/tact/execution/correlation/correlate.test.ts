// =========================
// TACT Canonical Execution — Correlator Orchestration Regression (SOR-52)
// =========================
//
// 対象: core/tact-execution/correlation/correlate.tsのcorrelateExecution()。
// 各stageの内部ロジックはstages.test.tsが担う——ここではpipelineの
// 順序制御(早期return・fallback)とTest3(no candidate -> unresolved)・
// Test18(permission decisionとcorrelationが独立していること)を検証する。

import { correlateExecution, type CorrelateExecutionDeps } from "../../../../core/tact-execution/correlation/correlate";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import type { Work } from "../../../../core/tact-work/types";
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
    sourceMetadata: { teamId: "T1", channel: "C1", threadTs: "100.001" },
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
    observedAt: "2026-09-20T12:00:00.000Z",
    persistedAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

function throwingDeps(label: string): CorrelateExecutionDeps {
  return {
    findConversationLink: async () => {
      throw new Error(`${label}: findConversationLink should not be called`);
    },
    listWorksForConversation: async () => {
      throw new Error(`${label}: listWorksForConversation should not be called`);
    },
    listWorksForNotionResource: async () => {
      throw new Error(`${label}: listWorksForNotionResource should not be called`);
    },
    listRecentWorksForUser: async () => {
      throw new Error(`${label}: listRecentWorksForUser should not be called`);
    },
    getServiceRoleKey: () => {
      throw new Error(`${label}: getServiceRoleKey should not be called`);
    },
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- explicit stageが決まればstructural/temporalへは一切進まない ----
  {
    const execution = makeExecution({ workId: "work-explicit-1" });
    const decision = await correlateExecution(execution, throwingDeps("explicit short-circuit"));

    results.push(
      check(
        "[Pipeline order] explicit stageで決まった場合、structural/temporal stageのdepsへは一切到達しない",
        decision.status === "matched" && decision.method === "explicit"
      )
    );
  }

  // ---- structural stageが決まればtemporal/AI-assistedへは進まない ----
  {
    let temporalCalled = false;

    const deps: CorrelateExecutionDeps = {
      findConversationLink: async () => "conv-1",
      listWorksForConversation: async () => [makeWork({ id: "work-structural-1" })],
      listWorksForNotionResource: async () => [],
      listRecentWorksForUser: async () => {
        temporalCalled = true;
        return [];
      },
      getServiceRoleKey: () => "service-role-key",
    };

    const decision = await correlateExecution(makeExecution(), deps);

    results.push(
      check(
        "[Pipeline order] structural stageで決まった場合、temporal/AI-assisted stageは呼ばれない",
        decision.status === "matched" && decision.method === "structural" && temporalCalled === false
      )
    );
  }

  // ---- Test3: どのstageも候補を出せない -> unresolved ----
  {
    const deps: CorrelateExecutionDeps = {
      findConversationLink: async () => null,
      listWorksForConversation: async () => [],
      listWorksForNotionResource: async () => [],
      listRecentWorksForUser: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };

    const decision = await correlateExecution(makeExecution(), deps);

    results.push(
      check(
        "[Test3] どのstageも候補を出せない場合、推測せずunresolvedを返す(workId=null)",
        decision.status === "unresolved" && decision.workId === null
      )
    );
  }

  // ---- Test18: permission decisionとcorrelationが独立していること ----
  {
    const deps: CorrelateExecutionDeps = {
      findConversationLink: async () => "conv-1",
      listWorksForConversation: async () => [makeWork({ id: "work-independent-1" })],
      listWorksForNotionResource: async () => [],
      listRecentWorksForUser: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };

    const deniedExecution = makeExecution({ permissionStatus: "denied", permissionReasonCode: "some_policy_denial" });
    const allowedExecution = makeExecution({ permissionStatus: "allowed", permissionReasonCode: "some_policy_allow" });

    const deniedDecision = await correlateExecution(deniedExecution, deps);
    const allowedDecision = await correlateExecution(allowedExecution, deps);

    results.push(
      check(
        "[Test18] permissionStatusがdenied/allowedのいずれでも、correlationの結果(method/workId/status)は同一——Executionの事実だけに基づいて判断する",
        deniedDecision.status === allowedDecision.status &&
          deniedDecision.workId === allowedDecision.workId &&
          deniedDecision.method === allowedDecision.method
      )
    );
  }

  return summarize("TACT Canonical Execution — Correlator Orchestration", results);

}
