// =========================
// TACT Bot — executeBotActions Regression (BOT-P1)
// =========================
//
// 対象: core/tact-bot/gateway/executeBotActions.ts
//
// 環境制約: 実Slack/実LINE API通信は一切行わない。fake ChannelAdapter
// (in-memory)のみを使う(Category B、Mock-based Evaluation)。

import "dotenv/config";
import { executeBotActions } from "../../../core/tact-bot/gateway/executeBotActions";
import type { ChannelAdapter, ChannelAdapterRegistry } from "../../../core/tact-bot/adapters/types";
import type {
  BotAction,
  BotActionDeliveryResult,
  BotIncomingMessage,
} from "../../../core/tact-bot/types";
import { check, summarize, type CheckResult } from "../lib/check";

function fakeSlackAdapter(options: { throwOnExecute?: boolean } = {}): {
  adapter: ChannelAdapter;
  delivered: BotAction[];
} {

  const delivered: BotAction[] = [];

  const adapter: ChannelAdapter = {

    channel: "slack",

    normalizeIncoming(rawPayload: unknown): BotIncomingMessage | null {

      // BOT-P1のfake実装: 「message的な形をしたpayloadかどうか」だけを
      // 判定する最小限のprotocol正規化(実Slack API形式は模倣しない)。
      if (
        !rawPayload ||
        typeof rawPayload !== "object" ||
        !("text" in rawPayload)
      ) {
        return null;
      }

      const payload = rawPayload as { text: string };

      return {
        channel: "slack",
        actor: { externalUserId: "U1" },
        conversation: { externalConversationId: "C1", type: "channel" },
        messageId: "m1",
        text: payload.text,
        mentionedTact: true,
        receivedAt: new Date().toISOString(),
      };

    },

    async executeAction(action: BotAction): Promise<BotActionDeliveryResult> {

      if (options.throwOnExecute) {
        throw new Error("simulated delivery failure");
      }

      delivered.push(action);

      return { ok: true, actionKind: action.kind };

    },

  };

  return { adapter, delivered };

}

function makeReplyAction(overrides: Partial<BotAction> = {}): BotAction {

  return {
    kind: "reply",
    target: {
      channel: "slack",
      conversation: { externalConversationId: "C1", type: "channel" },
    },
    text: "hello",
    ...overrides,
  } as BotAction;

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // ChannelAdapter.normalizeIncoming()契約: 関係ないpayloadはnull、
  // message的なpayloadはBotIncomingMessageへ正規化される
  // ==========================================================

  {
    const { adapter } = fakeSlackAdapter();

    results.push(
      check(
        "[Test0-1] message的でないpayloadはnullを返す(処理対象外として安全に無視)",
        adapter.normalizeIncoming({ type: "reaction_added" }) === null
      )
    );

    const normalized = adapter.normalizeIncoming({ text: "hello" });

    results.push(
      check(
        "[Test0-2] message的なpayloadはplatform非依存のBotIncomingMessageへ正規化される",
        normalized !== null && normalized.channel === "slack" && normalized.text === "hello"
      )
    );

  }

  // ==========================================================
  // 正常配送: target.channelに応じたAdapterへ振り分けられる
  // ==========================================================

  {
    const { adapter, delivered } = fakeSlackAdapter();
    const adapters: ChannelAdapterRegistry = { slack: adapter };

    const results1 = await executeBotActions([makeReplyAction()], adapters);

    results.push(
      check(
        "[Test1-1] 登録済みchannelのActionはAdapter.executeAction()経由で配送される",
        results1.length === 1 && results1[0].ok === true && delivered.length === 1
      )
    );

  }

  // ==========================================================
  // 未登録channel: 例外を投げずok:falseを返す
  // ==========================================================

  {
    const emptyAdapters: ChannelAdapterRegistry = {};
    const outcome = await executeBotActions([makeReplyAction()], emptyAdapters);

    results.push(
      check(
        "[Test2-1] 未登録channelのActionはok:falseで安全に失敗する(例外を投げない)",
        outcome.length === 1 && outcome[0].ok === false && !!outcome[0].error
      )
    );

  }

  // ==========================================================
  // Adapter側が例外を投げても、他のActionへ伝播しない
  // ==========================================================

  {
    const { adapter: throwingAdapter } = fakeSlackAdapter({ throwOnExecute: true });
    const { adapter: okAdapter, delivered } = fakeSlackAdapter();

    const adapters: ChannelAdapterRegistry = { slack: throwingAdapter, line: okAdapter };

    const actions: BotAction[] = [
      makeReplyAction({ target: { channel: "slack", conversation: { externalConversationId: "C1", type: "channel" } } }),
      { ...makeReplyAction(), target: { channel: "line", conversation: { externalConversationId: "C2", type: "channel" } } } as BotAction,
    ];

    const outcome = await executeBotActions(actions, adapters);

    results.push(
      check(
        "[Test3-1] Adapter側の例外はcatchされ、ok:falseとして表現される",
        outcome[0].ok === false && outcome[0].error === "simulated delivery failure"
      )
    );

    results.push(
      check(
        "[Test3-2] 1つのActionの配送失敗が他のActionの配送を妨げない(絶対条件)",
        outcome[1].ok === true && delivered.length === 1
      )
    );

  }

  // ==========================================================
  // 空配列は例外を投げず空配列を返す
  // ==========================================================

  results.push(
    check(
      "[Test4-1] actions=[]でも安全に空配列を返す",
      (await executeBotActions([], {})).length === 0
    )
  );

  return summarize("bot/executeBotActions", results);

}
