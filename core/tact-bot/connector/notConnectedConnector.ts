// =========================
// TACT Bot — Not-Connected Core Connector (BOT-P1 default)
// =========================
//
// BOT-P1のdefault BotCoreConnector実装。実Orchestrator/Conversationへ
// は接続していない(理由はconnector/types.ts参照、BOT-P2のscope)。
// identityの解決状況に応じた決定論的な案内replyを1件返すだけで、
// LLM呼び出し・業務判断は一切行わない(絶対条件: Bot独自のLLM
// reasoning/Agent orchestrationを持たない)。
//
// BOT-P2では、このfactory関数と同じBotCoreConnector interfaceを満たす
// 別の実装(例: createOrchestratorCoreConnector())を用意し、
// receiveBotMessage()のdepsへ差し替えるだけで実Core接続へ切り替えられる
// (gateway側のロジック変更は不要)。

import type { BotAction, BotActionTarget, BotContext } from "../types";
import type { BotCoreConnector } from "./types";

function targetFor(context: BotContext): BotActionTarget {

  return {
    channel: context.message.channel,
    conversation: context.message.conversation,
    actor: context.message.actor,
  };

}

export function createNotConnectedCoreConnector(): BotCoreConnector {

  return {

    async handle(context: BotContext): Promise<BotAction[]> {

      const target = targetFor(context);
      const inReplyToMessageId = context.message.messageId;

      if (!context.identity) {

        return [
          {
            kind: "reply",
            target,
            inReplyToMessageId,
            text:
              "このアカウントはまだTACTと連携されていません。連携が完了すると、" +
              "この会話からTACTへ依頼できるようになります。",
          },
        ];

      }

      return [
        {
          kind: "reply",
          target,
          inReplyToMessageId,
          text: "TACTとの接続は準備中です。もうしばらくお待ちください。",
        },
      ];

    },

  };

}
