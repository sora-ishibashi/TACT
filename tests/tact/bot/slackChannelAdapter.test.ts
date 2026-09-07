// =========================
// TACT Bot — Slack ChannelAdapter Outbound Regression (S1c)
// =========================
//
// 対象: core/tact-bot/adapters/slack/slackChannelAdapter.tsの
// createSlackChannelAdapter().executeAction()。実@slack/web-api・
// live Slack API callには一切接続しない(SlackChannelAdapterDeps.client
// をfake実装へ差し替える)。
//
// 確認事項(S1c指示 Section24-27):
//   - reply BotAction -> chat.postMessage相当(fake client.postMessage)
//     が呼ばれる(A)
//   - channel mapping: target.conversation.externalConversationId
//     -> params.channel(B)
//   - thread_ts mapping: target.conversation.threadId
//     -> params.threadTs(C、未設定時はundefinedのまま)
//   - text mapping: action.text -> params.text(D)
//   - token非leakage: postMessage呼び出しparamsにtoken/secret相当の
//     fieldが一切含まれない(E)
//   - provider raw response非leakage: BotActionDeliveryResult.rawに
//     Slack rawレスポンス本体やHTTP detail等が含まれない、
//     sentChunks/totalChunksのみ(F)
//   - 複数chunk送信の途中失敗 -> partial_failure、以降のchunkを送らない
//     (絶対条件Section13、自動retryもしない)
//   - reply以外のBotAction kind -> unsupported_action_kindを返し、
//     postMessageを一切呼ばない(silent successへ変換しない、
//     絶対条件Section9)
//   - client未設定(not_configured) -> postMessageを一切呼ばない

import { createSlackChannelAdapter } from "../../../core/tact-bot/adapters/slack/slackChannelAdapter";
import type {
  SlackPostMessageParams,
  SlackPostMessageResult,
  SlackWebApiClient,
} from "../../../core/tact-bot/adapters/slack/slackClient";
import type { BotAction, BotActionTarget } from "../../../core/tact-bot/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeTarget(overrides: Partial<BotActionTarget["conversation"]> = {}): BotActionTarget {
  return {
    channel: "slack",
    conversation: {
      externalConversationId: "C_DEFAULT",
      type: "channel",
      ...overrides,
    },
  };
}

function makeReplyAction(overrides: Partial<BotAction> & { text?: string; target?: BotActionTarget } = {}): BotAction {
  return {
    kind: "reply",
    text: overrides.text ?? "調査結果: OpenAIの最近の動向についてまとめました。",
    target: overrides.target ?? makeTarget(),
  };
}

function makeFakeClient(
  behavior: (params: SlackPostMessageParams, callIndex: number) => SlackPostMessageResult
): { client: SlackWebApiClient; calls: SlackPostMessageParams[] } {

  const calls: SlackPostMessageParams[] = [];

  const client: SlackWebApiClient = {
    async postMessage(params) {
      calls.push(params);
      return behavior(params, calls.length - 1);
    },
  };

  return { client, calls };

}

