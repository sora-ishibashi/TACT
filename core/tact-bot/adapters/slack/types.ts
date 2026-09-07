// =========================
// TACT Bot — Slack Adapter Raw Types (S1a)
// =========================
//
// Slack Events APIのraw payloadのうち、S1a(app_mention MVP)が実際に
// 参照するfieldだけを持つ最小限の型。Slack公式SDK型定義を持ち込まず、
// 巨大なSlack event union(reaction/message.im/shortcut等)も定義しない
// (絶対条件: 巨大なSlack abstractionを作らない、MVPで必要な
// app_mentionだけを扱う)。
//
// これらの型はcore/tact-bot/adapters/slack/配下だけで使う想定であり、
// core/tact-bot/types.ts(platform非依存のcanonical型)へは一切混入
// させない。

export interface SlackUrlVerificationEnvelope {

  type: "url_verification";

  challenge: string;

  token?: string;

}

// app_mention eventのうち、S1aが参照するfieldのみ。それ以外の
// field(blocks等)は無視する(型としても持たない)。
export interface SlackAppMentionEvent {

  type: "app_mention";

  // 投稿者のSlack user ID。TACT側はこれをexternal identifierとしてのみ
  // 扱う(絶対条件: tactUserIdとして直接使わない)。
  user?: string;

  text?: string;

  // このmessage自身のtimestamp(Slackの実質的なmessage ID)。
  ts?: string;

  channel?: string;

  // 既にthread内でのmentionの場合のみ設定される、thread rootのts。
  thread_ts?: string;

  // Bot自身が投稿したmessageのecho判定用(絶対条件: bot loop防止)。
  bot_id?: string;

  subtype?: string;

}

export interface SlackEventCallbackEnvelope {

  type: "event_callback";

  // Slack workspace(team)識別子。BotIncomingMessage.organizationIdへ
  // そのまま渡す(TACT Organization概念とは別の、外部platform由来の
  // 生の識別子)。
  team_id?: string;

  // dedup(event_id-based atomic claim)に使う、Slack側が発行する
  // event単位の一意識別子。
  event_id?: string;

  // Unix epoch seconds。BotIncomingMessage.receivedAtの計算に使う
  // (無ければadapter受信時刻へfallback)。
  event_time?: number;

  event?: SlackAppMentionEvent | Record<string, unknown>;

}

// Slack Events APIのtop-level envelope。url_verification/event_callback
// 以外のtypeも技術的には存在しうるため、判別できない場合に備えた
// 緩いfallbackも許容する(normalizeSlackEvent.ts側で型guardする)。
export type SlackEventEnvelope =
  | SlackUrlVerificationEnvelope
  | SlackEventCallbackEnvelope
  | { type?: string; [key: string]: unknown };
