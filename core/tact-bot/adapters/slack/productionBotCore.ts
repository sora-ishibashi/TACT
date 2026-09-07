import {
  receiveBotMessage,
  type BotGatewayDependencies,
  type ReceiveBotMessageResult,
} from "../../gateway/receiveMessage";
import { executeBotActions } from "../../gateway/executeBotActions";
import { supabaseBotIdentityResolver } from "../../identity/supabaseIdentityResolver";
import { createSupabaseConversationBotCoreConnector } from "../../connector/conversationConnector";
import type { BotCoreConnector } from "../../connector/types";
import type { BotIdentityResolver } from "../../identity/resolver";
import type { BotAction, BotActionDeliveryResult, BotIncomingMessage } from "../../types";
import type { ChannelAdapterRegistry } from "../types";
import { createSlackChannelAdapter } from "./slackChannelAdapter";

// =========================
// TACT Bot — Slack Production Bot Core Wiring (S1b)
// =========================
//
// core/tact-bot/gateway/receiveMessage.tsのreceiveBotMessage()は、
// deps省略時に安全側のdisconnected default
// (unresolvedIdentityResolver + createNotConnectedCoreConnector())を
// 使う(BOT-P1由来、既存test/他channelがこのglobal defaultへ依存して
// いる可能性があるため)。
//
// 絶対条件(S1b指示Section3): receiveBotMessage()自身のこのglobal
// defaultは変更しない。Slack productionだけが、このfileを経由して
// 明示的にSupabase-backed dependencies(BOT-P2/BOT-P2.5で確立済みの
// 既存実装、新しい重複factoryは作らない)を注入する。
//
//   identityResolver: core/tact-bot/identity/supabaseIdentityResolver.ts
//     のsupabaseBotIdentityResolver(tact_external_identitiesを検索、
//     BOT-P2)
//   coreConnector: core/tact-bot/connector/conversationConnector.tsの
//     createSupabaseConversationBotCoreConnector()(Trusted Bot
//     Execution Boundary経由でrunConversationTurn()まで到達する、
//     BOT-P2/BOT-P2.5)
//
// 絶対条件(S1b指示Section4、service role boundary): このfile自身は
// core/database/supabaseServiceRole.tsを一切importしない——service
// role keyの読み出しは既存の境界(core/tact-bot/identity/
// supabaseIdentityStore.ts・core/tact-bot/execution/
// trustedConversationTurn.ts)だけに閉じ込められたまま。このfileは
// それらを呼び出す既存実装(supabaseBotIdentityResolver/
// createSupabaseConversationBotCoreConnector())をそのまま再利用する
// だけであり、生のcredential文字列を一切扱わない。

// テスト容易性のため、実際に注入するidentity resolver/coreConnectorを
// named exportとして公開する(供給元が変わっていないことを参照等価性
// で確認できるようにするため)。
export const slackTrustedBotIdentityResolver: BotIdentityResolver = supabaseBotIdentityResolver;

// createSupabaseConversationBotCoreConnector()はstateを持たない
// factory(呼び出しごとにclosureを組み立てるだけ)のため、1回だけ
// 生成してキャッシュする(core/tact-integration/providers/composio/
// client.tsのgetComposioClient()と同じ「遅延生成+キャッシュ」既存
// パターン)。
export const slackTrustedBotCoreConnector: BotCoreConnector = createSupabaseConversationBotCoreConnector();

const defaultSlackTrustedBotCoreDeps: BotGatewayDependencies = {
  identityResolver: slackTrustedBotIdentityResolver,
  coreConnector: slackTrustedBotCoreConnector,
};

// core/tact-bot/gateway/receiveMessage.tsのreceiveBotMessage()を
// Slack production wiringで呼ぶための薄いwrapper。DI可能(testが
// identityResolver/coreConnectorをfakeへ差し替えられる)にしつつ、
// 省略時は上記のSupabase-backed実装を使う。receiveBotMessage()自体の
// business logic(shouldHandle判定・buildBotContext等)は一切複製
// しない。
export async function receiveSlackBotMessageAsTrustedActor(
  message: BotIncomingMessage,
  deps: BotGatewayDependencies = defaultSlackTrustedBotCoreDeps
): Promise<ReceiveBotMessageResult> {

  return receiveBotMessage(message, {
    identityResolver: deps.identityResolver ?? defaultSlackTrustedBotCoreDeps.identityResolver,
    coreConnector: deps.coreConnector ?? defaultSlackTrustedBotCoreDeps.coreConnector,
  });

}

// =========================
// Slack Outbound Wiring (S1c)
// =========================
//
// 絶対条件(Section8): BotAction[]をSlackへ配送する経路は、既存
// core/tact-bot/gateway/executeBotActions.ts(BotAction execution
// gateway、BOT-P1確立済み)を必ず経由する——Slack webhook handlerから
// 直接chat.postMessageを呼ばない。
//
// createSlackChannelAdapter()はstateを持たない(内部でSlack Web API
// clientを遅延解決するだけの)factoryのため、slackTrustedBotCoreConnector
// と同じ理由で1回だけ生成してキャッシュする。
export const slackTrustedChannelAdapter = createSlackChannelAdapter();

const defaultSlackChannelAdapterRegistry: ChannelAdapterRegistry = {
  slack: slackTrustedChannelAdapter,
};

// core/tact-bot/gateway/executeBotActions.tsをSlack production wiringで
// 呼ぶための薄いwrapper(receiveSlackBotMessageAsTrustedActor()と対に
// なる、outbound側の入口)。
export async function executeSlackBotActions(
  actions: BotAction[],
  adapters: ChannelAdapterRegistry = defaultSlackChannelAdapterRegistry
): Promise<BotActionDeliveryResult[]> {

  return executeBotActions(actions, adapters);

}
