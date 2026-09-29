// =========================
// TACT Canonical Execution — Ingestion Source Health (SOR-46)
// =========================
//
// 絶対条件(SOR-46指示「Reuse the existing canonical Execution /
// correlation state. Do not create duplicate state」): 新しいsource of
// truthを作らない。この関数はDBアクセスを一切行わない純粋な集約関数
// であり、既に取得済みのCanonicalExecution[](tact_canonical_executions
// のexisting read boundary、listExecutionsForUser())を
// (provider, connectionId, adapterVersion)——「ingestion source
// identity」(SOR-46指示section1)——単位でgroupingし、直近の観測/成功/
// 失敗時刻とサニタイズ済みの直近失敗情報だけを返す。
//
// 絶対条件(「Do not build a generalized monitoring platform」):
// アラート・閾値判定・時系列grouping・保持期間ポリシーは持たない——
// 呼び出し元(API route)が固定件数のExecutionを渡した範囲内での要約
// だけを返す、最小限のdebug-facing集計。

import type { CanonicalExecution, ExecutionProvider } from "../types";

export interface SourceHealthSummary {

  provider: ExecutionProvider;

  connectionId: string | null;

  adapterVersion: string;

  // 渡されたExecution集合のうち、このsourceに属する件数(固定件数の
  // 呼び出し元windowの中での件数——全期間の合計ではない、上記コメント
  // 参照)。
  observedCount: number;

  lastObservedAt: string;

  lastSuccessAt: string | null;

  lastFailureAt: string | null;

  // 既にtact_canonical_executions.error_code/error_messageとして
  // sanitize済みの値をそのまま返す(この関数自身は追加のsanitizeを行わ
  // ない——SOR-50 Adapter層が既に保証している契約に依拠する、絶対条件
  // 「Preserve sanitized failure metadata only」)。
  lastFailure: { errorCode: string | null; errorMessage: string | null } | null;

}

function sourceKey(execution: Pick<CanonicalExecution, "provider" | "connectionId" | "adapterVersion">): string {
  return `${execution.provider}::${execution.connectionId ?? ""}::${execution.adapterVersion}`;
}

// 呼び出し元は新しいものから古いものの順・古いものから新しいものの順の
// いずれで渡してもよい(この関数自身がobservedAtを比較して最新値を
// 決める、順序への依存を作らない)。
export function computeSourceHealthSummaries(
  executions: readonly CanonicalExecution[]
): SourceHealthSummary[] {

  const summaries = new Map<string, SourceHealthSummary>();

  for (const execution of executions) {

    const key = sourceKey(execution);
    const existing = summaries.get(key);

    const summary: SourceHealthSummary = existing ?? {
      provider: execution.provider,
      connectionId: execution.connectionId,
      adapterVersion: execution.adapterVersion,
      observedCount: 0,
      lastObservedAt: execution.observedAt,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailure: null,
    };

    summary.observedCount += 1;

    if (execution.observedAt > summary.lastObservedAt) {
      summary.lastObservedAt = execution.observedAt;
    }

    if (execution.status === "succeeded" && (summary.lastSuccessAt === null || execution.observedAt > summary.lastSuccessAt)) {
      summary.lastSuccessAt = execution.observedAt;
    }

    if (execution.status === "failed" && (summary.lastFailureAt === null || execution.observedAt > summary.lastFailureAt)) {
      summary.lastFailureAt = execution.observedAt;
      summary.lastFailure = { errorCode: execution.errorCode, errorMessage: execution.errorMessage };
    }

    summaries.set(key, summary);

  }

  return [...summaries.values()];

}
