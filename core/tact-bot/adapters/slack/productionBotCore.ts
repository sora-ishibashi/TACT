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
import type {
  BotAction,
  BotActionDeliveryResult,
  BotActionTarget,
  BotApprovalDecision,
  BotApprovalDecisionKind,
  BotIncomingMessage,
} from "../../types";
import type { ChannelAdapterRegistry } from "../types";
import { createSlackChannelAdapter } from "./slackChannelAdapter";
import {
  resolvePendingApprovalForThread as defaultResolvePendingApprovalForThread,
  type ResolvePendingApprovalForThreadResult,
} from "../../execution/resolvePendingApprovalForThread";
import {
  receiveBotApprovalDecision as defaultReceiveBotApprovalDecision,
  type ReceiveBotApprovalDecisionResult,
} from "../../gateway/receiveApprovalDecision";

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

// =========================
// Slack Text Approval Decision Wiring (S1e)
// =========================
//
// 「承認」/「却下」というdeterministicなSlack inbound textを、
// canonical core/tact-bot/gateway/receiveApprovalDecision.tsの
// receiveBotApprovalDecision()へ接続する。receiveSlackBotMessage
// AsTrustedActor()と対になる、decision専用の入口。
//
// 絶対条件(S1e Step6、最重要): このfile自身は既存の
// core/tact-bot/identity/(supabaseBotIdentityResolver)をそのまま
// 再利用する——独自のidentity解決を実装しない。identity解決は
// 2箇所で行われる(ここで1回、pending Approval解決のためのtactUserId
// として。receiveBotApprovalDecision()内部でもう1回、canonical
// gatewayの既存契約通り)——同じresolver・同じ外部actorに対する
// 決定論的な解決のため、二重呼び出し自体は安全(冪等)であり、
// receiveBotApprovalDecision()自身の既存contractを一切変更しない
// ことを優先する。

export interface ReceiveSlackBotApprovalDecisionResult {

  handled: boolean;

  actions: BotAction[];

}

export interface ReceiveSlackBotApprovalDecisionDeps {

  identityResolver: BotIdentityResolver;

  resolvePendingApprovalForThread: typeof defaultResolvePendingApprovalForThread;

  receiveBotApprovalDecision: (
    decision: BotApprovalDecision,
    deps?: { identityResolver?: BotIdentityResolver }
  ) => Promise<ReceiveBotApprovalDecisionResult>;

}

const defaultSlackApprovalDecisionDeps: ReceiveSlackBotApprovalDecisionDeps = {
  identityResolver: slackTrustedBotIdentityResolver,
  resolvePendingApprovalForThread: defaultResolvePendingApprovalForThread,
  receiveBotApprovalDecision: defaultReceiveBotApprovalDecision,
};

function buildTarget(message: BotIncomingMessage): BotActionTarget {
  return {
    channel: message.channel,
    conversation: message.conversation,
    actor: message.actor,
  };
}

// 絶対条件(Step10): pending Approval解決に失敗した場合の安全な固定
// 文言。raw internal reason(conversation_link_missing等)・
// approvalId・workId・taskId等は一切含めない。
function buildResolutionFailureMessage(
  resolution: Exclude<ResolvePendingApprovalForThreadResult, { status: "resolved" }>
): string {

  switch (resolution.status) {

    case "trusted_execution_not_configured":
      return "現在この操作を処理できません。しばらくお待ちください。";

    case "conversation_link_missing":
    case "work_missing":
    case "no_pending_approval":
      return "承認待ちの操作が見つかりませんでした。";

    case "ambiguous_pending_approval":
      return "承認待ちの操作が複数あるため、自動では判定できません。担当者にご確認ください。";

    default: {
      const exhaustiveCheck: never = resolution;
      return exhaustiveCheck;
    }

  }

}

// 絶対条件(S1e Step2/3/6): この関数はSlack inbound textが既に
// detectApprovalDecisionText()でapprove/rejectと判定済みであることを
// 前提とする(呼び出し元core/tact-bot/adapters/slack/
// handleSlackWebhookRequest.tsが判定する、この関数自体はtext判定を
// 行わない——責務分離)。通常Conversation/LLM経路(receiveSlackBot
// MessageAsTrustedActor())へは絶対にfallbackしない
// (呼び出し元がどちらを呼ぶかを決定済みのため、この関数の中では
// 分岐しない)。
export async function receiveSlackBotApprovalDecisionAsTrustedActor(
  message: BotIncomingMessage,
  decisionKind: BotApprovalDecisionKind,
  deps: ReceiveSlackBotApprovalDecisionDeps = defaultSlackApprovalDecisionDeps
): Promise<ReceiveSlackBotApprovalDecisionResult> {

  const target = buildTarget(message);

  // BOT-P2.5と同じ順序: external identity → trusted tactUserId
  // resolution。外部Slack user idをそのままtactUserIdとして使わない
  // (絶対条件3/4)。
  const identity = await deps.identityResolver.resolve(message.actor, message.channel);

  if (!identity) {

    return {
      handled: false,
      actions: [
        {
          kind: "reply",
          target,
          inReplyToMessageId: message.messageId,
          text: "このアカウントはまだTACTアカウントと連携されていません。連携後にもう一度お試しください。",
        },
      ],
    };

  }

  // 絶対条件(Step4/6): Approval IDをuser inputから受け取らない。
  // thread相関(channel + externalConversationId + externalThreadId)
  // だけからpending Approvalを解決する。このfile自身はSlack専用
  // (channel="slack"で固定)。
  const resolution = await deps.resolvePendingApprovalForThread({
    tactUserId: identity.tactUserId,
    channel: "slack",
    externalConversationId: message.conversation.externalConversationId,
    externalThreadId: message.conversation.threadId,
  });

  if (resolution.status !== "resolved") {

    return {
      handled: false,
      actions: [
        {
          kind: "reply",
          target,
          inReplyToMessageId: message.messageId,
          text: buildResolutionFailureMessage(resolution),
        },
      ],
    };

  }

  // 絶対条件(Step7、最重要): approveApproval()/rejectApproval()/
  // executeApprovedIntegrationAction()をSlack adapterから直接
  // 呼ばない。必ずcanonical receiveBotApprovalDecision()経由で到達
  // させる(P1c Approval Integrity verification boundaryを含め、
  // 一切変更しない)。
  const botApprovalDecision: BotApprovalDecision = {
    channel: message.channel,
    actor: message.actor,
    target,
    workId: resolution.workId,
    approvalId: resolution.approval.id,
    decision: decisionKind,
    inReplyToMessageId: message.messageId,
  };

  const result = await deps.receiveBotApprovalDecision(botApprovalDecision, {
    identityResolver: deps.identityResolver,
  });

  return { handled: result.handled, actions: result.actions };

}
