import type { BotConversationType, BotIncomingMessage } from "../../types";
import type { SlackAppMentionEvent, SlackEventCallbackEnvelope } from "./types";

// =========================
// TACT Bot — Slack app_mention Normalization (S1a)
// =========================
//
// Slack event(署名検証済み・event_callback/app_mentionと確認済みの
// raw payload)を、platform非依存のBotIncomingMessage(core/tact-bot/
// types.ts、BOT-P1)へ変換する。Slack raw payloadそのもの・Slack固有の
// field名(bot_id/subtype/thread_ts等)はこの境界の外(core/tact-bot/
// gateway以降、まして core/tact-conversation・core/tact-work・
// core/tact-orchestrator・core/tact-research)へ一切漏らさない
// (絶対条件Section2)。
//
// mentionedTact/tactUserId等、業務判断・identity解決はここでは一切
// 行わない(絶対条件、core/tact-bot/types.ts冒頭コメントと同じ責務
// 境界)。

// "<@U0123ABCD>"(Slackの実際のmention記法)を文頭からのみ剥がす。
// 既存core/tact-bot/context/buildBotContext.tsのLEADING_MENTION_PATTERN
// と同じ「文頭の定型文字列を剥がすだけ」という設計方針を踏襲する。
// Bot自身のuser IDをhard-codeしない(任意のuser ID表記に一致する
// パターンにする、絶対条件Section10)。
const LEADING_SLACK_MENTION_PATTERN = /^\s*<@[A-Z0-9]+>\s*[:,]?\s*/i;

// event_callback + event.type==="app_mention"であることのtype guard。
// dedup(event claim)より前に呼ばれる、「そもそも処理対象のevent種別か」
// という判定(絶対条件Section17の処理順序)。
export function isAppMentionEventCallback(
  envelope: unknown
): envelope is SlackEventCallbackEnvelope & { event: SlackAppMentionEvent } {

  if (!envelope || typeof envelope !== "object") {
    return false;
  }

  const candidate = envelope as { type?: unknown; event?: unknown };

  if (candidate.type !== "event_callback") {
    return false;
  }

  const event = candidate.event;

  return (
    !!event &&
    typeof event === "object" &&
    (event as { type?: unknown }).type === "app_mention"
  );

}

// Bot自身が投稿したmessageのecho判定(絶対条件Section9、bot loop防止)。
// event.bot_id(Botとして投稿されたmessageに付与される)、または
// event.subtype==="bot_message"のいずれかで判定する。own bot user id
// による追加filterは、S1a時点で新しいsecret/config(Bot自身のuser ID)
// を増やさないという方針(絶対条件Section9)により見送る——bot_id/
// subtypeの2条件で十分にecho除外できる。
export function isBotEchoEvent(event: SlackAppMentionEvent): boolean {

  return (
    (typeof event.bot_id === "string" && event.bot_id.length > 0) ||
    event.subtype === "bot_message"
  );

}

// app_mention eventからcanonical BotIncomingMessageを組み立てる。
// 対象外・不正な形式の場合はnullを返す(例外を投げない、絶対条件:
// ChannelAdapter.normalizeIncoming()の既存契約と同じ「そもそも
// BotIncomingMessageとして成立するpayloadかどうか」の判定)。
export function normalizeSlackAppMentionEvent(
  envelope: SlackEventCallbackEnvelope
): BotIncomingMessage | null {

  if (!isAppMentionEventCallback(envelope)) {
    return null;
  }

  const event = envelope.event;

  if (isBotEchoEvent(event)) {
    return null;
  }

  if (typeof event.user !== "string" || event.user.length === 0) {
    return null;
  }

  if (typeof event.channel !== "string" || event.channel.length === 0) {
    return null;
  }

  if (typeof event.ts !== "string" || event.ts.length === 0) {
    return null;
  }

  const rawText = typeof event.text === "string" ? event.text : "";
  const text = rawText.replace(LEADING_SLACK_MENTION_PATTERN, "").trim();

  // 絶対条件(Section11): mention除去後に空文字になった場合、
  // Researchへは一切流さない(呼び出し元がBotIncomingMessageを
  // 受け取れないよう、ここでnullとして扱う)。
  if (!text) {
    return null;
  }

  // MVP scope: app_mentionはchannel/group発言のみを対象とする
  // (DM/message.imはS1a scope外、絶対条件Section8)。
  const conversationType: BotConversationType = "channel";

  // 絶対条件(Section12): 既にthread内での@mentionならそのthread root
  // (thread_ts)を維持し、そうでなければこのmessage自身をthread root
  // として扱う(threadId = event.thread_ts ?? event.ts)。
  const threadId =
    typeof event.thread_ts === "string" && event.thread_ts.length > 0
      ? event.thread_ts
      : event.ts;

  const receivedAt =
    typeof envelope.event_time === "number" && Number.isFinite(envelope.event_time)
      ? new Date(envelope.event_time * 1000).toISOString()
      : new Date().toISOString();

  return {

    channel: "slack",

    actor: {
      externalUserId: event.user,
      // 絶対条件(Section13/22、BOT-P2.5 trusted boundary): tactUserId
      // は絶対に設定しない。trusted tactUserIdへの解決は既存
      // BotIdentityResolver(core/tact-bot/identity/)だけが行う。
    },

    conversation: {
      externalConversationId: event.channel,
      type: conversationType,
      threadId,
    },

    organizationId: typeof envelope.team_id === "string" ? envelope.team_id : undefined,

    messageId: event.ts,

    text,

    mentionedTact: true,

    receivedAt,

  };

}
