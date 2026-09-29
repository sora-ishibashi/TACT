// =========================
// TACT Canonical Execution — M-0 Canonical Correlation Result (SOR-53)
// =========================
//
// SOR-53指示「Canonical mapping」: 既存内部語彙(matched/ambiguous/
// unresolved)はそのままでよく、新しい重複enumをdomain内部に増やさない。
// UI/API/read boundaryが必要とする時だけ、product-facing
// (CORRELATED/AMBIGUOUS/UNASSIGNED)へ薄く変換する——SOR-51の
// toCanonicalPermissionResult()と同じ設計をここでも踏襲する。

import type { WorkCorrelationStatus } from "./types";
import type { ExecutionCorrelationStatus } from "../types";

export type CanonicalCorrelationResult = "CORRELATED" | "AMBIGUOUS" | "UNASSIGNED";

export const CANONICAL_CORRELATION_RESULTS: readonly CanonicalCorrelationResult[] = [
  "CORRELATED",
  "AMBIGUOUS",
  "UNASSIGNED",
];

// matched → CORRELATED、ambiguous → AMBIGUOUS、unresolved → UNASSIGNED。
export function toCanonicalCorrelationResult(status: WorkCorrelationStatus): CanonicalCorrelationResult {

  switch (status) {
    case "matched":
      return "CORRELATED";
    case "ambiguous":
      return "AMBIGUOUS";
    case "unresolved":
      return "UNASSIGNED";
  }

}

// SOR-54: CanonicalExecution.correlationStatus(../types.ts、4値、
// "pending"を含む)向けの変換。"pending"(未評価)と"unresolved"
// (評価済みだが候補なし)はいずれも「現時点でWorkに割り当てられて
// いない」という同じ事実であるため、ともにUNASSIGNEDとする(両者の
// 違いはExecutionCorrelationView.decidedAtの有無で区別できる、
// core/tact-execution/correlation/store.ts参照)。
//
// SOR-51のtoCanonicalPermissionResult()と対になる、この
// fileだけが持つDB非依存のpure関数——store.ts(DBアクセス層)から
// 独立させることで、client component(core/tact-runs-view経由)が
// この変換だけを、correlation/store.tsが引き込む重いserver-only
// dependency chain(core/tact-work/store.ts経由)無しに使える。
export function toCanonicalExecutionCorrelationStatus(status: ExecutionCorrelationStatus): CanonicalCorrelationResult {

  if (status === "pending") {
    return "UNASSIGNED";
  }

  return toCanonicalCorrelationResult(status);

}
