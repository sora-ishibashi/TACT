// =========================
// TACT Canonical Execution — Correlation Context Resolver Regression
// (SOR-52)
// =========================

import { resolveCorrelationContext } from "../../../../core/tact-execution/correlation/context";
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

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test10: metadata missing -> slack signal無し ----
  {
    const context = resolveCorrelationContext(makeExecution({ sourceMetadata: null }));

    results.push(check("[Test10] sourceMetadataが無い場合、slack構造signalは抽出されない", context.slack === undefined));
  }

  // ---- channel+threadTs両方あり ----
  {
    const context = resolveCorrelationContext(
      makeExecution({ sourceMetadata: { teamId: "T1", channel: "C1", threadTs: "100.001" } })
    );

    results.push(
      check(
        "[Extraction] teamId/channel/threadTsすべてあるsourceMetadataから抽出される",
        context.slack?.teamId === "T1" && context.slack?.channel === "C1" && context.slack?.threadTs === "100.001"
      )
    );
  }

  // ---- channelのみ(threadTs無し) ----
  {
    const context = resolveCorrelationContext(
      makeExecution({ sourceMetadata: { teamId: "T1", channel: "C1", threadTs: null } })
    );

    results.push(
      check(
        "[Extraction] threadTsが無い場合はundefinedのまま(teamId/channelのみ)",
        context.slack?.channel === "C1" && context.slack?.threadTs === undefined
      )
    );
  }

  // ---- Test8(tenant boundary/SOR-52 Closeout Hardening Part8): teamId
  // が無いsourceMetadataはslack signal無しとして扱う(workspace不明の
  // まま相関しない) ----
  {
    const context = resolveCorrelationContext(makeExecution({ sourceMetadata: { channel: "C1", threadTs: "100.001" } }));

    results.push(
      check(
        "[Test8/workspace scope] teamIdが無いsourceMetadataはslack構造signalを抽出しない(workspace不明のまま相関しない)",
        context.slack === undefined
      )
    );
  }

  // ---- 対象外provider -> slack signal無し ----
  {
    const context = resolveCorrelationContext(
      makeExecution({ provider: "gmail", sourceMetadata: { teamId: "T1", channel: "C1" } })
    );

    results.push(check("[Provider guard] slack以外のproviderはslack構造signalを抽出しない", context.slack === undefined));
  }

  return summarize("TACT Canonical Execution — Correlation Context", results);

}
