// =========================
// TACT Canonical Execution — Slack Adapter (SOR-50 vertical slice)
// =========================
//
// SOR-50が要求する「1種類の実Adapterでvertical sliceが通ればよい」
// を満たす、最初の実Adapter。core/tact-bot/adapters/slack/types.ts
// が既に定義しているraw Slack event型(SlackAppMentionEvent/
// SlackEventCallbackEnvelope)をtype-onlyでそのまま再利用する
// (provider固有の生shapeを二重定義しない)。
//
// 絶対条件(core/tact-bot/adapters/slack/handleSlackWebhookRequest.ts
// Section2と同じ精神を、この新Adapterにも適用する): raw Slack
// payload全体をCanonical model本体へ漏らさない。ここで抽出するのは
// event識別・actor識別・action分類に必要な最小限のfieldのみであり、
// message本文(text)はsource_metadataへ一切含めない。
//
// 実配線についての注記(残課題、最終報告参照): このAdapterは
// core/tact-bot/adapters/slack/handleSlackWebhookRequest.ts(本番
// webhook route)からは現時点で呼び出されていない。同fileは
// 「署名検証→...→canonical normalization→receiveBotMessage()」という
// 順序が絶対条件として明文化された、既に安定稼働中のproduction
// pipelineであり、SOR-50の指示(既存ロジックを勝手に変更しない、
// 変更範囲の規律)に従い、無断でその内部へ新しい呼び出しを追加する
// ことを避けた。本fileはAdapter Boundary(Provider Event → Provider
// Adapter → Canonical Execution Input)自体を実装・検証することが
// 目的であり、実際にProduction webhookへ1行のfire-and-forget呼び出し
// を追加する作業はフォローアップとして残す。

import type {
  SlackAppMentionEvent,
  SlackEventCallbackEnvelope,
} from "../../../tact-bot/adapters/slack/types";
import type { CaptureExecutionInput } from "../../types";
import type { ExecutionAdapterContext, ExecutionAdapterNormalizeResult } from "../types";

export const SLACK_APP_MENTION_ADAPTER_VERSION = "slack-app-mention-v1";

function isEventCallbackEnvelope(value: unknown): value is SlackEventCallbackEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "event_callback"
  );
}

function isAppMentionEvent(value: unknown): value is SlackAppMentionEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "app_mention"
  );
}

function toIsoOrUndefined(unixSeconds: number | undefined): string | undefined {

  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) {
    return undefined;
  }

  return new Date(unixSeconds * 1000).toISOString();

}

// pure関数(DBアクセス・副作用無し)。呼び出し元がcaptureExecution()を
// 呼ぶ責務を持つ。
export function normalizeSlackAppMentionEventToExecution(
  envelope: unknown,
  context: ExecutionAdapterContext
): ExecutionAdapterNormalizeResult {

  if (!isEventCallbackEnvelope(envelope)) {
    return { ok: false, reason: "not an event_callback envelope" };
  }

  if (!isAppMentionEvent(envelope.event)) {
    return { ok: false, reason: "not an app_mention event" };
  }

  const event = envelope.event;

  if (typeof envelope.event_id !== "string" || envelope.event_id.length === 0) {
    // Idempotency keyが成立しないeventは観測しない(絶対条件、
    // captureExecution()側のexternal_event_id必須制約と同じ判断)。
    return { ok: false, reason: "missing event_id" };
  }

  // SOR-52 Closeout Hardening Part8(Slack Resource Identity): team_id
  // (Slack workspace識別子)をresource identityへ含める。同じYolna user
  // が複数のSlack workspaceを接続した場合でも、channel/thread/message
  // 識別子だけに依存せずresource identityが衝突しないようにする
  // (Slackのchannel ID自体はplatform全体で一意という前提に依存
  // しすぎない、絶対条件)。
  const teamId = typeof envelope.team_id === "string" && envelope.team_id.length > 0 ? envelope.team_id : undefined;

  const resourceIdentifier =
    teamId && typeof event.channel === "string" && typeof event.ts === "string"
      ? `${teamId}:${event.channel}:${event.ts}`
      : undefined;

  const input: CaptureExecutionInput = {

    userId: context.userId,
    organizationId: context.organizationId ?? null,
    workspaceId: context.workspaceId ?? null,
    workId: context.workId ?? null,
    connectionId: context.connectionId ?? null,

    // Slack app_mentionは常に人間のSlack userが投稿したmentionである
    // (bot echoはこのAdapterへ渡す前に呼び出し元がfilterする想定、
    // handleSlackWebhookRequest.tsのisBotEchoEvent()と同じ役割分担)。
    actorKind: "human",
    actorId: typeof event.user === "string" ? event.user : null,

    provider: "slack",
    sourceType: "webhook",
    externalEventId: envelope.event_id,
    adapterVersion: SLACK_APP_MENTION_ADAPTER_VERSION,

    // message本文(text)は含めない(絶対条件、上記コメント参照)。
    // teamId(SOR-52 Closeout Hardening Part8)を含めることで、
    // core/tact-execution/correlation/context.tsのStructural
    // Correlatorがworkspace scopeを認識できるようにする。
    sourceMetadata:
      teamId || typeof event.channel === "string" || typeof event.thread_ts === "string"
        ? {
            teamId: teamId ?? null,
            channel: typeof event.channel === "string" ? event.channel : null,
            threadTs: typeof event.thread_ts === "string" ? event.thread_ts : null,
          }
        : null,

    actionCategory: "create",
    operation: "app_mention",
    resourceType: "slack_message",
    resourceIdentifier: resourceIdentifier ?? null,
    targetProvider: "slack",

    // Slackはwebhook配信時点で既にmessageの作成を完了しているため、
    // 「running」段階を経ず観測される(SOR-50 Status section、
    // 「実データに不要な状態を無理に実装する必要はない」)。
    status: "succeeded",

    providerOccurredAt: toIsoOrUndefined(envelope.event_time) ?? null,
    observedAt: context.observedAt,

  };

  return { ok: true, input };

}
