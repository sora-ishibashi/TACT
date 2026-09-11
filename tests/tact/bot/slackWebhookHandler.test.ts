// =========================
// TACT Bot — Slack Webhook Handler Regression (S1a)
// =========================
//
// 対象: core/tact-bot/adapters/slack/handleSlackWebhookRequest.tsの
// handleSlackWebhookRequest()。実Supabase・実Slack API・実
// receiveBotMessage()内部実装(identity解決/Conversation実行)には
// 一切接続しない(HandleSlackWebhookRequestDeps経由で
// getSigningSecret/claimExternalEvent/receiveBotMessage/
// scheduleBackgroundWorkを偽実装に差し替える)。
//
// 最重要確認事項:
//   - 署名検証前にDBへ一切触れない(claimExternalEvent呼び出し0)
//   - Slack raw payload/user message本文がdedup呼び出しへ含まれない
//   - duplicate/storage failure時、receiveBotMessage()が一切呼ばれない
//   - storage failure時は500(fail closed)、duplicate時は200
//   - ACKはreceiveBotMessage()の完了を待たずに返る
//     (scheduleBackgroundWorkへ委譲、直接awaitしない)
//   - actor.externalUserIdのみ設定され、actor.tactUserIdは
//     一切設定されない

import { createHmac } from "node:crypto";
import {
  handleSlackWebhookRequest,
  type HandleSlackWebhookRequestDeps,
  type SlackWebhookHeaders,
} from "../../../core/tact-bot/adapters/slack/handleSlackWebhookRequest";
import type { ClaimExternalEventResult } from "../../../core/tact-bot/eventDedup/supabaseEventDedupStore";
import type { BotIncomingMessage } from "../../../core/tact-bot/types";
import { triggerOnlySlackConversationEvidence } from "../../../core/tact-bot/adapters/slack/slackConversationContext";
import { check, summarize, type CheckResult } from "../lib/check";

const SIGNING_SECRET = "fake-signing-secret-for-test-only";

function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const digest = createHmac("sha256", secret).update(baseString, "utf8").digest("hex");
  return `v0=${digest}`;
}

function makeHeaders(map: Record<string, string | undefined>): SlackWebhookHeaders {
  return {
    get(name: string) {
      const key = Object.keys(map).find((k) => k.toLowerCase() === name.toLowerCase());
      return key && map[key] !== undefined ? (map[key] as string) : null;
    },
  };
}

function makeSignedRequest(
  envelope: unknown,
  options: { signingSecret?: string; timestamp?: string; tamperSignature?: boolean } = {}
): { rawBody: string; headers: SlackWebhookHeaders } {

  const rawBody = JSON.stringify(envelope);
  const signingSecret = options.signingSecret ?? SIGNING_SECRET;
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = options.tamperSignature
    ? "v0=0000000000000000000000000000000000000000000000000000000000000000"
    : computeSignature(signingSecret, timestamp, rawBody);

  return {
    rawBody,
    headers: makeHeaders({ "x-slack-signature": signature, "x-slack-request-timestamp": timestamp }),
  };

}

