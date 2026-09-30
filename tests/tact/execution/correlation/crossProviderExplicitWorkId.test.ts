// =========================
// TACT Canonical Execution — Cross-Provider Explicit WorkId Correlation
// (SOR-74)
// =========================
//
// 対象: SOR-74「異なるProviderからのExecutionが、同一の明示的Work IDで
// 同一Workへ着地すること」。explicit correlation自体(stages/explicit.ts)・
// captureExecution()のtenant/state validation(resolveTargetWorkForCorrelation()、
// SOR-52 Closeout Hardening Part1)は既にprovider非依存に実装済み——この
// fileはそのprovider非依存性を、2つの異なるprovider(Notion経由MCP・
// Slack)を明示的に使って直接検証する、SOR-74固有の新規regressionである。
//
// 実Supabase接続・実Notion MCP呼び出し・実Slack webhookは一切行わない
// (correlate.test.ts/store.test.tsと同じDI-only方針)。実Provider経由の
// 検証はSOR-74の完了報告に記載するreal Staging手順で別途行う。

import { correlateExecution, type CorrelateExecutionDeps } from "../../../../core/tact-execution/correlation/correlate";
import {
  captureExecution,
  type CaptureExecutionDeps,
  type ExecutionRow,
  type ResolveTargetWorkForCorrelationResult,
} from "../../../../core/tact-execution/store";
import type { CanonicalExecution, CaptureExecutionInput } from "../../../../core/tact-execution/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { check, summarize, type CheckResult } from "../../lib/check";

const SHARED_WORK_ID = "work-shared-1";

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
    resourceType: null,
    resourceIdentifier: null,
    targetProvider: null,
    status: "succeeded",
    errorCode: null,
    errorMessage: null,
    permissionStatus: "pending",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    outcomeStatus: "unknown",
    outcomeKind: null,
    providerOccurredAt: null,
    observedAt: "2026-09-20T12:00:00.000Z",
    persistedAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

// explicit stageが即決するケースでは他stageのdepsに一切到達しないはず
// (correlate.test.tsのthrowingDeps()と同じ、pipeline順序の裏取り)。
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

function baseInput(overrides: Partial<CaptureExecutionInput> = {}): CaptureExecutionInput {
  return {
    userId: "user-1",
    actorKind: "human",
    actorId: "U123",
    provider: "slack",
    sourceType: "webhook",
    externalEventId: "Ev1",
    adapterVersion: "v1",
    actionCategory: "create",
    operation: "app_mention",
    ...overrides,
  };
}

function makeRowFixture(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    id: "exec-1",
    schema_version: 1,
    user_id: "user-1",
    organization_id: null,
    workspace_id: null,
    work_id: null,
    correlation_status: "pending",
    connection_id: null,
    actor_kind: "human",
    actor_id: "U123",
    agent_id: null,
    on_behalf_of_actor_kind: null,
    on_behalf_of_actor_id: null,
    provider: "slack",
    source_type: "webhook",
    external_event_id: "Ev1",
    adapter_version: "v1",
    source_metadata: null,
    raw_payload_ref: null,
    observation_mode: null,
    pre_execution_visible: false,
    action_category: "create",
    operation: "app_mention",
    resource_type: null,
    resource_identifier: null,
    target_provider: null,
    status: "succeeded",
    error_code: null,
    error_message: null,
    permission_status: "pending",
    permission_reason_code: null,
    permission_evaluated_at: null,
    outcome_status: "unknown",
    outcome_kind: null,
    provider_occurred_at: null,
    observed_at: "2026-09-20T00:00:01.000Z",
    persisted_at: "2026-09-20T00:00:02.000Z",
    updated_at: "2026-09-20T00:00:02.000Z",
    ...overrides,
  };
}

