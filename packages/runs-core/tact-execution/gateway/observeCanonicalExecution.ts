// =========================
// TACT Canonical Execution — Generic Observation Gateway (SOR-129)
// =========================
//
// core/tact-execution/adapters/notion/observeNotionMcpExecution.tsの
// orchestration本体(normalize結果を受け取った後の
// capture→permission→correlation、および失敗の隔離・記録)を、
// provider中立な形でそのまま抽出したもの。ロジック・stage文字列・
// エラーsanitize方針は一切変更していない(絶対条件: Notionの現行
// Reality Test behaviorを維持する、既存経路を壊して作り直さない)。
//
// このfile自身はprovider固有の語彙(toolName/resource.type/Slack event
// shape等)を一切知らない——呼び出し元(provider固有のwrapper、例:
// observeNotionMcpExecution.ts)がnormalize()の結果(ExecutionAdapter
// NormalizeResult)とObservationSource(normalizationが失敗した場合でも
// failure報告に使えるsource identity)を渡すだけでよい。

import type { CaptureExecutionOutcome } from "../store";
import type { ExecutionAdapterNormalizeResult, ObservationSource, ObserveCanonicalExecutionDeps } from "./types";
import type { IngestionFailureStage } from "../telemetry/ingestionFailureStore";

// observeNotionMcpExecution.tsの既存sanitizedErrorKind()と同一
// (絶対条件、上記コメント参照: raw error.message/stackはtelemetryへ
// 渡さない)。
function sanitizedErrorKind(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 100) : typeof error;
}

// observeNotionMcpExecution.tsの既存reportFailure()と同一ロジック
// (onFailureを同期的に呼び、recordIngestionFailureはbest-effortで
// 独立してawait+swallowする)。
async function reportFailure(
  deps: ObserveCanonicalExecutionDeps,
  stage: IngestionFailureStage,
  error: unknown,
  source: ObservationSource
): Promise<void> {
  deps.onFailure(stage, error);
  try {
    await deps.recordIngestionFailure?.({
      userId: source.userId,
      provider: source.provider,
      connectionId: source.connectionId,
      adapterVersion: source.adapterVersion,
      stage,
      errorKind: sanitizedErrorKind(error),
    });
  } catch {
    // Telemetry is best-effort and must never affect the observation pipeline itself.
  }
}

/**
 * Provider-neutral observation orchestration: normalize結果を受け取り、
 * capture → (pending時のみ)permission評価 → work correlationの順に呼ぶ。
 * 各stageの失敗はonFailure/recordIngestionFailureで隔離し、決して呼び出し元
 * (provider固有のtool実行path)へ例外を伝播させない
 * (observeNotionMcpExecution.tsの既存絶対条件と同一)。
 *
 * Outcome assertion(SOR-119)はこのGatewayの自動flowには含めない
 * (core/tact-execution/gateway/types.tsのコメント参照——現時点でどの
 * adapterもgenuineな確認signalを持たない、migration不要の原則)。
 */
export async function observeCanonicalExecution(
  normalized: ExecutionAdapterNormalizeResult,
  source: ObservationSource,
  deps: ObserveCanonicalExecutionDeps
): Promise<void> {

  if (!normalized.ok) {
    await reportFailure(deps, "normalization", new Error(normalized.reason), source);
    return;
  }

  let outcome: CaptureExecutionOutcome;

  try {
    outcome = await deps.captureExecution(normalized.input);
  } catch (error) {
    await reportFailure(deps, "capture", error, source);
    return;
  }

  if (outcome.status === "invalid" || outcome.status === "unavailable" || outcome.status === "error") {
    await reportFailure(deps, "capture", new Error(`captureExecution returned ${outcome.status}`), source);
    return;
  }

  const execution = outcome.execution;

  // captureExecution()が実際に確定させた値(validation通過後の正規化済み
  // 値)を使う——normalized.inputではなくexecutionから読む(observe
  // NotionMcpExecution.tsの既存動作と同一)。
  const executionSource: ObservationSource = {
    userId: execution.userId,
    provider: execution.provider,
    connectionId: execution.connectionId,
    adapterVersion: execution.adapterVersion,
  };

  if (execution.permissionStatus === "pending") {
    try {
      await deps.observeExecutionPermission(execution);
    } catch (error) {
      await reportFailure(deps, "permission_evaluation", error, executionSource);
    }
  }

  try {
    await deps.observeExecutionWorkCorrelation(execution);
  } catch (error) {
    await reportFailure(deps, "work_correlation", error, executionSource);
  }

}