function makeAppMentionEnvelope(overrides: Record<string, unknown> = {}) {
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

function makeFakeDeps(options: {
  claimResult?: ClaimExternalEventResult;
  claimResultsByEventId?: Record<string, ClaimExternalEventResult>;
} = {}): {
  deps: HandleSlackWebhookRequestDeps;
  claimCalls: { channel: string; externalEventId: string }[];
  receiveBotMessageCalls: BotIncomingMessage[];
  retrievedContextTriggers: { channelRef: string; triggerMessageRef: string; threadRef?: string }[];
  scheduledTasks: (() => Promise<void>)[];
} {

  const claimCalls: { channel: string; externalEventId: string }[] = [];
  const receiveBotMessageCalls: BotIncomingMessage[] = [];
  const retrievedContextTriggers: { channelRef: string; triggerMessageRef: string; threadRef?: string }[] = [];
  const scheduledTasks: (() => Promise<void>)[] = [];

  const deps: HandleSlackWebhookRequestDeps = {

    getSigningSecret: () => SIGNING_SECRET,

    claimExternalEvent: async (params) => {
      claimCalls.push(params);
      if (options.claimResultsByEventId && params.externalEventId in options.claimResultsByEventId) {
        return options.claimResultsByEventId[params.externalEventId];
      }
      return options.claimResult ?? "claimed";
    },

    receiveBotMessage: async (message) => {
      receiveBotMessageCalls.push(message);
      return { handled: true, actions: [] };
    },

    retrieveConversationContext: async (trigger) => {
      retrievedContextTriggers.push(trigger);
      return triggerOnlySlackConversationEvidence(trigger);
    },

    // S1e: このtest fileはApproval decision routing自体を対象としない
    // ため、常にmatched:falseを返す最小fake(=既存receiveBotMessage
    // pathがそのまま使われる、既存挙動を変えない)。
    detectApprovalDecisionText: () => ({ matched: false }),

    receiveApprovalDecision: async () => ({ handled: false, actions: [] }),

    // S1c: このtest fileはreceiveBotMessage/dedup/署名検証の分岐のみを
    // 対象とするため、executeBotActionsは呼び出しを記録するだけの
    // 最小fakeにとどめる(常にactions:[]のため実際には呼ばれない想定、
    // outbound配送の詳細はtests/tact/bot/slackOutbound*.test.tsが担う)。
    executeBotActions: async () => [],

    // 絶対条件(Section20)を検証しやすくするため、production既定の
    // after()とは異なり、taskをcaptureするだけで自動実行はしない
    // (呼び出し元testが明示的にtask()を呼んで初めてreceiveBotMessage
    // が実行される、production同様「レスポンス確定後に実行される」
    // 非同期性を模す)。
    scheduleBackgroundWork: (task) => {
      scheduledTasks.push(task);
    },

  };

  return { deps, claimCalls, receiveBotMessageCalls, retrievedContextTriggers, scheduledTasks };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case G: url_verification + valid signature -> challenge返却 ----
  {
    const envelope = { type: "url_verification", challenge: "challenge-abc-123" };
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, claimCalls, receiveBotMessageCalls } = makeFakeDeps();

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[Case G] url_verification + 正しい署名 -> 200でchallengeがそのまま返り、DB/receiveBotMessageは一切呼ばれない",
        response.status === 200 &&
          response.body.challenge === "challenge-abc-123" &&
          claimCalls.length === 0 &&
          receiveBotMessageCalls.length === 0
      )
    );
  }

  // ---- Case H: url_verification + invalid signature -> challenge返却しない ----
  {
    const envelope = { type: "url_verification", challenge: "should-not-be-returned" };
    const { rawBody, headers } = makeSignedRequest(envelope, { tamperSignature: true });
    const { deps } = makeFakeDeps();

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[Case H] url_verification + 不正な署名 -> 401、challengeを一切含まない",
        response.status === 401 && JSON.stringify(response.body) !== JSON.stringify({ challenge: "should-not-be-returned" })
      )
    );
  }

  // ---- Signing Secret未設定 -> 401(fail closed) ----
  {
    const envelope = makeAppMentionEnvelope();
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, claimCalls } = makeFakeDeps();

    const response = await handleSlackWebhookRequest(rawBody, headers, {
      ...deps,
      getSigningSecret: () => undefined,
    });

    results.push(
      check(
        "[絶対条件Section5] Signing Secret未設定の場合、検証をskipせず401・not_configuredを返し、DBへ一切触れない",
        response.status === 401 && response.body.error === "not_configured" && claimCalls.length === 0
      )
    );
  }

  // ---- 通常event: 不正signature -> 401、DB未接触 ----
  {
    const envelope = makeAppMentionEnvelope();
    const { rawBody, headers } = makeSignedRequest(envelope, { tamperSignature: true });
    const { deps, claimCalls, receiveBotMessageCalls } = makeFakeDeps();

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[絶対条件Section17] 不正signatureの通常eventは401を返し、署名検証前にDBへ一切触れない(claimExternalEvent 0)",
        response.status === 401 && claimCalls.length === 0 && receiveBotMessageCalls.length === 0
      )
    );
  }

  // ---- Case (Section8): 対象外event(event_callback以外) -> ACK、DB未接触 ----
  {
    const envelope = { type: "app_rate_limited" };
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, claimCalls, receiveBotMessageCalls } = makeFakeDeps();

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[Section8] event_callback以外のtop-level typeは200 ACKで安全にignoreされ、DB/receiveBotMessageは呼ばれない",
        response.status === 200 && claimCalls.length === 0 && receiveBotMessageCalls.length === 0
      )
    );
  }

  // ---- Case (Section8): 対象外event(app_mention以外のevent.type) -> ACK、DB未接触 ----
  {
    const envelope = makeAppMentionEnvelope({ event: { type: "message", user: "U1", text: "hi", ts: "1", channel: "C1" } });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, claimCalls, receiveBotMessageCalls } = makeFakeDeps();

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[Section8] app_mention以外のevent種別(例: message)は200 ACKでignoreされ、DB/receiveBotMessageは呼ばれない",
        response.status === 200 && claimCalls.length === 0 && receiveBotMessageCalls.length === 0
      )
    );
  }

  // ---- Case (Section9): bot echo -> ACK、dedup claimも呼ばれない ----
  {
    const envelope = makeAppMentionEnvelope({
      event: {
        type: "app_mention",
        user: "U123USER",
        text: "echo",
        ts: "1893456000.000100",
        channel: "C123CHANNEL",
        bot_id: "B999BOT",
      },
    });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, claimCalls, receiveBotMessageCalls } = makeFakeDeps();

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[絶対条件Section9/17] bot echo eventは200 ACKでignoreされ、dedup claim(claimExternalEvent)自体も呼ばれない(対象外eventでdedup recordを無駄に作らない)、receiveBotMessageも呼ばれない",
        response.status === 200 && claimCalls.length === 0 && receiveBotMessageCalls.length === 0
      )
    );
  }

  // ---- Case (Section25): first delivery -> claimed -> ACK先行 + receiveBotMessage 1回(scheduled) ----
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-first-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, claimCalls, receiveBotMessageCalls, scheduledTasks } = makeFakeDeps({ claimResult: "claimed" });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[Case25/first] first delivery: 200 ACK、claimExternalEventが正確に1回({channel:'slack', externalEventId:'Ev-first-1'})呼ばれる",
        response.status === 200 &&
          claimCalls.length === 1 &&
          claimCalls[0].channel === "slack" &&
          claimCalls[0].externalEventId === "Ev-first-1"
      )
    );

    results.push(
      check(
        "[絶対条件Section25] dedup呼び出しparamsにchannel/externalEventId以外のfield(raw payload/message本文)が含まれない",
        Object.keys(claimCalls[0]).sort().join(",") === ["channel", "externalEventId"].sort().join(",")
      )
    );

    results.push(
      check(
        "[絶対条件Section20] ACKはreceiveBotMessage()の完了を待たずに返る(scheduleBackgroundWorkへtaskが委譲されるだけで、この時点ではまだreceiveBotMessageは呼ばれていない)",
        scheduledTasks.length === 1 && receiveBotMessageCalls.length === 0
      )
    );

    // scheduleされたtaskを明示的に実行して初めてreceiveBotMessageが呼ばれる
    // (production既定のafter()と同じ「レスポンス確定後に実行される」非同期性)。
    await scheduledTasks[0]();

    results.push(
      check(
        "[絶対条件Section21/22] scheduleされたtask実行後、receiveBotMessage()が正確に1回、正しいBotIncomingMessageで呼ばれる(actor.externalUserId設定・actor.tactUserId未設定)",
        receiveBotMessageCalls.length === 1 &&
          receiveBotMessageCalls[0].actor.externalUserId === "U123USER" &&
          receiveBotMessageCalls[0].actor.tactUserId === undefined
      )
    );
  }

  // ---- Case (Section25): duplicate -> ACK、receiveBotMessage 0 ----
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-dup-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, claimCalls, receiveBotMessageCalls, scheduledTasks } = makeFakeDeps({ claimResult: "duplicate" });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[Case25/duplicate] 同一event_idの再送(duplicate)は200 ACKを返すが、receiveBotMessageは一切呼ばれない(scheduleBackgroundWorkも呼ばれない)",
        response.status === 200 &&
          claimCalls.length === 1 &&
          scheduledTasks.length === 0 &&
          receiveBotMessageCalls.length === 0
      )
    );
  }

  // ---- Case (Section25): 異なるevent_id -> 両方claimed ----
  {
    const envelopeA = makeAppMentionEnvelope({ event_id: "Ev-multi-A" });
    const envelopeB = makeAppMentionEnvelope({ event_id: "Ev-multi-B" });

    const { deps, claimCalls, scheduledTasks } = makeFakeDeps({
      claimResultsByEventId: { "Ev-multi-A": "claimed", "Ev-multi-B": "claimed" },
    });

    const { rawBody: rawBodyA, headers: headersA } = makeSignedRequest(envelopeA);
    const { rawBody: rawBodyB, headers: headersB } = makeSignedRequest(envelopeB);

    const responseA = await handleSlackWebhookRequest(rawBodyA, headersA, deps);
    const responseB = await handleSlackWebhookRequest(rawBodyB, headersB, deps);

    results.push(
      check(
        "[Case25/異なるevent_id] 異なるevent_idはそれぞれ独立にclaimed扱いされ、両方ともscheduleBackgroundWorkへtaskが積まれる",
        responseA.status === 200 &&
          responseB.status === 200 &&
          claimCalls.length === 2 &&
          scheduledTasks.length === 2
      )
    );
  }

  // ---- Case (Section18): storage failure -> 500、receiveBotMessage 0 ----
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-error-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, claimCalls, receiveBotMessageCalls, scheduledTasks } = makeFakeDeps({ claimResult: "error" });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[絶対条件Section18] dedup storage failure時は'duplicate扱いで捨てる'/'claimed扱いで進める'のどちらでもなく、500(fail closed)を返しreceiveBotMessageを一切呼ばない(scheduleBackgroundWorkも呼ばれない、Slackの自然な再送を誘発できるHTTP status)",
        response.status === 500 &&
          claimCalls.length === 1 &&
          scheduledTasks.length === 0 &&
          receiveBotMessageCalls.length === 0
      )
    );
  }

  // ---- Case (Section11): mention除去後に空文字 -> claimedでもreceiveBotMessage実行されない ----
  {
    const envelope = makeAppMentionEnvelope({
      event_id: "Ev-empty-1",
      event: { type: "app_mention", user: "U123USER", text: "<@U999TACTBOT>", ts: "1893456000.000100", channel: "C123CHANNEL" },
    });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, scheduledTasks, receiveBotMessageCalls } = makeFakeDeps({ claimResult: "claimed" });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    if (scheduledTasks.length > 0) {
      await scheduledTasks[0]();
    }

    results.push(
      check(
        "[Section11] mention除去後に空文字になるeventはclaimed扱いでも(dedup recordは作られる)normalizeがnullを返すためscheduleBackgroundWork/receiveBotMessageのいずれも呼ばれない",
        response.status === 200 && scheduledTasks.length === 0 && receiveBotMessageCalls.length === 0
      )
    );
  }

  return summarize("bot/slackWebhookHandler", results);

}