function makeFakeClient(
  singleAndMaybeSingleResults: Array<{ data: unknown; error: unknown }>,
  onInsert?: (payload: Record<string, unknown>) => void
) {

  let callIndex = 0;

  const builder = {
    from: () => builder,
    insert: (payload: Record<string, unknown>) => {
      onInsert?.(payload);
      return builder;
    },
    select: () => builder,
    eq: () => builder,
    update: () => builder,
    is: () => builder,
    order: () => builder,
    single: async () => singleAndMaybeSingleResults[callIndex++],
    maybeSingle: async () => singleAndMaybeSingleResults[callIndex++],
  };

  return builder as unknown as SupabaseClient;

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- correlateExecution(): 同一workIdを持つNotion(MCP経由)/Slack
  // Executionは、providerに関わらずどちらもmatched/explicitとなり、
  // structural/temporal/AI-assisted stageのdepsには一切到達しない
  // (explicit.tsはexecution.workIdの有無だけを見るpure関数であり、
  // provider固有の分岐を一切持たないため)。----
  {
    const notionExecution = makeExecution({
      id: "exec-notion-1",
      provider: "mcp",
      targetProvider: "notion",
      workId: SHARED_WORK_ID,
    });
    const slackExecution = makeExecution({
      id: "exec-slack-1",
      provider: "slack",
      targetProvider: "slack",
      workId: SHARED_WORK_ID,
    });

    const notionDecision = await correlateExecution(notionExecution, throwingDeps("notion"));
    const slackDecision = await correlateExecution(slackExecution, throwingDeps("slack"));

    results.push(
      check(
        "[SOR-74] Notion(MCP)実行とSlack実行、同一の明示的workIdを持てばどちらもmatched/explicit/同一workIdを返す(providerに依存しない)",
        notionDecision.status === "matched" && notionDecision.method === "explicit" &&
          notionDecision.workId === SHARED_WORK_ID &&
          slackDecision.status === "matched" && slackDecision.method === "explicit" &&
          slackDecision.workId === SHARED_WORK_ID
      )
    );

    results.push(
      check(
        "[SOR-74] 両executionは同一Workへ着地しつつ、provider/idの異なるexecutionとしての識別性を保持する(異なるexecutionId/providerのまま)",
        notionExecution.id !== slackExecution.id &&
          notionExecution.provider !== slackExecution.provider &&
          notionDecision.executionId === "exec-notion-1" &&
          slackDecision.executionId === "exec-slack-1"
      )
    );
  }

  // ---- captureExecution(): tenant/state validationを通過する限り、
  // provider="mcp"(Notion向け)・provider="slack"のいずれも同じ
  // resolveTargetWorkForCorrelation()経路で同じworkIdをinsert payloadへ
  // 反映する(SOR-52 Closeout Hardening Part1のPath Aがprovider非依存
  // であることの直接的な確認)。----
  {
    let resolveCallCount = 0;

    const okResolveTargetWorkForCorrelation: CaptureExecutionDeps["resolveTargetWorkForCorrelation"] =
      async (): Promise<ResolveTargetWorkForCorrelationResult> => {
        resolveCallCount += 1;
        return { ok: true, work: { id: SHARED_WORK_ID } as never };
      };

    let notionInsertedPayload: Record<string, unknown> | undefined;

    const notionOutcome = await captureExecution(
      baseInput({
        provider: "mcp",
        targetProvider: "notion",
        externalEventId: "notion-invocation-1",
        adapterVersion: "notion-mcp-v1",
        workId: SHARED_WORK_ID,
      }),
      {
        getClient: () =>
          makeFakeClient(
            [{ data: makeRowFixture({ id: "exec-notion-1", provider: "mcp", target_provider: "notion", work_id: SHARED_WORK_ID }), error: null }],
            (payload) => { notionInsertedPayload = payload; }
          ),
        resolveTargetWorkForCorrelation: okResolveTargetWorkForCorrelation,
      }
    );

    let slackInsertedPayload: Record<string, unknown> | undefined;

    const slackOutcome = await captureExecution(
      baseInput({
        provider: "slack",
        targetProvider: "slack",
        externalEventId: "slack-event-1",
        adapterVersion: "slack-app-mention-v1",
        workId: SHARED_WORK_ID,
      }),
      {
        getClient: () =>
          makeFakeClient(
            [{ data: makeRowFixture({ id: "exec-slack-1", provider: "slack", target_provider: "slack", work_id: SHARED_WORK_ID }), error: null }],
            (payload) => { slackInsertedPayload = payload; }
          ),
        resolveTargetWorkForCorrelation: okResolveTargetWorkForCorrelation,
      }
    );

    results.push(
      check(
        "[SOR-74] captureExecution(): 同一の明示的workIdは、provider='mcp'(Notion向け)/provider='slack'のどちらでもtenant/state validation通過後にそのままinsert payload.work_idへ渡る",
        notionOutcome.status === "captured" && notionInsertedPayload?.work_id === SHARED_WORK_ID &&
          slackOutcome.status === "captured" && slackInsertedPayload?.work_id === SHARED_WORK_ID &&
          resolveCallCount === 2
      )
    );
  }

  return summarize("TACT Canonical Execution — SOR-74 Cross-Provider Explicit WorkId Correlation", results);

}
