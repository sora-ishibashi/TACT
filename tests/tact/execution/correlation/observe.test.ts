// =========================
// TACT Canonical Execution — Work Correlation Observation Regression
// (SOR-52)
// =========================
//
// 対象: core/tact-execution/correlation/observe.tsのobserveExecutionWorkCorrelation()。
// Test7(execution already correlated)・Test8(duplicate correlation
// attempt)を検証する——既にmatched(work_id確定済み)のExecutionは、
// Correlator pipeline自体を呼び出さない。

import { observeExecutionWorkCorrelation } from "../../../../core/tact-execution/correlation/observe";
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
    observedAt: "2026-09-20T12:00:00.000Z",
    persistedAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test7/Test8: 既にmatched(work_id確定済み)のExecutionは再相関しない ----
  {
    const callCounts = { correlate: 0 };

    const execution = makeExecution({ workId: "work-1", correlationStatus: "matched" });

    const outcome = await observeExecutionWorkCorrelation(execution, {
      correlate: {
        findConversationLink: async () => {
          callCounts.correlate += 1;
          return null;
        },
        listWorksForConversation: async () => [],
        listWorksForNotionResource: async () => [],
        listRecentWorksForUser: async () => [],
        getServiceRoleKey: () => null,
      },
    });

    results.push(
      check(
        "[Test7/Test8] 既にmatched(work_id確定済み)のExecutionはstatus=already_matchedを返し、Correlator pipeline自体を呼び出さない(重複試行を安全に無視する)",
        outcome.status === "already_matched" && callCounts.correlate === 0
      )
    );
  }

  // ---- pending/ambiguous/unresolvedは通常どおりpipelineを実行する ----
  {
    const execution = makeExecution({
      workId: null,
      correlationStatus: "unresolved",
      sourceMetadata: { teamId: "T1", channel: "C1", threadTs: "100.001" },
    });

    const callCounts = { correlate: 0 };

    const outcome = await observeExecutionWorkCorrelation(execution, {
      correlate: {
        findConversationLink: async () => {
          callCounts.correlate += 1;
          return null;
        },
        listWorksForConversation: async () => [],
        listWorksForNotionResource: async () => [],
        listRecentWorksForUser: async () => [],
        getServiceRoleKey: () => "service-role-key",
      },
      persist: {
        getClient: () => null,
      },
    });

    results.push(
      check(
        "[Re-evaluation] unresolvedのExecutionは自動的な再試行の対象になる(将来Workが作られた後の再相関を塞がない)",
        callCounts.correlate > 0 && outcome.status === "unavailable"
      )
    );
  }

  return summarize("TACT Canonical Execution — Work Correlation Observation", results);

}
