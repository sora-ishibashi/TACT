// =========================
// TACT Bot — Conversation Connector (BOT-P2)
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
//   core/tact-conversation/orchestration.tsのrunConversationTurn()
//   (BOT-P2で追加。Web(app/api/tact/tact-conversations/route.ts)と
//   全く同じConversation解決+Orchestrator実行経路)
//     ↓
//   ConversationMessage / Conversation
//     ↓
//   BotAction[](reply / deliver_result)
//
// Security設計(BOT-P2投資調査、詳細はcore/database/
// supabaseServiceRole.tsのコメント参照): この関数はTACT userへの
// 書き込みをidentity解決済み(context.identity !== null)の場合のみ
// 行う。書き込みに使うuserIdは常にidentity resolver
// (core/tact-bot/identity/)がserver側で解決した`context.identity.
// tactUserId`であり、外部Channel messageが主張する値をそのまま
// 信用することはない。accessTokenにはservice role keyを使うが、
// この関数(および呼び出すrunConversationTurn→store.tsの各関数)は
// 常にuserIdによる明示的なフィルタを伴うため、RLSがbypassされても
// 他userのConversationへは到達しない。
//
// テスト容易性のため、実際の依存(runConversationTurn・
// conversation link store・service role key)はConstructor Injection
// する(createConversationBotCoreConnector())。本番配線は
// createSupabaseConversationBotCoreConnector()が行う
// (BOT-P1のnotConnectedConnector.tsと同じ「pure logicとreal wiringを
// 分離する」方針)。

import type {
  RunConversationTurnParams,
  RunConversationTurnResult,
} from "../../tact-conversation";
import { runConversationTurn } from "../../tact-conversation";
import { getServiceRoleKey } from "../../database/supabaseServiceRole";
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

  runTurn: (params: RunConversationTurnParams) => Promise<RunConversationTurnResult>;

  findLink: (params: ConversationLinkLookup) => Promise<string | null>;

  createLink: (params: ConversationLinkCreate) => Promise<boolean>;

  // service role key(またはBOT-P2以降の他の実行用token)。nullの場合、
  // 「Botの実行基盤が未設定」として安全に停止する(typed boundary
  // fallback、Coreへは一切書き込まない)。
  getAccessToken: () => string | null;

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
  turn: Extract<RunConversationTurnResult, { ok: true }>,
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

      // identity未解決 → 業務実行しない(絶対条件)。
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

      const accessToken = deps.getAccessToken();

      // Bot専用実行基盤(service role key)が未設定 → 安全に停止する
      // (typed boundary fallback、Coreへは一切書き込まない)。
      if (!accessToken) {

        return [
          {
            kind: "reply",
            target,
            inReplyToMessageId,
            text: "TACTとの接続はまだ設定が完了していません。しばらくお待ちください。",
          },
        ];

      }

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

      let turn = await deps.runTurn({
        userId: context.identity.tactUserId,
        accessToken,
        content: context.normalizedInput,
        conversationId: existingTactConversationId ?? undefined,
      });

      // Link先のConversationが既に存在しない(削除済み等)場合のみ、
      // 新規Conversationとして1回だけ再試行する(無限retryはしない)。
      if (!turn.ok && existingTactConversationId) {

        turn = await deps.runTurn({
          userId: context.identity.tactUserId,
          accessToken,
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
    runTurn: runConversationTurn,
    findLink: findConversationLink,
    createLink: createConversationLink,
    getAccessToken: getServiceRoleKey,
    accountLinkingUrl: options.accountLinkingUrl,
  });

}
