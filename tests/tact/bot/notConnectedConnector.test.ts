// =========================
// TACT Bot — Not-Connected Core Connector Regression (BOT-P1)
// =========================
//
// 対象: core/tact-bot/connector/notConnectedConnector.ts
// (createNotConnectedCoreConnector())。
//
// 環境制約: 実Orchestrator/実LLM/実Search APIは一切呼ばない
// (このconnector自体がBOT-P1のdefaultであり、実Core接続を持たない)。

import "dotenv/config";
import { createNotConnectedCoreConnector } from "../../../core/tact-bot/connector/notConnectedConnector";
import { buildBotContext } from "../../../core/tact-bot/context/buildBotContext";
import type { BotIdentity, BotIncomingMessage } from "../../../core/tact-bot/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeMessage(overrides: Partial<BotIncomingMessage> = {}): BotIncomingMessage {

  return {
    channel: "slack",
    actor: { externalUserId: "U123" },
    conversation: { externalConversationId: "C123", type: "dm" },
    messageId: "m1",
    text: "@TACT こんにちは",
    mentionedTact: true,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const connector = createNotConnectedCoreConnector();

  // ==========================================================
  // identity未解決
  // ==========================================================

  {
    const context = buildBotContext(makeMessage(), null);
    const actions = await connector.handle(context);

    results.push(
      check(
        "[Test1-1] identity未解決時、reply Actionを1件だけ返す(業務判断・LLM呼び出しをしない決定論的応答)",
        actions.length === 1 && actions[0].kind === "reply"
      )
    );

    results.push(
      check(
        "[Test1-2] 未連携である旨のメッセージを含む",
        actions[0].kind === "reply" && actions[0].text.includes("連携")
      )
    );

    results.push(
      check(
        "[Test1-3] targetが元messageのchannel/conversation/actorと一致する",
        actions[0].target.channel === "slack" &&
          actions[0].target.conversation.externalConversationId === "C123" &&
          actions[0].target.actor?.externalUserId === "U123"
      )
    );

    results.push(
      check(
        "[Test1-4] inReplyToMessageIdが元messageのmessageIdと一致する",
        actions[0].inReplyToMessageId === "m1"
      )
    );

  }

  // ==========================================================
  // identity解決済み
  // ==========================================================

  {
    const identity: BotIdentity = { tactUserId: "tact-user-1" };
    const context = buildBotContext(makeMessage(), identity);
    const actions = await connector.handle(context);

    results.push(
      check(
        "[Test2-1] identity解決済みでも、実Orchestratorへは接続せず準備中replyを1件返す",
        actions.length === 1 && actions[0].kind === "reply" && actions[0].text.includes("準備中")
      )
    );

  }

  // ==========================================================
  // 決定論性
  // ==========================================================

  {
    const context = buildBotContext(makeMessage(), null);
    const first = await connector.handle(context);
    const second = await connector.handle(context);

    results.push(
      check(
        "[Test3-1] 同じcontextなら常に同じ結果(決定論的、業務判断を含まない)",
        JSON.stringify(first) === JSON.stringify(second)
      )
    );

  }

  return summarize("bot/notConnectedConnector", results);

}
