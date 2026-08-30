// =========================
// TACT Bot — receiveBotMessage Gateway Regression (BOT-P1)
// =========================
//
// 対象: core/tact-bot/gateway/receiveMessage.ts(receiveBotMessage())。
// identity resolver → buildBotContext → BotCoreConnector という
// gatewayの一連の流れを、pluggableなdeps(fake resolver/connector)で
// 検証する。
//
// 環境制約: 実Slack/実LINE API・実Orchestrator・実LLM/実Search APIは
// 一切呼ばない。BotCoreConnectorはfake実装のみを使う
// (BOT-P1のscope外である実Core接続を、testでも前倒しで行わない)。

import "dotenv/config";
import { receiveBotMessage } from "../../../core/tact-bot/gateway/receiveMessage";
import type { BotIdentityResolver } from "../../../core/tact-bot/identity/resolver";
import type { BotCoreConnector } from "../../../core/tact-bot/connector/types";
import type { BotAction, BotIdentity, BotIncomingMessage } from "../../../core/tact-bot/types";
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

function fakeResolver(identity: BotIdentity | null): BotIdentityResolver {
  return {
    async resolve() {
      return identity;
    },
  };
}

function recordingConnector(): { connector: BotCoreConnector; calls: number[] } {

  const calls: number[] = [];

  const connector: BotCoreConnector = {
    async handle(context) {
      calls.push(1);
      const action: BotAction = {
        kind: "reply",
        target: {
          channel: context.message.channel,
          conversation: context.message.conversation,
        },
        text: `echo: ${context.normalizedInput}`,
      };
      return [action];
    },
  };

  return { connector, calls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // DMは常に応答対象(mentionedTact=falseでも)
  // ==========================================================

  {
    const message = makeMessage({
      conversation: { externalConversationId: "d1", type: "dm" },
      mentionedTact: false,
    });

    const result = await receiveBotMessage(message);

    results.push(
      check(
        "[Test1-1] DMはmentionedTact=falseでもhandled:trueになる",
        result.handled === true
      )
    );

  }

  // ==========================================================
  // channel発言でmentionが無ければ応答しない
  // ==========================================================

  {
    const message = makeMessage({
      conversation: { externalConversationId: "c1", type: "channel" },
      mentionedTact: false,
      text: "雑談メッセージ",
    });

    const result = await receiveBotMessage(message);

    results.push(
      check(
        "[Test2-1] channel発言でmentionが無い場合はhandled:false・reason:not_mentioned",
        result.handled === false && result.reason === "not_mentioned"
      )
    );

    results.push(
      check(
        "[Test2-2] 応答対象外の場合、actionsは空配列(=BotCoreConnectorを一切呼ばない)",
        result.actions.length === 0
      )
    );

  }

  // ==========================================================
  // group発言でmentionがあれば応答する
  // ==========================================================

  {
    const message = makeMessage({
      conversation: { externalConversationId: "g1", type: "group" },
      mentionedTact: true,
    });

    const result = await receiveBotMessage(message);

    results.push(
      check(
        "[Test3-1] group発言でmentionがある場合はhandled:true",
        result.handled === true
      )
    );

  }

  // ==========================================================
  // 空文字/空白のみのtextは応答しない
  // ==========================================================

  {
    const message = makeMessage({
      conversation: { externalConversationId: "d1", type: "dm" },
      text: "   ",
    });

    const result = await receiveBotMessage(message);

    results.push(
      check(
        "[Test4-1] 空白のみのtextはhandled:false・reason:empty_text",
        result.handled === false && result.reason === "empty_text"
      )
    );

  }

  // ==========================================================
  // pluggableなidentity resolver / coreConnectorが実際に使われる
  // ==========================================================

  {
    const identity: BotIdentity = { tactUserId: "tact-user-1" };
    const { connector, calls } = recordingConnector();

    const message = makeMessage({ text: "@TACT SROIについて教えて" });

    const result = await receiveBotMessage(message, {
      identityResolver: fakeResolver(identity),
      coreConnector: connector,
    });

    results.push(
      check(
        "[Test5-1] 注入したidentityResolverの解決結果がcontext.identityへ反映される",
        result.context?.identity?.tactUserId === "tact-user-1"
      )
    );

    results.push(
      check(
        "[Test5-2] 注入したcoreConnector.handle()が1回だけ呼ばれる",
        calls.length === 1
      )
    );

    results.push(
      check(
        "[Test5-3] coreConnectorが返したBotAction[]がそのままresult.actionsになる(gateway側で変換・判断を加えない)",
        result.actions.length === 1 &&
          result.actions[0].kind === "reply" &&
          result.actions[0].kind === "reply" &&
          (result.actions[0] as { text: string }).text === "echo: SROIについて教えて"
      )
    );

  }

  // ==========================================================
  // deps省略時はBOT-P1 defaultにfallbackする(常にnull identity、
  // not-connected connector)
  // ==========================================================

  {
    const message = makeMessage({ conversation: { externalConversationId: "d1", type: "dm" } });
    const result = await receiveBotMessage(message);

    results.push(
      check(
        "[Test6-1] deps省略時、identityはnull(unresolvedIdentityResolverが使われる)",
        result.context?.identity === null
      )
    );

    results.push(
      check(
        "[Test6-2] deps省略時、actionsはnot-connected connectorの決定論的replyになる(実Core接続なし)",
        result.actions.length === 1 && result.actions[0].kind === "reply"
      )
    );

  }

  return summarize("bot/receiveBotMessage", results);

}
