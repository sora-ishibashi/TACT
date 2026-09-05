// =========================
// TACT Bot — Conversation Connector (BOT-P2 / BOT-P2.5)
// =========================
//
// BotCoreConnector(BOT-P1のtyped boundary)の、実際のTACT
// Conversation/Orchestratorへ接続する実装。
//
//   BotContext
//     ↓ (identity未解決なら早期return)
//   外部thread ⇄ TACT conversation解決
//   (core/tact-bot/conversationLink/)
//     ↓
//   core/tact-bot/execution/trustedConversationTurn.tsの
//   runConversationTurnAsTrustedActor()
//   (BOT-P2.5、Trusted Bot Execution Boundary。内部では
//   core/tact-conversation/orchestration.tsのrunConversationTurn()
//   [shared conversation turn logic]を呼ぶ——Web
//   (app/api/tact/tact-conversations/route.ts)と全く同じConversation
//   解決+Orchestrator実行経路)
//     ↓
//   ConversationMessage / Conversation
//     ↓
//   BotAction[](reply / deliver_result)
//
// Security設計(BOT-P2.5): このfileはservice role keyという値を
// 一切扱わない(import・保持・DI経由での受け渡しのいずれも無い)。
// Trusted Bot Execution Boundary(core/tact-bot/execution/
// trustedConversationTurn.ts)だけがcore/database/
// supabaseServiceRole.tsを読み、rawなkey文字列をこのfileの外へ
// 渡さない。このfileはidentity解決済み(context.identity !== null)の
// 場合のみ、その`context.identity.tactUserId`(server-side identity
// resolverが検証済みの値、外部Channel messageが主張する値ではない)を
// 渡してTrusted Bot Execution Boundaryを呼び出すだけであり、
// Conversation business logic自体は一切複製しない。
//
// テスト容易性のため、実際の依存(trusted actor turn実行・
// conversation link store)はConstructor Injection する
// (createConversationBotCoreConnector())。本番配線は
// createSupabaseConversationBotCoreConnector()が行う
// (BOT-P1のnotConnectedConnector.tsと同じ「pure logicとreal wiringを
// 分離する」方針)。

import {
  runConversationTurnAsTrustedActor,
  type RunConversationTurnAsTrustedActorParams,
  type RunConversationTurnAsTrustedActorResult,
} from "../execution/trustedConversationTurn";
import {
  createConversationLink,
  findConversationLink,
} from "../conversationLink/supabaseConversationLinkStore";
import { isLinkableChannel, type LinkableBotChannel } from "../identity/supabaseIdentityStore";
import type { BotAction, BotActionTarget, BotContext } from "../types";
import type { BotCoreConnector } from "./types";

// =========================
// Dependencies (テスト用に差し替え可能にする)
// =========================

export interface ConversationLinkLookup {
  channel: LinkableBotChannel;
  externalConversationId: string;
  externalThreadId?: string;
}

export interface ConversationLinkCreate extends ConversationLinkLookup {
  tactConversationId: string;
}

export interface ConversationBotCoreConnectorDeps {

  // Trusted Bot Execution Boundary(core/tact-bot/execution/
  // trustedConversationTurn.ts)を呼ぶ。このinterfaceにaccessToken/
  // service role key等の生Credentialを表すfieldは存在しない
  // (BOT-P2.5絶対条件: このConnectorはCredentialという概念自体を
  // 扱わない)。
  runTrustedTurn: (
    params: RunConversationTurnAsTrustedActorParams
  ) => Promise<RunConversationTurnAsTrustedActorResult>;

  findLink: (params: ConversationLinkLookup) => Promise<string | null>;

  createLink: (params: ConversationLinkCreate) => Promise<boolean>;

  // 将来のaccount linking URL(BOT-P2ではSlack OAuth等の実UIは
  // 実装しない。文字列を差し込めるようにするだけ)。
  accountLinkingUrl?: string;

}

function targetFor(context: BotContext): BotActionTarget {

  return {
    channel: context.message.channel,
    conversation: context.message.conversation,
    actor: context.message.actor,
  };

}

function buildIdentityRequiredMessage(accountLinkingUrl?: string): string {

  const base = "このアカウントはまだTACTアカウントと連携されていません。連携が完了すると、この会話からTACTへ依頼できるようになります。";

  return accountLinkingUrl ? `${base}\n連携はこちら: ${accountLinkingUrl}` : base;

}

const RESULT_SUMMARY_MAX_LENGTH = 200;

function summarize(content: string): string {

  const trimmed = content.trim();

  return trimmed.length > RESULT_SUMMARY_MAX_LENGTH
    ? `${trimmed.slice(0, RESULT_SUMMARY_MAX_LENGTH)}...`
    : trimmed;

}

