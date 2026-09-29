import {
  captureExecution as defaultCaptureExecution,
  type CaptureExecutionOutcome,
} from "../../store";
import { observeExecutionPermission as defaultObserveExecutionPermission } from "../../permission";
import type { PersistPermissionDecisionOutcome } from "../../permission";
import {
  observeExecutionWorkCorrelation as defaultObserveExecutionWorkCorrelation,
  type ObserveExecutionWorkCorrelationOutcome,
} from "../../correlation";
import {
  normalizeNotionMcpInvocationToExecution,
  NOTION_MCP_ADAPTER_VERSION,
  type NotionMcpInvocationObservation,
} from "./normalizeNotionMcpExecution";
import {
  recordIngestionFailure as defaultRecordIngestionFailure,
  type RecordIngestionFailureInput,
} from "../../telemetry/ingestionFailureStore";

export type ObserveNotionMcpExecutionFailureStage = "normalization" | "capture" | "permission_evaluation" | "work_correlation";

export interface ObserveNotionMcpExecutionDeps {
  captureExecution: (input: Parameters<typeof defaultCaptureExecution>[0]) => Promise<CaptureExecutionOutcome>;
  // SOR-51: Canonical Execution capture成功直後にPermission Registryと
  // 照合する(core/tact-bot/adapters/slack/observeSlackExecution.tsが
  // 既に確立した「captureの直後、Work correlationは待たない」配線と
  // 同じ)。既存のobserveExecutionPermission()をそのまま呼ぶだけで、
  // evaluator/policy自体はこのfileが持たない(責務分離)。
  observeExecutionPermission: (execution: Parameters<typeof defaultObserveExecutionPermission>[0]) => Promise<PersistPermissionDecisionOutcome>;
  // SOR-53: 同じcapture直後に、Permissionとは独立してWork Correlationも
  // 実行する(observeSlackAppMentionExecution()と同じ「permission decision
  // とcorrelationが独立していること」、SOR-52指示)。evaluator/policy同様、
  // correlator/candidate resolverの実装自体はこのfileが持たない。
  observeExecutionWorkCorrelation: (execution: Parameters<typeof defaultObserveExecutionWorkCorrelation>[0]) => Promise<ObserveExecutionWorkCorrelationOutcome>;
  onFailure: (stage: ObserveNotionMcpExecutionFailureStage, error: unknown) => void;
  // SOR-46(Minimal telemetry / source health, optional加算的dep): 既存の
  // onFailure(console.errorのみ)とは独立して、DBへ最小限のsanitize済み
  // failure telemetryを残す。省略可能——既存呼び出し元/testはこのfieldを
  // 一切知らなくてよい(既存のonFailureの挙動・シグネチャは一切変更しない)。
  recordIngestionFailure?: (input: RecordIngestionFailureInput) => Promise<void>;
}

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

// error.nameだけを使う(上記onFailureの既存sanitization方針と同じ、絶対
// 条件「Preserve sanitized failure metadata only」)——error.message/stack
// はraw provider payloadやDB制約名を含みうるため使わない。
function sanitizedErrorKind(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 100) : typeof error;
}

// 4つの失敗stageすべてで共有する報告helper。既存onFailure(同期、
// console.error専用)はそのまま呼び、telemetry(非同期、best-effort)は
// 独立してawait+swallowする——telemetry自体の失敗がpipeline本体の制御
// フローへ一切波及しないようにする(絶対条件、上記コメント参照)。
async function reportFailure(
  deps: ObserveNotionMcpExecutionDeps,
  stage: ObserveNotionMcpExecutionFailureStage,
  error: unknown,
  source: { userId: string; provider: RecordIngestionFailureInput["provider"]; connectionId: string | null; adapterVersion: string }
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
 * Final-result observation boundary for Claude and Custom MCP hosts.
 * Capture failures are reported but never thrown into the Notion tool path.
 */
export async function observeNotionMcpExecution(
  observation: NotionMcpInvocationObservation,
  deps: ObserveNotionMcpExecutionDeps = defaultDeps
): Promise<void> {
  const normalized = normalizeNotionMcpInvocationToExecution(observation);

  if (!normalized.ok) {
    await reportFailure(deps, "normalization", new Error(normalized.reason), {
      userId: observation.userId,
      provider: "mcp",
      connectionId: observation.connectionId ?? null,
      adapterVersion: NOTION_MCP_ADAPTER_VERSION,
    });
    return;
  }

  let outcome: CaptureExecutionOutcome;

  try {
    outcome = await deps.captureExecution(normalized.input);
  } catch (error) {
    await reportFailure(deps, "capture", error, {
      userId: normalized.input.userId,
      provider: normalized.input.provider,
      connectionId: normalized.input.connectionId ?? null,
      adapterVersion: normalized.input.adapterVersion,
    });
    return;
  }

  if (outcome.status === "invalid" || outcome.status === "unavailable" || outcome.status === "error") {
    await reportFailure(deps, "capture", new Error(`captureExecution returned ${outcome.status}`), {
      userId: normalized.input.userId,
      provider: normalized.input.provider,
      connectionId: normalized.input.connectionId ?? null,
      adapterVersion: normalized.input.adapterVersion,
    });
    return;
  }

  // outcome.status is "captured" or "duplicate" here. SOR-51 section6:
  // Work correlation(SOR-53)は待たない/依存させない——permission評価は
  // captureの直後に行う。duplicate captureでも、前回評価がpending
  // (未完了/未実行)のままなら安全に再試行する(observeSlackExecution.ts
  // のPermission Retry Recoveryと同じ規律)。
  const execution = outcome.execution;

  if (execution.permissionStatus === "pending") {
    try {
      await deps.observeExecutionPermission(execution);
    } catch (error) {
      await reportFailure(deps, "permission_evaluation", error, {
        userId: execution.userId,
        provider: execution.provider,
        connectionId: execution.connectionId,
        adapterVersion: execution.adapterVersion,
      });
    }
  }

  // SOR-53(絶対条件、SOR-52指示section「permission decisionとcorrelation
  // が独立していること」の延長): Permission評価の成否に関わらず、Work
  // Correlationは独立して実行する。observeExecutionWorkCorrelation()
  // 自身が「既にmatched」の場合を安全にskipするguardを持つため、ここで
  // 追加の分岐は不要(duplicate captureでも同様に呼んでよい)。
  try {
    await deps.observeExecutionWorkCorrelation(execution);
  } catch (error) {
    await reportFailure(deps, "work_correlation", error, {
      userId: execution.userId,
      provider: execution.provider,
      connectionId: execution.connectionId,
      adapterVersion: execution.adapterVersion,
    });
  }
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
