// =========================
// TACT Canonical Execution — Ingestion Failure Store (SOR-46)
// =========================

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  recordIngestionFailure,
  listIngestionFailuresForUser,
  type IngestionFailureStoreDeps,
  type RecordIngestionFailureInput,
} from "@tact/runs-core/tact-execution/telemetry/ingestionFailureStore";
import { check, summarize, type CheckResult } from "../../lib/check";

function input(overrides: Partial<RecordIngestionFailureInput> = {}): RecordIngestionFailureInput {
  return {
    userId: "user-1",
    provider: "mcp",
    connectionId: "connection-1",
    adapterVersion: "notion-mcp-v1",
    stage: "capture",
    errorKind: "Error",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  {
    // unavailable(service role未設定): 例外を投げず、明示的なunavailableを返す。
    const deps: IngestionFailureStoreDeps = { getClient: () => null };
    const outcome = await recordIngestionFailure(input(), deps);
    results.push(check("[unavailable] recordIngestionFailure() reports unavailable rather than throwing when unconfigured", outcome.status === "unavailable"));
  }

  {
    // 正常系: insertへ渡されるpayloadがsanitized fieldだけであることを検証する。
    const insertedRows: Array<Record<string, unknown>> = [];
    const deps: IngestionFailureStoreDeps = {
      getClient: () => ({
        from: () => ({
          insert: async (row: Record<string, unknown>) => {
            insertedRows.push(row);
            return { error: null };
          },
        }),
      } as unknown as SupabaseClient),
    };

    const outcome = await recordIngestionFailure(input({ errorKind: "TypeError" }), deps);

    results.push(check(
      "[recorded] a successful insert reports recorded and carries only sanitized, allow-listed fields",
      outcome.status === "recorded" &&
        insertedRows.length === 1 &&
        insertedRows[0].user_id === "user-1" &&
        insertedRows[0].provider === "mcp" &&
        insertedRows[0].connection_id === "connection-1" &&
        insertedRows[0].adapter_version === "notion-mcp-v1" &&
        insertedRows[0].stage === "capture" &&
        insertedRows[0].error_kind === "TypeError" &&
        Object.keys(insertedRows[0]).sort().join(",") ===
          ["adapter_version", "connection_id", "error_kind", "provider", "stage", "user_id"].join(",")
    ));
  }

  {
    // errorKindは常に255文字以内へ切り詰める(DB CHECK制約と同じ上限、絶対条件)。
    const insertedRows: Array<Record<string, unknown>> = [];
    const deps: IngestionFailureStoreDeps = {
      getClient: () => ({
        from: () => ({
          insert: async (row: Record<string, unknown>) => {
            insertedRows.push(row);
            return { error: null };
          },
        }),
      } as unknown as SupabaseClient),
    };

    await recordIngestionFailure(input({ errorKind: "x".repeat(500) }), deps);

    results.push(check(
      "[bounded] errorKind is truncated to 255 characters before insert",
      typeof insertedRows[0].error_kind === "string" && (insertedRows[0].error_kind as string).length === 255
    ));
  }

  {
    // DB errorはerrorとして報告される(呼び出し元/observeNotionMcpExecutionが
    // 自分でtry/catchするため、ここでは例外を投げず戻り値で表す)。
    const deps: IngestionFailureStoreDeps = {
      getClient: () => ({
        from: () => ({
          insert: async () => ({ error: { message: "insert failed" } }),
        }),
      } as unknown as SupabaseClient),
    };

    const outcome = await recordIngestionFailure(input(), deps);
    results.push(check("[error] a DB error is reported as a typed error outcome, not a thrown exception", outcome.status === "error" && "message" in outcome && outcome.message === "insert failed"));
  }

  {
    // 読み取りはtenant境界(user_id)で絞り込む。
    const eqCalls: Array<[string, unknown]> = [];
    const deps: IngestionFailureStoreDeps = {
      getClient: () => ({
        from: () => {
          const builder = {
            select: () => builder,
            eq: (col: string, value: unknown) => { eqCalls.push([col, value]); return builder; },
            order: () => builder,
            limit: () => Promise.resolve({
              data: [{
                id: "f1", provider: "mcp", connection_id: "connection-1",
                adapter_version: "notion-mcp-v1", stage: "capture", error_kind: "Error",
                occurred_at: "2026-09-25T00:00:00.000Z",
              }],
            }),
          };
          return builder;
        },
      } as unknown as SupabaseClient),
    };

    const items = await listIngestionFailuresForUser("user-1", {}, deps);

    results.push(check(
      "[read boundary] listIngestionFailuresForUser() filters by user_id and maps rows to the camelCase view",
      eqCalls.some(([col, value]) => col === "user_id" && value === "user-1") &&
        items.length === 1 && items[0].adapterVersion === "notion-mcp-v1" && items[0].errorKind === "Error"
    ));
  }

  {
    // unavailable(read側): 例外を投げず空配列を返す(既存listExecutionAttentions等と同じ規律)。
    const deps: IngestionFailureStoreDeps = { getClient: () => null };
    const items = await listIngestionFailuresForUser("user-1", {}, deps);
    results.push(check("[unavailable] listIngestionFailuresForUser() returns an empty list rather than throwing when unconfigured", items.length === 0));
  }

  return summarize("TACT Canonical Execution — Ingestion Failure Store", results);
}
