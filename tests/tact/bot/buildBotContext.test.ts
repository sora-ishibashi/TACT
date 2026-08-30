// =========================
// TACT Bot — buildBotContext Regression (BOT-P1)
// =========================
//
// 対象: core/tact-bot/context/buildBotContext.ts
//
// 環境制約: DOM/DB/実Slack・LINE APIには一切依存しない。
// LLM/Search API呼び出しも0(pure functionのみのCategory A Test)。

import "dotenv/config";
import { buildBotContext } from "../../../core/tact-bot/context/buildBotContext";
import type { BotIdentity, BotIncomingMessage } from "../../../core/tact-bot/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeMessage(overrides: Partial<BotIncomingMessage> = {}): BotIncomingMessage {

  return {
    channel: "slack",
    actor: { externalUserId: "U123" },
    conversation: { externalConversationId: "C123", type: "channel" },
    messageId: "m1",
    text: "@TACT 来週のイベントについて競合を調べて",
    mentionedTact: true,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // mention文字列除去
  // ==========================================================

  {
    const message = makeMessage({ text: "@TACT 来週のイベントについて競合を調べて" });
    const context = buildBotContext(message, null);

    results.push(
      check(
        "[Test1-1] 文頭の\"@TACT \"が取り除かれる",
        context.normalizedInput === "来週のイベントについて競合を調べて"
      )
    );
  }

  {
    const message = makeMessage({ text: "tact: 企画案を作って" });
    const context = buildBotContext(message, null);

    results.push(
      check(
        "[Test1-2] \"tact:\"(コロン区切り、大文字小文字を区別しない)も取り除かれる",
        context.normalizedInput === "企画案を作って"
      )
    );
  }

  // ==========================================================
  // mentionが無い場合はtextをそのまま(trimのみ)使う
  // ==========================================================

  {
    const message = makeMessage({ text: "  来週の予定を教えて  ", mentionedTact: false, conversation: { externalConversationId: "d1", type: "dm" } });
    const context = buildBotContext(message, null);

    results.push(
      check(
        "[Test2-1] mention文字列が無い場合、前後の空白のみtrimされ本文は変わらない",
        context.normalizedInput === "来週の予定を教えて"
      )
    );
  }

  // ==========================================================
  // message/identityがそのままcontextへ保持される
  // ==========================================================

  {
    const message = makeMessage();
    const identity: BotIdentity = { tactUserId: "tact-user-1" };
    const context = buildBotContext(message, identity);

    results.push(
      check(
        "[Test3-1] messageがそのままcontext.messageへ保持される",
        context.message === message
      )
    );

    results.push(
      check(
        "[Test3-2] identityがそのままcontext.identityへ保持される",
        context.identity === identity
      )
    );
  }

  results.push(
    check(
      "[Test3-3] identity未解決時はcontext.identityがnullになる(存在しないuserへfallbackしない)",
      buildBotContext(makeMessage(), null).identity === null
    )
  );

  // ==========================================================
  // 意図解釈・タスク分解を一切行わない(単純な文字列処理のみ)
  // ==========================================================

  results.push(
    check(
      "[Test4-1] 質問文でも命令文でも、文字列をそのまま渡すだけで解釈を追加しない",
      buildBotContext(makeMessage({ text: "@TACT トヨタについて調べて" }), null).normalizedInput ===
        "トヨタについて調べて"
    )
  );

  return summarize("bot/buildBotContext", results);

}
