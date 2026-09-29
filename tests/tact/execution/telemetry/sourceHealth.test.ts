// =========================
// TACT Canonical Execution — Source Health Aggregation (SOR-46)
// =========================

import { computeSourceHealthSummaries } from "../../../../core/tact-execution/telemetry/sourceHealth";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function execution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
    schemaVersion: 1,
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: null,
    correlationStatus: "pending",
    connectionId: "connection-1",
    actorKind: "human",
    actorId: null,
    agentId: null,
    onBehalfOfActorKind: null,
    onBehalfOfActorId: null,
    provider: "mcp",
    sourceType: "sdk_callback",
    externalEventId: "evt-1",
    adapterVersion: "notion-mcp-v1",
    sourceMetadata: null,
    rawPayloadRef: null,
    observationMode: null,
    preExecutionVisible: false,
    actionCategory: "read",
    operation: "notion_read",
    resourceType: null,
    resourceIdentifier: null,
    targetProvider: "notion",
    status: "succeeded",
    errorCode: null,
    errorMessage: null,
    permissionStatus: "allowed",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    providerOccurredAt: null,
    observedAt: "2026-09-25T00:00:00.000Z",
    persistedAt: "2026-09-25T00:00:00.500Z",
    updatedAt: "2026-09-25T00:00:00.500Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  {
    const summaries = computeSourceHealthSummaries([]);
    results.push(check("[empty] no executions produce no summaries", summaries.length === 0));
  }

  {
    // 同じ(provider, connectionId, adapterVersion)は1つのsourceへ集約される。
    const summaries = computeSourceHealthSummaries([
      execution({ id: "e1", observedAt: "2026-09-25T00:00:00.000Z" }),
      execution({ id: "e2", observedAt: "2026-09-25T00:05:00.000Z" }),
    ]);
    results.push(check(
      "[grouping] same (provider, connectionId, adapterVersion) collapses into one summary with the right observedCount",
      summaries.length === 1 && summaries[0].observedCount === 2 && summaries[0].lastObservedAt === "2026-09-25T00:05:00.000Z"
    ));
  }

  {
    // 異なるconnectionIdは別sourceとして扱う(provider-neutral grouping key)。
    const summaries = computeSourceHealthSummaries([
      execution({ id: "e1", connectionId: "connection-a" }),
      execution({ id: "e2", connectionId: "connection-b" }),
    ]);
    results.push(check(
      "[grouping] different connectionId produces distinct sources",
      summaries.length === 2
    ));
  }

  {
    // lastSuccessAt/lastFailureAtはそれぞれのstatusでのみ更新される。
    const summaries = computeSourceHealthSummaries([
      execution({ id: "e1", status: "succeeded", observedAt: "2026-09-25T00:00:00.000Z" }),
      execution({
        id: "e2", status: "failed", observedAt: "2026-09-25T00:05:00.000Z",
        errorCode: "notion_rate_limited", errorMessage: "Notion MCP tool execution failed",
      }),
    ]);
    results.push(check(
      "[failure] the most recent failed execution's sanitized error is surfaced as lastFailure",
      summaries.length === 1 &&
        summaries[0].lastSuccessAt === "2026-09-25T00:00:00.000Z" &&
        summaries[0].lastFailureAt === "2026-09-25T00:05:00.000Z" &&
        summaries[0].lastFailure?.errorCode === "notion_rate_limited" &&
        summaries[0].lastFailure?.errorMessage === "Notion MCP tool execution failed"
    ));
  }

  {
    // 入力順(新しい順/古い順)に依存しない(observedAt比較で決める)。
    const newestFirst = computeSourceHealthSummaries([
      execution({ id: "e2", observedAt: "2026-09-25T00:05:00.000Z" }),
      execution({ id: "e1", observedAt: "2026-09-25T00:00:00.000Z" }),
    ]);
    results.push(check(
      "[order-independence] lastObservedAt is correct regardless of input array order",
      newestFirst[0].lastObservedAt === "2026-09-25T00:05:00.000Z"
    ));
  }

  {
    // 一度も失敗していないsourceはlastFailure=null(推測で埋めない)。
    const summaries = computeSourceHealthSummaries([execution({ status: "succeeded" })]);
    results.push(check(
      "[no-fabrication] a source with no failures has lastFailureAt/lastFailure = null",
      summaries[0].lastFailureAt === null && summaries[0].lastFailure === null
    ));
  }

  return summarize("TACT Canonical Execution — Source Health Aggregation", results);
}
