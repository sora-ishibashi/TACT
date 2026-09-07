// =========================
// TACT Bot — Slack app_mention Normalization Regression (S1a)
// =========================
//
// 対象: core/tact-bot/adapters/slack/normalizeSlackEvent.tsの
// normalizeSlackAppMentionEvent()/isAppMentionEventCallback()/
// isBotEchoEvent()。純粋関数(DBアクセス・Slack APIアクセスなし)。

import {
  isAppMentionEventCallback,
  isBotEchoEvent,
  normalizeSlackAppMentionEvent,
} from "../../../core/tact-bot/adapters/slack/normalizeSlackEvent";
import type { SlackEventCallbackEnvelope } from "../../../core/tact-bot/adapters/slack/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeEnvelope(overrides: Partial<SlackEventCallbackEnvelope> = {}): SlackEventCallbackEnvelope {
  return {
    type: "event_callback",
    team_id: "T123TEAM",
    event_id: "Ev123",
    event_time: 1893456000,
    event: {
      type: "app_mention",
      user: "U123USER",
      text: "<@U999TACTBOT> OpenAIについて調べて",
      ts: "1893456000.000100",
      channel: "C123CHANNEL",
    },
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case A/B/C/D/E/F/G/H/I: valid app_mention -> 正しいBotIncomingMessage ----
  {
    const envelope = makeEnvelope();
    const message = normalizeSlackAppMentionEvent(envelope);

    results.push(
      check(
        "[Case A] valid app_mentionはnullではなくBotIncomingMessageを返す",
        message !== null
      )
    );

    results.push(
      check(
        "[Case B] mention token(<@U999TACTBOT>)が除去され、実際の依頼テキストだけが残る",
        message?.text === "OpenAIについて調べて"
      )
    );

    results.push(
      check(
        "[Case C] actor.externalUserIdがevent.userと一致する",
        message?.actor.externalUserId === "U123USER"
      )
    );

    results.push(
      check(
        "[Case D] actor.tactUserIdは絶対に設定されない(BOT-P2.5 trusted boundary、identity解決はBotIdentityResolverだけが行う)",
        message?.actor.tactUserId === undefined
      )
    );

    results.push(
      check(
        "[Case E] organizationIdがevent envelopeのteam_idと一致する",
        message?.organizationId === "T123TEAM"
      )
    );

    results.push(
      check(
        "[Case F] conversation.externalConversationIdがevent.channelと一致する",
        message?.conversation.externalConversationId === "C123CHANNEL"
      )
    );

    results.push(
      check(
        "[Case G] thread_tsが無い場合、threadId = event.ts(このmessage自身がthread rootになる)",
        message?.conversation.threadId === "1893456000.000100"
      )
    );

    results.push(
      check(
        "[Case H] messageId = event.ts",
        message?.messageId === "1893456000.000100"
      )
    );

    results.push(
      check(
        "[Case I] mentionedTact === true(app_mention eventは常にmention済み)",
        message?.mentionedTact === true
      )
    );

    results.push(
      check(
        "[Section10] channel === 'slack'、conversation.type === 'channel'(MVP scope: DM対象外)",
        message?.channel === "slack" && message?.conversation.type === "channel"
      )
    );
  }

  // ---- Case G(既存thread内): threadId = event.thread_ts ----
  {
    const envelope = makeEnvelope({
      event: {
        type: "app_mention",
        user: "U123USER",
        text: "<@U999TACTBOT> 続けて調べて",
        ts: "1893456100.000200",
        channel: "C123CHANNEL",
        thread_ts: "1893456000.000100",
      },
    });

    const message = normalizeSlackAppMentionEvent(envelope);

    results.push(
      check(
        "[Case G/既存thread] thread_tsがある場合、threadId = event.thread_ts(既存thread rootを維持、messageId自体はevent.tsのまま)",
        message?.conversation.threadId === "1893456000.000100" &&
          message?.messageId === "1893456100.000200"
      )
    );
  }

  // ---- Case J: bot event -> null ----
  {
    const withBotId = makeEnvelope({
      event: {
        type: "app_mention",
        user: "U123USER",
        text: "echo",
        ts: "1893456000.000100",
        channel: "C123CHANNEL",
        bot_id: "B999BOT",
      },
    });

    const withSubtype = makeEnvelope({
      event: {
        type: "app_mention",
        user: "U123USER",
        text: "echo",
        ts: "1893456000.000100",
        channel: "C123CHANNEL",
        subtype: "bot_message",
      },
    });

    results.push(
      check(
        "[Case J] bot_idが付与されたeventはnullを返す(bot loop防止)",
        normalizeSlackAppMentionEvent(withBotId) === null &&
          isBotEchoEvent(withBotId.event as { bot_id?: string; subtype?: string; type: "app_mention" }) === true
      )
    );

    results.push(
      check(
        "[Case J] subtype==='bot_message'のeventもnullを返す",
        normalizeSlackAppMentionEvent(withSubtype) === null
      )
    );
  }

  // ---- Case K: unsupported event -> ignored(isAppMentionEventCallback:false) ----
  {
    const notEventCallback = { type: "url_verification", challenge: "x" };
    const wrongEventType = makeEnvelope({ event: { type: "message" } as never });
    const missingEvent = makeEnvelope({ event: undefined });

    results.push(
      check(
        "[Case K] type!=='event_callback'はisAppMentionEventCallback:falseとして扱われる",
        isAppMentionEventCallback(notEventCallback) === false
      )
    );

    results.push(
      check(
        "[Case K] event.type!=='app_mention'(例: 'message')もfalseとして扱われる",
        isAppMentionEventCallback(wrongEventType) === false
      )
    );

    results.push(
      check(
        "[Case K] eventフィールド自体が無い場合もfalseとして扱われる",
        isAppMentionEventCallback(missingEvent) === false
      )
    );
  }

  // ---- Case L: mention除去後に空文字 -> Researchへ流さない(null) ----
  {
    const emptyAfterStripping = makeEnvelope({
      event: {
        type: "app_mention",
        user: "U123USER",
        text: "<@U999TACTBOT>",
        ts: "1893456000.000100",
        channel: "C123CHANNEL",
      },
    });

    results.push(
      check(
        "[Case L] mention token除去後に空文字になる場合、nullを返す(Researchへ空文字を流さない)",
        normalizeSlackAppMentionEvent(emptyAfterStripping) === null
      )
    );
  }

  // ---- 防御的: user/channel/ts欠落 ----
  {
    const noUser = makeEnvelope({ event: { type: "app_mention", text: "x", ts: "1", channel: "C1" } });
    const noChannel = makeEnvelope({ event: { type: "app_mention", user: "U1", text: "x", ts: "1" } });
    const noTs = makeEnvelope({ event: { type: "app_mention", user: "U1", text: "x", channel: "C1" } });

    results.push(
      check(
        "[防御的] event.user/channel/tsのいずれかが欠落している場合、例外を投げずnullを返す",
        normalizeSlackAppMentionEvent(noUser) === null &&
          normalizeSlackAppMentionEvent(noChannel) === null &&
          normalizeSlackAppMentionEvent(noTs) === null
      )
    );
  }

  // ---- receivedAt: event_timeから決定論的に導出 ----
  {
    const envelope = makeEnvelope();
    const message = normalizeSlackAppMentionEvent(envelope);

    results.push(
      check(
        "[receivedAt] event_time(unix epoch seconds)からISO文字列を導出する",
        message?.receivedAt === new Date(1893456000 * 1000).toISOString()
      )
    );
  }

  return summarize("bot/slackNormalizeEvent", results);

}