// ConversationTurnResult(core/tact-conversation)をBotAction[]へ変換する。
// 最低限の対応: 通常回答→reply、clarification→reply(質問文)、
// Artifactが紐付いた場合→deliver_result。それ以外の新しいAction種別
// (request_approval等)は今回作らない(BOT-P4のscope)。
function toBotActions(
  turn: Extract<RunConversationTurnAsTrustedActorResult, { ok: true }>,
  target: BotActionTarget,
  inReplyToMessageId: string
): BotAction[] {

  const { conversation, message } = turn;

  if (message.messageType === "clarification_question") {

    return [
      {
        kind: "reply",
        target,
        inReplyToMessageId,
        text: message.content,
      },
    ];

  }

  if (conversation.artifactId) {

    return [
      {
        kind: "deliver_result",
        target,
        inReplyToMessageId,
        summary: summarize(message.content),
        resultText: message.content,
        artifactId: conversation.artifactId,
      },
    ];

  }

  return [
    {
      kind: "reply",
      target,
      inReplyToMessageId,
      text: message.content,
    },
  ];

}

export function createConversationBotCoreConnector(
  deps: ConversationBotCoreConnectorDeps
): BotCoreConnector {

  return {

    async handle(context: BotContext): Promise<BotAction[]> {

      const target = targetFor(context);
      const inReplyToMessageId = context.message.messageId;

      // identity未解決 → 業務実行しない(絶対条件)。Trusted Bot
      // Execution Boundaryは一切呼ばない。
      if (!context.identity) {

        return [
          {
            kind: "reply",
            target,
            inReplyToMessageId,
            text: buildIdentityRequiredMessage(deps.accountLinkingUrl),
          },
        ];

      }

      const tactUserId = context.identity.tactUserId;

      const { channel, conversation: externalConversation } = context.message;
      const linkable = isLinkableChannel(channel);

      const linkLookup: ConversationLinkLookup | undefined = linkable
        ? {
            channel,
            externalConversationId: externalConversation.externalConversationId,
            externalThreadId: externalConversation.threadId,
          }
        : undefined;

      const existingTactConversationId = linkLookup
        ? await deps.findLink(linkLookup)
        : null;

      let turn = await deps.runTrustedTurn({
        tactUserId,
        content: context.normalizedInput,
        conversationId: existingTactConversationId ?? undefined,
      });

      // Bot専用のTrusted Bot Execution Boundaryが未設定(service role
      // key未設定)の場合、retryせず即座に安全なmessageを返す
      // (「未設定」はConversationの状態とは無関係なため、
      // conversationId無しで再試行しても意味が無い)。
      if (!turn.ok && turn.error === "trusted_execution_not_configured") {

        return [
          {
            kind: "reply",
            target,
            inReplyToMessageId,
            text: "TACTとの接続はまだ設定が完了していません。しばらくお待ちください。",
          },
        ];

      }

      // Link先のConversationが既に存在しない(削除済み・他userへの
      // 誤ったlink等)場合のみ、新規Conversationとして1回だけ再試行
      // する(無限retryはしない。stale/wrongなlinkが他userの
      // Conversationへのアクセスを許すことはない——
      // runConversationTurnAsTrustedActor()→runConversationTurn()の
      // getConversation()呼び出しは常にtactUserIdによる所有者確認を
      // 経由するため、他user所有のconversationIdは"conversation_not_
      // found"として拒否される、詳細はcore/tact-conversation/
      // orchestration.ts参照)。
      if (!turn.ok && turn.error === "conversation_not_found" && existingTactConversationId) {

        turn = await deps.runTrustedTurn({
          tactUserId,
          content: context.normalizedInput,
        });

      }

      if (!turn.ok) {

        return [
          {
            kind: "reply",
            target,
            inReplyToMessageId,
            text: "依頼の処理中に問題が発生しました。時間をおいて再度お試しください。",
          },
        ];

      }

      if (linkLookup) {

        await deps.createLink({
          ...linkLookup,
          tactConversationId: turn.conversation.id,
        });

      }

      return toBotActions(turn, target, inReplyToMessageId);

    },

  };

}

// =========================
// 本番配線 (BOT-P2)
// =========================

export interface CreateSupabaseConversationBotCoreConnectorOptions {
  accountLinkingUrl?: string;
}

export function createSupabaseConversationBotCoreConnector(
  options: CreateSupabaseConversationBotCoreConnectorOptions = {}
): BotCoreConnector {

  return createConversationBotCoreConnector({
    runTrustedTurn: runConversationTurnAsTrustedActor,
    findLink: findConversationLink,
    createLink: createConversationLink,
    accountLinkingUrl: options.accountLinkingUrl,
  });

}
