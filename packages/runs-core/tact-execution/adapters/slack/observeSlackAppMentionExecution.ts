// =========================
// TACT Canonical Execution — Slack Observation (SOR-129)
// =========================
//
// SOR-129: normalizeSlackExecutionEvent.tsは既にProvider Adapter Boundary
// (Provider Event → Canonical Execution Input)を実装しているが、
// core/tact-execution/adapters/notion/observeNotionMcpExecution.tsに
// 相当するorchestration wrapper(normalize結果をcapture→permission→
// correlationへ橋渡しする層)をまだ持たなかった。このfileがその薄い
// wrapperを追加し、Generic Observation Gateway
// (core/tact-execution/gateway/observeCanonicalExecution.ts)がNotion
// 以外のproviderからも同じ形で呼び出せることを実証する。
//
// 実配線についての注記(normalizeSlackExecutionEvent.tsの既存コメントと
// 同じ方針を維持する、絶対条件「変更範囲の規律」): このfileは
// core/tact-bot/adapters/slack/handleSlackWebhookRequest.ts(本番webhook
// route、既に安定稼働中)からは呼び出されていない。無断でその内部へ
// 新しい呼び出しを追加することを避ける——実際にfire-and-forgetの1行を
// 追加する作業は、normalizeSlackExecutionEvent.ts自身が既に明記していた
// 通り、今回もフォローアップとして残す。

import {
  captureExecution as defaultCaptureExecution,
} from "../../store";
import { observeExecutionPermission as defaultObserveExecutionPermission } from "../../permission";
import {
  observeExecutionWorkCorrelation as defaultObserveExecutionWorkCorrelation,
} from "../../correlation";
import {
  normalizeSlackAppMentionEventToExecution,
  SLACK_APP_MENTION_ADAPTER_VERSION,
} from "./normalizeSlackExecutionEvent";
import {
  recordIngestionFailure as defaultRecordIngestionFailure,
} from "../../telemetry/ingestionFailureStore";
import { observeCanonicalExecution } from "../../gateway/observeCanonicalExecution";
import type { ObservationSource, ObserveCanonicalExecutionDeps } from "../../gateway/types";
import type { ExecutionAdapterContext } from "../types";

// observeNotionMcpExecution.tsのdefaultDepsと同じ形(絶対条件: Gatewayの
// deps shapeはprovider間で共有する、既存のNotion側ログ文言はそのまま
// Notion側に残し、こちらはSlack向けの文言を持つ)。
const defaultDeps: ObserveCanonicalExecutionDeps = {
  captureExecution: defaultCaptureExecution,
  observeExecutionPermission: defaultObserveExecutionPermission,
  observeExecutionWorkCorrelation: defaultObserveExecutionWorkCorrelation,
  onFailure: (stage, error) => {
    // Do not log the provider payload or raw error: both can contain Slack message content or secrets.
    const errorKind = error instanceof Error ? error.name.slice(0, 100) : typeof error;
    console.error("[tact-execution/slack] observation failed", { stage, errorKind });
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
 * Observation boundary for Slack app_mention events, mirroring
 * observeNotionMcpExecution() via the shared Generic Observation Gateway.
 * Not wired into the production webhook route (see file header).
 */
export async function observeSlackAppMentionExecution(
  envelope: unknown,
  context: ExecutionAdapterContext,
  deps: ObserveCanonicalExecutionDeps = defaultDeps
): Promise<void> {

  const normalized = normalizeSlackAppMentionEventToExecution(envelope, context);

  const source: ObservationSource = {
    userId: context.userId,
    provider: "slack",
    connectionId: context.connectionId ?? null,
    adapterVersion: SLACK_APP_MENTION_ADAPTER_VERSION,
  };

  await observeCanonicalExecution(normalized, source, deps);

}
