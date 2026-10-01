// =========================
// TACT Canonical Execution — Work Correlation Observation Orchestration
// (SOR-52)
// =========================
//
// captureExecution()が成功した直後に呼ぶ、Correlate + Persistをまとめた
// 入口。core/tact-bot/adapters/slack/observeSlackExecution.ts(Phase B
// wiring)からはこの1関数だけを呼ぶ(core/tact-execution/permission/
// observe.tsと同じ役割分担)。
//
// 絶対条件(SOR-52指示「permission decisionとcorrelationが独立して
// いること」): この関数はexecution.permissionStatusを一切参照しない
// ——Permission評価の結果に関わらず、Work Correlationは独立して実行
// される。

import { correlateExecution, type CorrelateExecutionDeps, defaultCorrelateExecutionDeps } from "./correlate";
import {
  persistWorkCorrelationDecision,
  type PersistWorkCorrelationDecisionOutcome,
  type PersistWorkCorrelationDecisionDeps,
} from "./store";
import type { CanonicalExecution } from "../types";

export type ObserveExecutionWorkCorrelationOutcome =
  | PersistWorkCorrelationDecisionOutcome
  // 絶対条件(Duplicate correlation attempt): 既にwork_idが確定済み
  // (matched)のExecutionは、自動では再相関しない——Correlator pipeline
  // 自体を呼び出さない(無駄なDB往復も避ける)。将来のmanual override/
  // reclassificationは、この関数とは別の明示的な入口が必要になる想定
  // (SOR-52指示、残課題として報告)。
  | { status: "already_matched" };

export interface ObserveExecutionWorkCorrelationDeps {

  correlate: CorrelateExecutionDeps;

  persist: PersistWorkCorrelationDecisionDeps;

}

export async function observeExecutionWorkCorrelation(
  execution: CanonicalExecution,
  deps?: Partial<ObserveExecutionWorkCorrelationDeps>
): Promise<ObserveExecutionWorkCorrelationOutcome> {

  if (execution.correlationStatus === "matched" && execution.workId) {
    return { status: "already_matched" };
  }

  const decision = await correlateExecution(execution, deps?.correlate ?? defaultCorrelateExecutionDeps);

  return persistWorkCorrelationDecision(decision, execution.userId, deps?.persist);

}
