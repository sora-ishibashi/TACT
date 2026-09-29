// =========================
// TACT Canonical Execution — DB row <-> domain mapping Regression (SOR-50)
// =========================
//
// 対象: core/tact-execution/store.tsのtoCanonicalExecution()(純粋
// 関数、DBアクセスなし)。tests/tact/work/mapping.test.tsと同じ方針:
// このファイル自体は実Supabase接続を行わない。DB側のPRIMARY KEY/
// UNIQUE index/CHECK制約(migration自体)による実際の防止は、別途
// 一時スクリプトで確認する。

import { toCanonicalExecution, type ExecutionRow } from "../../../core/tact-execution/store";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: toCanonicalExecution() — 基本フィールド変換 ----
  {
    const row: ExecutionRow = {
      id: "exec-1",
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
      external_event_id: "Ev123",
      adapter_version: "slack-app-mention-v1",
      source_metadata: { channel: "C1" },
      raw_payload_ref: null,
      action_category: "create",
      operation: "app_mention",
      resource_type: "slack_message",
      resource_identifier: "C1:100.001",
      target_provider: "slack",
      status: "succeeded",
      error_code: null,
      error_message: null,
      permission_status: "unknown",
      permission_reason_code: null,
      permission_evaluated_at: null,
      provider_occurred_at: "2026-09-20T00:00:00.000Z",
      observed_at: "2026-09-20T00:00:01.000Z",
      persisted_at: "2026-09-20T00:00:02.000Z",
      updated_at: "2026-09-20T00:00:02.000Z",
    };

    const execution = toCanonicalExecution(row);

    results.push(
      check(
        "[Test1] toCanonicalExecution(): Identityフィールドが変換される",
        execution.id === "exec-1" &&
          execution.userId === "user-1" &&
          execution.workId === null
      )
    );

    results.push(
      check(
        "[Test1] toCanonicalExecution(): Actorフィールドが変換される",
        execution.actorKind === "human" && execution.actorId === "U123"
      )
    );

    results.push(
      check(
        "[Test1] toCanonicalExecution(): Source/Provenanceフィールドが変換される",
        execution.provider === "slack" &&
          execution.sourceType === "webhook" &&
          execution.externalEventId === "Ev123" &&
          execution.adapterVersion === "slack-app-mention-v1"
      )
    );

    results.push(
      check(
        "[Test1] toCanonicalExecution(): Actionフィールドが変換される",
        execution.actionCategory === "create" &&
          execution.operation === "app_mention" &&
          execution.resourceIdentifier === "C1:100.001" &&
          execution.targetProvider === "slack"
      )
    );

    results.push(
      check(
        "[Test1] toCanonicalExecution(): Time区分(providerOccurredAt/observedAt/persistedAt)が別々に保持される",
        execution.providerOccurredAt === "2026-09-20T00:00:00.000Z" &&
          execution.observedAt === "2026-09-20T00:00:01.000Z" &&
          execution.persistedAt === "2026-09-20T00:00:02.000Z"
      )
    );

  }

  // ---- Test2: toCanonicalExecution() — Work IDあり(相関済み) ----
  {
    const row: ExecutionRow = {
      id: "exec-2",
      user_id: "user-1",
      organization_id: null,
      workspace_id: null,
      work_id: "work-1",
      correlation_status: "matched",
      connection_id: "conn-1",
      actor_kind: "ai_agent",
      actor_id: "agent-42",
      agent_id: "agent-42-v3",
      on_behalf_of_actor_kind: "human",
      on_behalf_of_actor_id: "U123",
      provider: "openai",
      source_type: "sdk_callback",
      external_event_id: "run_abc",
      adapter_version: "openai-v1",
      source_metadata: null,
      raw_payload_ref: null,
      action_category: "execute",
      operation: "tool_call",
      resource_type: null,
      resource_identifier: null,
      target_provider: "gmail",
      status: "failed",
      error_code: "provider_timeout",
      error_message: "upstream timed out",
      permission_status: "denied",
      permission_reason_code: "policy.denied.unknown_operation",
      permission_evaluated_at: "2026-09-20T00:00:05.000Z",
      provider_occurred_at: null,
      observed_at: "2026-09-20T00:00:01.000Z",
      persisted_at: "2026-09-20T00:00:02.000Z",
      updated_at: "2026-09-20T00:00:06.000Z",
    };

    const execution = toCanonicalExecution(row);

    results.push(
      check(
        "[Test2] toCanonicalExecution(): Work IDありの相関が変換される",
        execution.workId === "work-1" && execution.connectionId === "conn-1" && execution.correlationStatus === "matched"
      )
    );

    results.push(
      check(
        "[Test2] toCanonicalExecution(): 委任(onBehalfOf)フィールドが変換される",
        execution.onBehalfOfActorKind === "human" && execution.onBehalfOfActorId === "U123"
      )
    );

    results.push(
      check(
        "[Test2] toCanonicalExecution(): failed executionのerror/permissionフィールドが失われない",
        execution.status === "failed" &&
          execution.errorCode === "provider_timeout" &&
          execution.permissionStatus === "denied" &&
          execution.permissionReasonCode === "policy.denied.unknown_operation"
      )
    );

  }

  return summarize("TACT Canonical Execution — Mapping", results);

}
