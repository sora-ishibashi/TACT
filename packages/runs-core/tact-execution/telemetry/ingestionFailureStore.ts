// =========================
// TACT Canonical Execution — Ingestion Pipeline Failure Telemetry (SOR-46)
// =========================
//
// core/tact-execution/telemetry/配下の、tact_execution_ingestion_failures
// 専用DBアクセス層。supabase/migrations/
// 20261102000000_create_tact_execution_ingestion_failures.sqlを対象と
// する。SOR-50/51/52と同じ理由(書き込みは常に観測pipelineのfailure
// boundary、生きたuser browser sessionを前提できない)でservice role
// clientを使う——core/database/supabaseServiceRole.tsのallowlistへこの
// fileを追加する。
//
// 絶対条件(SOR-46指示「Preserve sanitized failure metadata only」「Do
// not persist raw secrets, tokens, or unnecessary payload content」):
// この層はerrorKindという1つのサニタイズ済み分類文字列しか受け取らない
// ——呼び出し元(observeNotionMcpExecution.ts)がraw error/stack/payloadを
// 渡そうとしても、この型自体がそれを表現できない。

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import type { ExecutionProvider } from "../types";

// core/tact-execution/adapters/notion/observeNotionMcpExecution.tsの既存
// ObserveNotionMcpExecutionFailureStageと同じ4値。新しい重複enumを作ら
// ない(絶対条件)——この型をtelemetry側のcanonical定義とし、Adapter側は
// これをそのまま使う。
export type IngestionFailureStage =
  | "normalization"
  | "capture"
  | "permission_evaluation"
  | "work_correlation";

export const INGESTION_FAILURE_STAGES: readonly IngestionFailureStage[] = [
  "normalization",
  "capture",
  "permission_evaluation",
  "work_correlation",
];

export interface RecordIngestionFailureInput {

  userId: string;

  provider: ExecutionProvider;

  connectionId?: string | null;

  adapterVersion: string;

  stage: IngestionFailureStage;

  // サニタイズ済みの分類のみ(例: Error.name、または既知の静的reason文字
  // 列)。raw error.message/stackはこの型に含めない(絶対条件、上記コメ
  // ント参照)。
  errorKind: string;

}

export type RecordIngestionFailureOutcome =
  | { status: "recorded" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface IngestionFailureStoreDeps {

  getClient: typeof getServiceRoleClient;

}

const defaultDeps: IngestionFailureStoreDeps = {
  getClient: getServiceRoleClient,
};

// Best-effort insert-only append。呼び出し元(observeNotionMcpExecution.ts
// のonFailure boundary)は、この関数が失敗してもpipeline本体を止めては
// ならない——このtelemetry自体が既存の観測boundaryより重要になっては
// いけない(絶対条件、SOR-46指示「Do not rebuild ... Attention
// generation」と同じ精神: telemetryは既存pipelineに新しい失敗点を
// 追加しない)。
export async function recordIngestionFailure(
  input: RecordIngestionFailureInput,
  deps: IngestionFailureStoreDeps = defaultDeps
): Promise<RecordIngestionFailureOutcome> {

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const { error } = await client
    .from("tact_execution_ingestion_failures")
    .insert({
      user_id: input.userId,
      provider: input.provider,
      connection_id: input.connectionId ?? null,
      adapter_version: input.adapterVersion,
      stage: input.stage,
      error_kind: input.errorKind.slice(0, 255),
    });

  if (error) {
    return { status: "error", message: error.message };
  }

  return { status: "recorded" };

}

export interface IngestionFailureView {

  id: string;

  provider: ExecutionProvider;

  connectionId: string | null;

  adapterVersion: string;

  stage: IngestionFailureStage;

  errorKind: string;

  occurredAt: string;

}

interface IngestionFailureRow {
  id: string;
  provider: ExecutionProvider;
  connection_id: string | null;
  adapter_version: string;
  stage: IngestionFailureStage;
  error_kind: string;
  occurred_at: string;
}

const INGESTION_FAILURE_COLUMNS =
  "id, provider, connection_id, adapter_version, stage, error_kind, occurred_at";

function toIngestionFailureView(row: IngestionFailureRow): IngestionFailureView {
  return {
    id: row.id,
    provider: row.provider,
    connectionId: row.connection_id,
    adapterVersion: row.adapter_version,
    stage: row.stage,
    errorKind: row.error_kind,
    occurredAt: row.occurred_at,
  };
}

export interface ListIngestionFailuresForUserOptions {
  limit?: number;
}

const DEFAULT_LIST_INGESTION_FAILURES_LIMIT = 100;
const MAX_LIST_INGESTION_FAILURES_LIMIT = 200;

// SOR-46 read boundary: tenant境界は明示的な`.eq("user_id", userId)`で行う
// (RLSをAPIの代わりとして扱わない、既存規約)。
export async function listIngestionFailuresForUser(
  userId: string,
  options: ListIngestionFailuresForUserOptions = {},
  deps: IngestionFailureStoreDeps = defaultDeps
): Promise<IngestionFailureView[]> {

  const client = deps.getClient();

  if (!client) {
    return [];
  }

  const limit = Math.min(
    options.limit ?? DEFAULT_LIST_INGESTION_FAILURES_LIMIT,
    MAX_LIST_INGESTION_FAILURES_LIMIT
  );

  const { data } = await client
    .from("tact_execution_ingestion_failures")
    .select(INGESTION_FAILURE_COLUMNS)
    .eq("user_id", userId)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((row) => toIngestionFailureView(row as IngestionFailureRow));

}
