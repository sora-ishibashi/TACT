// =========================
// TACT Bot — receiveBotMessage (BOT-P1)
// =========================
//
// TACT Botの狭い入口。概念的な流れ:
//
//   receiveBotMessage
//     ↓
//   identity resolver
//     ↓
//   buildBotContext
//     ↓
//   TACT Core / Orchestrator(BotCoreConnector、BOT-P1はtyped boundary
//     のみ。実装はBOT-P2)
//     ↓
//   BotAction[]
//
// ChannelAdapter.normalizeIncoming()が既に正規化済みのBotIncomingMessage
// を渡す前提(platform固有のpayload解析はここでは一切行わない)。
//
// 「反応すべきかどうか」の判定(shouldHandle、mention有無・DM判定)は
// Slack Bot等が一般的に持つprotocol上の慣習(mentionが無いchannel
// 発言には反応しない)であり、業務上の意思決定(タスク分解・Product
// 選択等)ではないため、gateway層のdeterministicな判定として扱う。

import type { BotAction, BotContext, BotIncomingMessage } from "../types";
import { buildBotContext } from "../context/buildBotContext";
import {
  unresolvedIdentityResolver,
  type BotIdentityResolver,
} from "../identity/resolver";
import { createNotConnectedCoreConnector } from "../connector/notConnectedConnector";
import type { BotCoreConnector } from "../connector/types";

export interface BotGatewayDependencies {

  // 省略時はunresolvedIdentityResolver(常にnull)を使う。
  identityResolver?: BotIdentityResolver;

  // 省略時はcreateNotConnectedCoreConnector()(BOT-P1 default、
  // 実Core接続なし)を使う。BOT-P2で実Orchestrator接続実装へ
  // 差し替える想定の差し込み口。
  coreConnector?: BotCoreConnector;

}

export type ReceiveBotMessageIgnoredReason = "not_mentioned" | "empty_text";

export interface ReceiveBotMessageResult {

  handled: boolean;

  // handled=falseの場合のみ設定される。
  reason?: ReceiveBotMessageIgnoredReason;

  // handled=trueの場合のみ設定される。
  context?: BotContext;

  actions: BotAction[];

}

// DMは常に応答対象。channel/group発言は明示的なmentionが無い限り
// 応答対象にしない(既存のSlack Bot等の一般的なprotocol慣習)。
function shouldHandle(message: BotIncomingMessage): boolean {

  if (message.conversation.type === "dm") {
    return true;
  }

  return message.mentionedTact;

}

export async function receiveBotMessage(
  message: BotIncomingMessage,
  deps: BotGatewayDependencies = {}
): Promise<ReceiveBotMessageResult> {

  const identityResolver = deps.identityResolver ?? unresolvedIdentityResolver;
  const coreConnector = deps.coreConnector ?? createNotConnectedCoreConnector();

  if (!shouldHandle(message)) {
    return { handled: false, reason: "not_mentioned", actions: [] };
  }

  if (!message.text || !message.text.trim()) {
    return { handled: false, reason: "empty_text", actions: [] };
  }

  // BOT-P2: identity lookupはworkspace/team scope込みで行う
  // (同じexternalUserIdでもorganizationId(platform側のteam/workspace
  // 識別子)が異なれば別人でありうるため、identity/resolver.ts参照)。
  const identity = await identityResolver.resolve(
    message.actor,
    message.channel,
    message.organizationId
  );
  const context = buildBotContext(message, identity);
  const actions = await coreConnector.handle(context);

  return { handled: true, context, actions };

}
