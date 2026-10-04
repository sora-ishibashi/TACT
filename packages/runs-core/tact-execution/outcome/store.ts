// =========================
// TACT Canonical Execution — Outcome Store (SOR-119)
// =========================
//
// core/tact-execution/outcome/配下の唯一のDBアクセス層。supabase/
// migrations/20261104000000_create_tact_execution_outcomes.sqlを対象と
// する。core/tact-execution/permission/store.tsと同じ設計(insert履歴 +
// update summaryの素朴な2-step、RPC化しない——Outcomeには現時点で
// tact_execution_work_correlationsがSOR-53でRPC化する理由となった同種の
// 同時実行race conditionが無いため)。
//
// 絶対条件(RLSをAPIの代わりとして扱わない、既存方針そのまま):
// service role clientはRLSを常にbypassするため、全関数が明示的に
// `.eq("user_id", userId)`を伴うクエリを組み立てる。

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import { validateAssertExecutionOutcomeInput } from "./validation";
import type {
  AssertExecutionOutcomeInput,
  ExecutionOutcome,
  ExecutionOutcomeMethod,
  ExecutionOutcomeStatus,
} from "./types";
import type { ExecutionActorKind } from "../types";
import type { JsonValue } from "@tact/execution-contract";

export interface ExecutionOutcomeRow {

  id: string;

  execution_id: string;

  status: ExecutionOutcomeStatus;

  outcome_kind: string | null;

  summary: string | null;

  artifact_id: string | null;

  method: ExecutionOutcomeMethod;

  reason_code: string | null;

  asserted_by_actor_kind: ExecutionActorKind | null;

  asserted_by_actor_id: string | null;

  metadata: JsonValue | null;

  asserted_at: string;

}

const OUTCOME_COLUMNS =
  "id, execution_id, status, outcome_kind, summary, artifact_id, method, reason_code, asserted_by_actor_kind, asserted_by_actor_id, metadata, asserted_at";

export function toExecutionOutcome(row: ExecutionOutcomeRow): ExecutionOutcome {

  return {
    id: row.id,
    executionId: row.execution_id,
    status: row.status,
    outcomeKind: row.outcome_kind,
    summary: row.summary,
    artifactId: row.artifact_id,
    method: row.method,
    reasonCode: row.reason_code,
    assertedByActorKind: row.asserted_by_actor_kind,
    assertedByActorId: row.asserted_by_actor_id,
    metadata: row.metadata,
    assertedAt: row.asserted_at,
  };

}

export type AssertExecutionOutcomeResult =
  | { status: "persisted"; outcome: ExecutionOutcome }
  | { status: "invalid"; errors: string[] }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface AssertExecutionOutcomeDeps {

  getClient: typeof getServiceRoleClient;

}

const defaultDeps: AssertExecutionOutcomeDeps = {
  getClient: getServiceRoleClient,
};

// SOR-119: Execution.status(技術的成否)とは独立して、「現実・業務・
// 対象の状態がどう変わったか」を明示的に主張する(または「確認したが
// 判断できない」ことを明示的に記録する)。この関数自身はOutcomeを
// 一切推測しない——呼び出し元(Adapter/human correction経路)が既に
// 確立した事実をそのまま永続化するだけ(絶対条件、Never Guess Rule)。
export async function assertExecutionOutcome(
  input: AssertExecutionOutcomeInput,
  userId: string,
  deps: AssertExecutionOutcomeDeps = defaultDeps
): Promise<AssertExecutionOutcomeResult> {

  const validation = validateAssertExecutionOutcomeInput(input);

  if (!validation.ok) {
    return { status: "invalid", errors: validation.errors };
  }

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  // tact_execution_outcomes自体はuser_id列を持たない(tact_execution_
  // work_correlationsと同じ設計、親経由のEXISTS句でtenant境界を判定
  // する、上記migrationコメント参照)。そのため書き込み前に、対象
  // executionが実際にこのuserId所有であることを明示的に確認する
  // (絶対条件、他tenantのExecutionへ書き込めてしまう経路を作らない)。
  const { data: execution } = await client
    .from("tact_canonical_executions")
    .select("id")
    .eq("id", input.executionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!execution) {
    return { status: "not_found" };
  }

  const { data, error } = await client
    .from("tact_execution_outcomes")
    .insert({
      execution_id: input.executionId,
      status: input.status,
      outcome_kind: input.outcomeKind ?? null,
      summary: input.summary ?? null,
      artifact_id: input.artifactId ?? null,
      method: input.method,
      reason_code: input.reasonCode ?? null,
      asserted_by_actor_kind: input.assertedByActorKind ?? null,
      asserted_by_actor_id: input.assertedByActorId ?? null,
      metadata: input.metadata ?? null,
    })
    .select(OUTCOME_COLUMNS)
    .single();

  if (error || !data) {
    return { status: "error", message: error?.message ?? "insert failed" };
  }

  // 親tact_canonical_executions.outcome_status/outcome_kind(要約列)を
  // 最新の主張へ更新する。履歴(上記insert)がsource of truthであり、
  // この要約列は「現在の最新状態」を素早く参照するための非正規化
  // (work_id/correlation_statusと同じ位置づけ)。
  await client
    .from("tact_canonical_executions")
    .update({
      outcome_status: input.status,
      outcome_kind: input.outcomeKind ?? null,
    })
    .eq("id", input.executionId)
    .eq("user_id", userId);

  return { status: "persisted", outcome: toExecutionOutcome(data as ExecutionOutcomeRow) };

}

// SOR-119: あるExecutionのOutcome履歴(append-only)を新しい順で返す。
// human correction UIの将来のReview/History表示(SOR-77の
// CorrelationReviewModalと同じ用途)向け。
export async function listExecutionOutcomesForExecution(
  executionId: string,
  userId: string
): Promise<ExecutionOutcome[]> {

  const client = getServiceRoleClient();

  if (!client) {
    return [];
  }

  const { data: execution } = await client
    .from("tact_canonical_executions")
    .select("id")
    .eq("id", executionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!execution) {
    return [];
  }

  const { data } = await client
    .from("tact_execution_outcomes")
    .select(OUTCOME_COLUMNS)
    .eq("execution_id", executionId)
    .order("asserted_at", { ascending: false });

  return (data ?? []).map((row) => toExecutionOutcome(row as ExecutionOutcomeRow));

}
