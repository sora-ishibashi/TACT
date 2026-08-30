// =========================
// TACT Bot — Channel Adapter Boundary (BOT-P1)
// =========================
//
// Slack/LINE/Teams/Discord等、platform固有のAPI通信・payload形式は
// このinterfaceを実装するAdapter側(BOT-P2以降、core/tact-bot/adapters/
// 配下)に閉じ込める。core/tact-bot/gateway/以下はChannelAdapterの
// interfaceだけを知っていればよく、platform固有の実装詳細を一切
// 意識しない。
//
// 今回(BOT-P1)はinterfaceのみを定義する。Slack API/LINE Messaging
// APIへの実通信は実装しない(「今回やらないもの」参照)。

import type {
  BotAction,
  BotActionDeliveryResult,
  BotChannel,
  BotIncomingMessage,
} from "../types";

export interface ChannelAdapter {

  readonly channel: BotChannel;

  // platform固有のwebhook payload(型不明のためunknownで受ける)を
  // platform非依存のBotIncomingMessageへ正規化する。
  //
  // nullを返す場合: そのpayloadがそもそも「処理対象のuser message」
  // ではないことを表す(例: Botが送信した自分自身のmessageの
  // echo、リアクション等の非message event、購読していないevent種別)。
  // これはgateway側での「反応すべきか」の業務判断ではなく、
  // 「そもそもBotIncomingMessageとして成立するpayloadかどうか」という
  // platform protocol上の判定であり、Adapter側の責務とする。
  normalizeIncoming(rawPayload: unknown): BotIncomingMessage | null;

  // BotActionをplatform固有のAPI呼び出しへ変換して配送する。
  executeAction(action: BotAction): Promise<BotActionDeliveryResult>;

}

// executeBotActions()が、Action.target.channelに応じて適切な
// ChannelAdapterを引けるようにするための最小限のregistry型。
// 未登録channelは単純に存在しない(Partial)。
export type ChannelAdapterRegistry = Partial<Record<BotChannel, ChannelAdapter>>;
