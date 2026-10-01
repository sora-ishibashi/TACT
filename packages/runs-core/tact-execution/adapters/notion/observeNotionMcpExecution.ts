// =========================
// TACT Canonical Execution — Notion MCP Observation (SOR-50/51/52/53)
// =========================
//
// SOR-129: このfileはNotion固有のreference implementationとして残す
// (絶対条件: Notionの現行Reality Test behaviorを維持する、既存経路を
// 壊して作り直さない)。normalize結果を受け取った後のorchestration本体
// (capture→permission→correlation、失敗の隔離・記録)は、provider中立な
// core/tact-execution/gateway/observeCanonicalExecution.tsへ移した——
// このfileはNotion固有のnormalize呼び出しと、既存と全く同じ
// ObserveNotionMcpExecutionDeps/defaultDeps(既存のconsole.errorメッセージ
// 文言を含む)をGatewayへ橋渡しするだけの薄いwrapperになる。挙動・stage
// 文字列・エラーsanitize方針はビット単位で従来と同一。

import {
  captureExecution as defaultCaptureExecution,
} from "../../store";
import { observeExecutionPermission as defaultObserveExecutionPermission } from "../../permission";
import {
  observeExecutionWorkCorrelation as defaultObserveExecutionWorkCorrelation,
} from "../../correlation";
import {
  normalizeNotionMcpInvocationToExecution,
  NOTION_MCP_ADAPTER_VERSION,
  type NotionMcpInvocationObservation,
} from "./normalizeNotionMcpExecution";
import {
  recordIngestionFailure as defaultRecordIngestionFailure,
} from "../../telemetry/ingestionFailureStore";
import { observeCanonicalExecution } from "../../gateway/observeCanonicalExecution";
import type { ObservationSource, ObserveCanonicalExecutionDeps, IngestionFailureStage } from "../../gateway/types";

// SOR-129: core/tact-execution/telemetry/ingestionFailureStore.tsの
// IngestionFailureStageの既存の別名(このfile自身の既存コメントが
// 「新しい重複enumを作らない」と明言していた通り、Gateway抽出後もその
// 方針を維持する——型自体をGatewayのcanonical定義からそのまま再export
// するだけ)。
export type ObserveNotionMcpExecutionFailureStage = IngestionFailureStage;

// SOR-129: core/tact-execution/gateway/types.tsのObserveCanonicalExecutionDeps
// と構造的に同一(Gateway抽出前と全く同じshape、既存の呼び出し元/testの
// importを一切壊さない)。
export type ObserveNotionMcpExecutionDeps = ObserveCanonicalExecutionDeps;

const defaultDeps: ObserveNotionMcpExecutionDeps = {
  captureExecution: defaultCaptureExecution,
  observeExecutionPermission: defaultObserveExecutionPermission,
  observeExecutionWorkCorrelation: defaultObserveExecutionWorkCorrelation,
  onFailure: (stage, error) => {
    // Do not log the provider payload or raw error: both can contain Notion content or secrets.
    // A stable error kind is enough for operational diagnosis at this boundary.
    const errorKind = error instanceof Error ? error.name.slice(0, 100) : typeof error;
    console.error("[tact-execution/notion-mcp] observation failed", { stage, errorKind });
  },
  recordIngestionFailure: async (input) => {
    try {
      await defaultRecordIngestionFailure(input);
    } catch {
      // Telemetry is best-effort and must never affect the observation pipeline itself.
    }
  },
};

/**
 * Final-result observation boundary for Claude and Custom MCP hosts.
 * Capture failures are reported but never thrown into the Notion tool path.
 */
export async function observeNotionMcpExecution(
  observation: NotionMcpInvocationObservation,
  deps: ObserveNotionMcpExecutionDeps = defaultDeps
): Promise<void> {

  const normalized = normalizeNotionMcpInvocationToExecution(observation);

  const source: ObservationSource = {
    userId: observation.userId,
    provider: "mcp",
    connectionId: observation.connectionId ?? null,
    adapterVersion: NOTION_MCP_ADAPTER_VERSION,
  };

  await observeCanonicalExecution(normalized, source, deps);

}

export type NotionMcpToolInvocationContext = Omit<NotionMcpInvocationObservation, "status" | "errorCode">;

/**
 * Convenience hook for an MCP host. One invocation creates one final
 * execution record; tool errors are observed as `failed` and then rethrown.
 */
export async function executeWithNotionMcpObservation<T>(
  context: NotionMcpToolInvocationContext,
  executeTool: () => Promise<T>,
  deps: ObserveNotionMcpExecutionDeps = defaultDeps
): Promise<T> {
  try {
    const result = await executeTool();
    await observeNotionMcpExecution({ ...context, status: "succeeded" }, deps);
    return result;
  } catch (error) {
    await observeNotionMcpExecution({ ...context, status: "failed" }, deps);
    throw error;
  }
}