function alwaysOk(tsPrefix = "ts"): (params: SlackPostMessageParams, callIndex: number) => SlackPostMessageResult {
  return (_params, callIndex) => ({ ok: true, ts: `${tsPrefix}-${callIndex}` });
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- A: reply BotAction -> postMessageが正確に1回呼ばれる(短文) ----
  {
    const { client, calls } = makeFakeClient(alwaysOk());
    const adapter = createSlackChannelAdapter({ client });

    const result = await adapter.executeAction(makeReplyAction());

    results.push(
      check(
        "[A] reply BotAction(短文)はpostMessageを正確に1回呼び、ok:trueを返す",
        calls.length === 1 && result.ok === true && result.actionKind === "reply"
      )
    );
  }

  // ---- B: channel mapping ----
  {
    const { client, calls } = makeFakeClient(alwaysOk());
    const adapter = createSlackChannelAdapter({ client });

    await adapter.executeAction(
      makeReplyAction({ target: makeTarget({ externalConversationId: "C999CHANNEL" }) })
    );

    results.push(
      check(
        "[B] target.conversation.externalConversationId('C999CHANNEL')がpostMessageのchannelへそのまま渡る",
        calls[0]?.channel === "C999CHANNEL"
      )
    );
  }

  // ---- C: thread_ts mapping(設定時/未設定時) ----
  {
    const { client, calls } = makeFakeClient(alwaysOk());
    const adapter = createSlackChannelAdapter({ client });

    await adapter.executeAction(
      makeReplyAction({ target: makeTarget({ threadId: "1893456000.000100" }) })
    );

    results.push(
      check(
        "[C-設定時] target.conversation.threadId('1893456000.000100')がpostMessageのthreadTsへそのまま渡る",
        calls[0]?.threadTs === "1893456000.000100"
      )
    );
  }
  {
    const { client, calls } = makeFakeClient(alwaysOk());
    const adapter = createSlackChannelAdapter({ client });

    await adapter.executeAction(makeReplyAction({ target: makeTarget() }));

    results.push(
      check(
        "[C-未設定時] threadIdが無い場合、postMessageのthreadTsはundefinedのまま(空文字等を捏造しない)",
        calls[0]?.threadTs === undefined
      )
    );
  }

  // ---- D: text mapping(短文はそのまま) ----
  {
    const { client, calls } = makeFakeClient(alwaysOk());
    const adapter = createSlackChannelAdapter({ client });

    await adapter.executeAction(makeReplyAction({ text: "hello world" }));

    results.push(
      check(
        "[D] action.text('hello world')がpostMessageのtextへそのまま渡る(追加LLM/要約なし)",
        calls[0]?.text === "hello world"
      )
    );
  }

  // ---- E: token/secret非leakage(postMessage paramsに channel/text/threadTs 以外のfieldが無い) ----
  {
    const { client, calls } = makeFakeClient(alwaysOk());
    const adapter = createSlackChannelAdapter({ client });

    await adapter.executeAction(makeReplyAction());

    const keys = Object.keys(calls[0] ?? {}).sort();

    results.push(
      check(
        "[E] postMessage呼び出しparamsのkeyはchannel/text/threadTsのみ(token/secret等のfieldを一切含まない、client boundary内でtokenを保持)",
        keys.join(",") === ["channel", "text", "threadTs"].sort().join(",")
      )
    );
  }

  // ---- F: provider raw response非leakage(BotActionDeliveryResult.rawはsentChunks/totalChunksのみ) ----
  {
    const { client } = makeFakeClient(() => ({ ok: true, ts: "1893456000.000200" }));
    const adapter = createSlackChannelAdapter({ client });

    const result = await adapter.executeAction(makeReplyAction());

    const rawKeys = result.raw && typeof result.raw === "object" ? Object.keys(result.raw).sort() : [];

    results.push(
      check(
        "[F] 成功時のBotActionDeliveryResult.rawはsentChunks/totalChunksのみを含み、Slack raw response(ts等)やHTTP detailを含まない",
        rawKeys.join(",") === ["sentChunks", "totalChunks"].sort().join(",")
      )
    );
  }

  // ---- 途中失敗: partial_failure、以降のchunkを送らない、自動retryしない ----
  {
    const longText = Array.from({ length: 10 }, (_, i) => `PARA${i}-${"a".repeat(500)}`).join("\n\n");

    const { client, calls } = makeFakeClient((_params, callIndex) => {
      if (callIndex === 1) {
        return { ok: false, error: "channel_not_found" };
      }
      return { ok: true, ts: `ts-${callIndex}` };
    });

    const adapter = createSlackChannelAdapter({ client });

    const result = await adapter.executeAction(makeReplyAction({ text: longText }));

    results.push(
      check(
        "[partial_failure] 2番目のchunk送信が失敗した場合、それ以降のchunkは送信されず(自動retryもせず)、ちょうど2回だけpostMessageが呼ばれる",
        calls.length === 2
      )
    );

    results.push(
      check(
        "[partial_failure] ok:false・error:'partial_failure'(1件以上送信済みでの失敗)を返す",
        result.ok === false && result.error === "partial_failure"
      )
    );

    results.push(
      check(
        "[partial_failure] raw.sentChunksは1(1件目は成功済み)、providerErrorCode('channel_not_found')はraw内にのみ含まれる(トップレベルerrorへ生のprovider詳細を出さない)",
        typeof result.raw === "object" &&
          result.raw !== null &&
          (result.raw as Record<string, unknown>).sentChunks === 1 &&
          (result.raw as Record<string, unknown>).providerErrorCode === "channel_not_found"
      )
    );
  }

  // ---- 1件目から失敗: delivery_failed ----
  {
    const { client, calls } = makeFakeClient(() => ({ ok: false, error: "not_in_channel" }));
    const adapter = createSlackChannelAdapter({ client });

    const result = await adapter.executeAction(makeReplyAction());

    results.push(
      check(
        "[全滅] 1件目から失敗した場合はerror:'delivery_failed'(partial_failureではない、まだ何も送信できていない)、postMessageは1回だけ呼ばれ自動retryしない",
        calls.length === 1 && result.ok === false && result.error === "delivery_failed"
      )
    );
  }

  // ---- 未対応BotAction kind -> silent successへ変換せず明示的にunsupported ----
  {
    const { client, calls } = makeFakeClient(alwaysOk());
    const adapter = createSlackChannelAdapter({ client });

    const notifyAction: BotAction = {
      kind: "notify_progress",
      stage: "researching",
      target: makeTarget(),
    };

    const result = await adapter.executeAction(notifyAction);

    results.push(
      check(
        "[絶対条件Section9] reply以外のBotAction kind(notify_progress)はpostMessageを一切呼ばず、ok:false・error:'unsupported_action_kind'を返す(silent success/業務action変換をしない)",
        calls.length === 0 && result.ok === false && result.error === "unsupported_action_kind" && result.actionKind === "notify_progress"
      )
    );
  }

  // ---- client未設定(not_configured) ----
  {
    const adapter = createSlackChannelAdapter({ client: null });

    const result = await adapter.executeAction(makeReplyAction());

    results.push(
      check(
        "[not_configured] SlackWebApiClientが利用できない場合、postMessageを試みず(呼びようがない)ok:false・error:'not_configured'を返す",
        result.ok === false && result.error === "not_configured"
      )
    );
  }

  return summarize("bot/slackChannelAdapter", results);

}
