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
import type {
  ClaimExternalEventResult,
  ReleaseExternalEventClaimResult,
} from "../../../core/tact-bot/eventDedup/supabaseEventDedupStore";
import type { BotIdentity, BotIncomingMessage } from "../../../core/tact-bot/types";
import type { BotIdentityResolver } from "../../../core/tact-bot/identity/resolver";
import type {
  IngestTrustedExternalEventResult,
  ContinueTrustedExternalEventArrivalResult,
  TrustedExternalEventParams,
} from "../../../core/tact-bot/execution/trustedExternalEventIngest";
import { triggerOnlySlackConversationEvidence } from "../../../core/tact-bot/adapters/slack/slackConversationContext";
import { buildSafeSlackBackgroundFailureDiagnostic } from "../../../core/tact-bot/diagnostics/safeBackgroundFailureDiagnostic";
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
  releaseResult?: ReleaseExternalEventClaimResult;
  // EVENT-P1d Phase4/6: 既定はnull(unmapped actor)——このoptionを
  // 省略した既存テストは、ExternalEvent ingest/match/resumeのいずれも
  // 一切試みられない、既存(EVENT-P1d以前)と同じ経路をそのまま通る。
  identity?: BotIdentity | null;
  ingestOutcome?: IngestTrustedExternalEventResult;
  arrivalOutcome?: ContinueTrustedExternalEventArrivalResult;
} = {}): {
  deps: HandleSlackWebhookRequestDeps;
  claimCalls: { channel: string; externalEventId: string }[];
  releaseCalls: { channel: string; externalEventId: string }[];
  receiveBotMessageCalls: BotIncomingMessage[];
  retrievedContextTriggers: { channelRef: string; triggerMessageRef: string; threadRef?: string }[];
  scheduledTasks: (() => Promise<void>)[];
  identityResolveCalls: { externalUserId: string; channel: string; externalWorkspaceId?: string }[];
  ingestTrustedExternalEventCalls: TrustedExternalEventParams[];
  continueTrustedExternalEventArrivalCalls: TrustedExternalEventParams[];
} {

  const claimCalls: { channel: string; externalEventId: string }[] = [];
  const releaseCalls: { channel: string; externalEventId: string }[] = [];
  const receiveBotMessageCalls: BotIncomingMessage[] = [];
  const retrievedContextTriggers: { channelRef: string; triggerMessageRef: string; threadRef?: string }[] = [];
  const scheduledTasks: (() => Promise<void>)[] = [];
  const identityResolveCalls: { externalUserId: string; channel: string; externalWorkspaceId?: string }[] = [];
  const ingestTrustedExternalEventCalls: TrustedExternalEventParams[] = [];
  const continueTrustedExternalEventArrivalCalls: TrustedExternalEventParams[] = [];

  const identityResolver: BotIdentityResolver = {
    resolve: async (actor, channel, externalWorkspaceId) => {
      identityResolveCalls.push({ externalUserId: actor.externalUserId, channel, externalWorkspaceId });
      return options.identity ?? null;
    },
  };

  const deps: HandleSlackWebhookRequestDeps = {

    getSigningSecret: () => SIGNING_SECRET,

    claimExternalEvent: async (params) => {
      claimCalls.push(params);
      if (options.claimResultsByEventId && params.externalEventId in options.claimResultsByEventId) {
        return options.claimResultsByEventId[params.externalEventId];
      }
      return options.claimResult ?? "claimed";
    },

    releaseExternalEventClaim: async (params) => {
      releaseCalls.push(params);
      return options.releaseResult ?? "released";
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

    // EVENT-P1d Phase4: 既定でunmapped(null)を返すfake identity
    // resolver。実Supabase(defaultDeps.identityResolver =
    // slackTrustedBotIdentityResolver)には絶対に到達しない。
    identityResolver,

    // EVENT-P1d Phase6: 呼び出しを記録するだけの最小fake。実service
    // role key/実Supabaseには絶対に到達しない。
    ingestTrustedExternalEvent: async (params) => {
      ingestTrustedExternalEventCalls.push(params);
      return options.ingestOutcome ?? { ok: true, outcome: { status: "event_received", event: {
        id: "ext-evt-test", userId: params.tactUserId, source: params.source, eventType: params.eventType,
        externalEventId: params.externalEventId, subjectRef: params.subjectRef, receivedAt: new Date().toISOString(),
        normalizedPayload: params.normalizedPayload ?? {}, status: "received", createdAt: new Date().toISOString(),
      } } };
    },

    continueTrustedExternalEventArrival: async (params) => {
      continueTrustedExternalEventArrivalCalls.push(params);
      return options.arrivalOutcome ?? {
        ok: true,
        outcome: { status: "not_ingested", ingest: { status: "event_invalid", reasonCode: "missing_source" } },
      };
    },

    // 絶対条件(Section20)を検証しやすくするため、production既定の
    // after()とは異なり、taskをcaptureするだけで自動実行はしない
    // (呼び出し元testが明示的にtask()を呼んで初めてreceiveBotMessage
    // が実行される、production同様「レスポンス確定後に実行される」
    // 非同期性を模す)。
    scheduleBackgroundWork: (task) => {
      scheduledTasks.push(task);
    },

  };

  return {
    deps,
    claimCalls,
    releaseCalls,
    receiveBotMessageCalls,
    retrievedContextTriggers,
    scheduledTasks,
    identityResolveCalls,
    ingestTrustedExternalEventCalls,
    continueTrustedExternalEventArrivalCalls,
  };

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

  // ---- Background failure diagnostics remain server-only and redacted ----
  {
    const triggerText = "\u79d8\u5bc6\u306eSlack\u4f1a\u8a71\u672c\u6587";
    const envelope = makeAppMentionEnvelope({
      event_id: "Ev-background-failure-1",
      event: {
        type: "app_mention",
        user: "U123USER",
        text: `<@U999TACTBOT> ${triggerText}`,
        ts: "1893456000.000100",
        channel: "C123CHANNEL",
      },
    });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, scheduledTasks, receiveBotMessageCalls } = makeFakeDeps();
    const diagnostics: unknown[] = [];
    const failure = new Error(
      `conversation failed for ${triggerText}; Authorization: Bearer xoxb-secret-token; connectionId=conn-sensitive; connected_account_id=ca_sensitive_12345678`,
      { cause: new Error(`provider body included ${triggerText}; api_key=sk-sensitive-value`) }
    );

    deps.receiveBotMessage = async () => {
      throw failure;
    };
    deps.logBackgroundFailure = (diagnostic) => {
      diagnostics.push(diagnostic);
    };

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);
    await scheduledTasks[0]();
    const serializedDiagnostic = JSON.stringify(diagnostics[0]);

    results.push(
      check(
        "[background failure diagnostics] Error/cause/stage are retained only for the server diagnostic boundary",
        response.status === 200 &&
          JSON.stringify(response.body) === JSON.stringify({ ok: true }) &&
          receiveBotMessageCalls.length === 0 &&
          diagnostics.length === 1 &&
          typeof diagnostics[0] === "object" &&
          diagnostics[0] !== null &&
          (diagnostics[0] as { stage?: unknown }).stage === "conversation_intake" &&
          (diagnostics[0] as { errorName?: unknown }).errorName === "Error" &&
          (diagnostics[0] as { causeName?: unknown }).causeName === "Error"
      )
    );

    results.push(
      check(
        "[background failure diagnostics] Slack text, tokens, connection/provider account identifiers, and raw error values are redacted from the server diagnostic",
        !serializedDiagnostic.includes(triggerText) &&
          !serializedDiagnostic.includes("xoxb-secret-token") &&
          !serializedDiagnostic.includes("conn-sensitive") &&
          !serializedDiagnostic.includes("ca_sensitive_12345678") &&
          !serializedDiagnostic.includes("sk-sensitive-value") &&
          serializedDiagnostic.includes("[redacted]") &&
          !JSON.stringify(response.body).includes("conversation failed")
      )
    );
  }

  // ---- Non-Error background diagnostics retain a small, redacted summary ----
  {
    const errorDiagnostic = buildSafeSlackBackgroundFailureDiagnostic(
      new Error("normal failure"),
      "conversation_intake"
    );
    const stringDiagnostic = buildSafeSlackBackgroundFailureDiagnostic(
      "provider rejected the request",
      "conversation_intake"
    );
    const objectDiagnostic = buildSafeSlackBackgroundFailureDiagnostic({
      code: "provider_rejected",
      message: "provider rejected the request",
      details: "invalid grant",
      hint: "reconnect the service",
      ignoredNestedPayload: { access_token: "must-not-be-read" },
    }, "conversation_intake");
    const nullDiagnostic = buildSafeSlackBackgroundFailureDiagnostic(null, "conversation_intake");
    const secretDiagnostic = buildSafeSlackBackgroundFailureDiagnostic({
      message: "Authorization: Bearer xoxb-secret-value",
      details: "api_key=sk-secret-value",
      token: "token-secret-value",
      apiKey: "api-key-secret-value",
    }, "conversation_intake", ["token-secret-value", "api-key-secret-value"]);
    const longDiagnostic = buildSafeSlackBackgroundFailureDiagnostic("x".repeat(2_000), "conversation_intake");
    const serializedSecretDiagnostic = JSON.stringify(secretDiagnostic);

    results.push(check(
      "[background failure diagnostics] Error instances preserve their existing Error diagnostic shape",
      errorDiagnostic.errorName === "Error" &&
        errorDiagnostic.message === "normal failure" &&
        !("thrownType" in errorDiagnostic)
    ));

    results.push(check(
      "[background failure diagnostics] thrown strings preserve a bounded primitive summary",
      stringDiagnostic.errorName === "NonErrorThrown" &&
        stringDiagnostic.thrownType === "string" &&
        stringDiagnostic.message === "provider rejected the request" &&
        stringDiagnostic.thrownValueSummary === "provider rejected the request"
    ));

    results.push(check(
      "[background failure diagnostics] thrown plain objects expose only allowlisted scalar diagnostic fields",
      objectDiagnostic.errorName === "NonErrorThrown" &&
        objectDiagnostic.code === "provider_rejected" &&
        objectDiagnostic.details === "invalid grant" &&
        objectDiagnostic.hint === "reconnect the service" &&
        objectDiagnostic.keys?.join(",") === "message,code,details,hint" &&
        !JSON.stringify(objectDiagnostic).includes("must-not-be-read")
    ));

    results.push(check(
      "[background failure diagnostics] null, secret-shaped, and oversized non-Error values remain explicit, redacted, and bounded",
      nullDiagnostic.thrownType === "null" && nullDiagnostic.thrownValueSummary === "null" &&
        !serializedSecretDiagnostic.includes("xoxb-secret-value") &&
        !serializedSecretDiagnostic.includes("sk-secret-value") &&
        !serializedSecretDiagnostic.includes("token-secret-value") &&
        !serializedSecretDiagnostic.includes("api-key-secret-value") &&
        serializedSecretDiagnostic.includes("[redacted]") &&
        (longDiagnostic.message.length <= 501) && (longDiagnostic.thrownValueSummary?.length ?? 0) <= 501
    ));
  }

  // =========================
  // EVENT-P1d Phase4/6: Slack -> trusted TACT user -> canonical
  // ExternalEvent ingest -> background EventWait match/resume
  // =========================

  // ---- unmapped actor: ExternalEventを一切作らない、通常のBot処理は既存通り ----
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-unmapped-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const {
      deps,
      scheduledTasks,
      receiveBotMessageCalls,
      identityResolveCalls,
      ingestTrustedExternalEventCalls,
      continueTrustedExternalEventArrivalCalls,
    } = makeFakeDeps({ identity: null });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);
    await scheduledTasks[0]();

    results.push(
      check(
        "[EVENT-P1d Phase4] unmapped Slack actor -> identity解決は試みるが(冪等な2回目の解決)、ExternalEvent ingest/match-resumeのいずれも一切呼ばれず、fallback userも発明しない。通常のBot会話処理は既存契約のまま続行する",
        response.status === 200 &&
          identityResolveCalls.length === 1 &&
          identityResolveCalls[0].externalUserId === "U123USER" &&
          identityResolveCalls[0].externalWorkspaceId === "T123TEAM" &&
          ingestTrustedExternalEventCalls.length === 0 &&
          continueTrustedExternalEventArrivalCalls.length === 0 &&
          receiveBotMessageCalls.length === 1
      )
    );
  }

  // ---- mapped actor: 正確なcanonical mapping(source/eventType/subjectRef/occurredAt/normalizedPayload allowlist) ----
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-mapped-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, scheduledTasks, ingestTrustedExternalEventCalls, continueTrustedExternalEventArrivalCalls } = makeFakeDeps({
      identity: { tactUserId: "tact-user-mapped-1" },
    });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[EVENT-P1d Phase6] mapped actor -> ACK前に同期でingestTrustedExternalEventが正確に1回、正しいcanonical mapping(source='slack', eventType='app_mention', externalEventId, deterministic subjectRef)で呼ばれる",
        response.status === 200 &&
          ingestTrustedExternalEventCalls.length === 1 &&
          ingestTrustedExternalEventCalls[0].tactUserId === "tact-user-mapped-1" &&
          ingestTrustedExternalEventCalls[0].source === "slack" &&
          ingestTrustedExternalEventCalls[0].eventType === "app_mention" &&
          ingestTrustedExternalEventCalls[0].externalEventId === "Ev-mapped-1" &&
          ingestTrustedExternalEventCalls[0].subjectRef === "T123TEAM:C123CHANNEL:1893456000.000100"
      )
    );

    results.push(
      check(
        "[Section「deterministic subjectRef」] subjectRefは既に正規化済みのBotIncomingMessage値(organizationId:externalConversationId:threadId)から組み立てられる",
        /^T123TEAM:C123CHANNEL:\d+\.\d+$/.test(ingestTrustedExternalEventCalls[0].subjectRef)
      )
    );

    results.push(
      check(
        "[occurredAt] Slack event.tsから導出されたISO 8601文字列である",
        typeof ingestTrustedExternalEventCalls[0].occurredAt === "string" &&
          !Number.isNaN(Date.parse(ingestTrustedExternalEventCalls[0].occurredAt as string))
      )
    );

    results.push(
      check(
        "[normalizedPayload allowlist] raw Slack webhook body/署名/signing secret/bot token/service role keyのいずれも含まれない、allowlistされたfieldのみ",
        !JSON.stringify(ingestTrustedExternalEventCalls[0].normalizedPayload).includes(SIGNING_SECRET) &&
          Object.keys(ingestTrustedExternalEventCalls[0].normalizedPayload ?? {}).sort().join(",") ===
            ["actorExternalUserId", "channelId", "messageRef", "providerEventType", "providerTimestamp", "teamId", "text", "threadId"].sort().join(",")
      )
    );

    await scheduledTasks[0]();

    results.push(
      check(
        "[EVENT-P1d Phase6 順序11] ACK後のbackground処理で、continueTrustedExternalEventArrivalが正確に1回、同じtactUserId/subjectRefで呼ばれる(既存canonical processExternalEventArrival()を再利用、match/resumeを手で再実装しない)",
        continueTrustedExternalEventArrivalCalls.length === 1 &&
          continueTrustedExternalEventArrivalCalls[0].tactUserId === "tact-user-mapped-1" &&
          continueTrustedExternalEventArrivalCalls[0].subjectRef === "T123TEAM:C123CHANNEL:1893456000.000100"
      )
    );
  }

  // ---- mapped actor + durable ingest失敗(event_persistence_failed) -> fail-closed 5xx、ACKしない ----
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-ingest-fail-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, scheduledTasks, continueTrustedExternalEventArrivalCalls, releaseCalls } = makeFakeDeps({
      identity: { tactUserId: "tact-user-2" },
      ingestOutcome: { ok: true, outcome: { status: "event_persistence_failed", error: "connection reset" } },
    });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[絶対条件、最重要] mapped userに対するdurable ExternalEvent ingestがevent_persistence_failedの場合、成功ACKを返さず500(fail closed、Slackの自然な再送へ委ねる)を返す。background処理(EVENT match/resume・通常Bot会話処理いずれも)は一切scheduleされない",
        response.status === 500 &&
          scheduledTasks.length === 0 &&
          continueTrustedExternalEventArrivalCalls.length === 0 &&
          releaseCalls.length === 1 &&
          releaseCalls[0].channel === "slack" &&
          releaseCalls[0].externalEventId === "Ev-ingest-fail-1"
      )
    );
  }

  // ---- mapped actor + service role key未設定(trusted_execution_not_configured) -> 同じくfail-closed 5xx ----
  // A failed pre-ACK ingest releases only its atomic bot claim. The Slack
  // retry can enter canonical ingest, while a later duplicate of the
  // successfully persisted event is ACKed without a second ingest.
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-retryable-ingest-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, scheduledTasks, continueTrustedExternalEventArrivalCalls } = makeFakeDeps({
      identity: { tactUserId: "tact-user-retryable-1" },
    });
    const claimedEventIds = new Set<string>();
    let claimCalls = 0;
    let releaseCalls = 0;
    let ingestCalls = 0;
    const defaultIngest = deps.ingestTrustedExternalEvent!;

    deps.claimExternalEvent = async ({ externalEventId }) => {
      claimCalls += 1;
      if (claimedEventIds.has(externalEventId)) return "duplicate";
      claimedEventIds.add(externalEventId);
      return "claimed";
    };
    deps.releaseExternalEventClaim = async ({ externalEventId }) => {
      releaseCalls += 1;
      claimedEventIds.delete(externalEventId);
      return "released";
    };
    deps.ingestTrustedExternalEvent = async (params) => {
      ingestCalls += 1;
      if (ingestCalls === 1) {
        return { ok: true, outcome: { status: "event_persistence_failed", error: "transient" } };
      }
      return defaultIngest(params);
    };

    const firstResponse = await handleSlackWebhookRequest(rawBody, headers, deps);
    const retryResponse = await handleSlackWebhookRequest(rawBody, headers, deps);
    await scheduledTasks[0]();
    const laterDuplicateResponse = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[EVENT-P1d retry] a failed ingest releases the claim, one Slack retry persists/resumes once, and a later duplicate is ACKed without another ingest",
        firstResponse.status === 500 &&
          retryResponse.status === 200 &&
          laterDuplicateResponse.status === 200 &&
          claimCalls === 3 &&
          releaseCalls === 1 &&
          ingestCalls === 2 &&
          scheduledTasks.length === 1 &&
          continueTrustedExternalEventArrivalCalls.length === 1
      )
    );
  }

  // The atomic claim continues to protect the interval while the first
  // canonical ingest is pending, so concurrent delivery cannot double-ingest
  // or double-resume the external event.
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-concurrent-ingest-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, scheduledTasks, continueTrustedExternalEventArrivalCalls } = makeFakeDeps({
      identity: { tactUserId: "tact-user-concurrent-1" },
    });
    let claimed = false;
    let ingestCalls = 0;
    let releaseFirstIngest: () => void = () => {};
    let signalIngestStarted: () => void = () => {};
    const firstIngest = new Promise<void>((resolve) => {
      releaseFirstIngest = resolve;
    });
    const ingestStarted = new Promise<void>((resolve) => {
      signalIngestStarted = resolve;
    });
    const defaultIngest = deps.ingestTrustedExternalEvent!;

    deps.claimExternalEvent = async () => {
      if (claimed) return "duplicate";
      claimed = true;
      return "claimed";
    };
    deps.ingestTrustedExternalEvent = async (params) => {
      ingestCalls += 1;
      signalIngestStarted();
      await firstIngest;
      return defaultIngest(params);
    };

    const firstDelivery = handleSlackWebhookRequest(rawBody, headers, deps);
    await ingestStarted;
    const concurrentDuplicate = await handleSlackWebhookRequest(rawBody, headers, deps);
    releaseFirstIngest();
    const firstResponse = await firstDelivery;
    await scheduledTasks[0]();

    results.push(
      check(
        "[EVENT-P1d concurrency] a concurrent duplicate is ACKed while the claimed ingest runs, with one ingest and one EventWait continuation",
        firstResponse.status === 200 &&
          concurrentDuplicate.status === 200 &&
          ingestCalls === 1 &&
          scheduledTasks.length === 1 &&
          continueTrustedExternalEventArrivalCalls.length === 1
      )
    );
  }

  // ---- mapped actor + missing service role key -> fail-closed 5xx ----
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-ingest-not-configured-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, scheduledTasks } = makeFakeDeps({
      identity: { tactUserId: "tact-user-3" },
      ingestOutcome: { ok: false, error: "trusted_execution_not_configured" },
    });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[絶対条件] trusted execution(service role key)未設定の場合も、mapped userに対しては同じくfail-closed 500を返す",
        response.status === 500 && scheduledTasks.length === 0
      )
    );
  }

  // ---- mapped actor + 非transientな構造的失敗(event_invalid等) -> 200 ACK・通常Bot処理は継続、EVENT側だけskip ----
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-ingest-invalid-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, scheduledTasks, receiveBotMessageCalls, continueTrustedExternalEventArrivalCalls } = makeFakeDeps({
      identity: { tactUserId: "tact-user-4" },
      ingestOutcome: { ok: true, outcome: { status: "event_invalid", reasonCode: "missing_source" } },
    });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);
    await scheduledTasks[0]();

    results.push(
      check(
        "[非transient失敗] event_invalid等の構造的失敗は5xxで再送させても解消しないため200 ACKし、通常のBot会話処理は継続するが、EVENT側のmatch/resume(continueTrustedExternalEventArrival)だけはskipする",
        response.status === 200 &&
          receiveBotMessageCalls.length === 1 &&
          continueTrustedExternalEventArrivalCalls.length === 0
      )
    );
  }

  // ---- background isolation: EVENT match/resumeの失敗がBot会話処理を抑制しない ----
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-isolation-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, scheduledTasks, receiveBotMessageCalls } = makeFakeDeps({
      identity: { tactUserId: "tact-user-5" },
    });

    const diagnostics: unknown[] = [];
    deps.continueTrustedExternalEventArrival = async () => {
      throw new Error("event match/resume boundary failed");
    };
    deps.logBackgroundFailure = (diagnostic) => {
      diagnostics.push(diagnostic);
    };

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);
    await scheduledTasks[0]();

    results.push(
      check(
        "[絶対条件「one failure must not accidentally suppress the other」] EVENT match/resumeが例外を投げても、独立したtry/catchで隔離され、通常のBot会話処理(receiveBotMessage)は正常に実行される。失敗はevent_match_resume stageとして個別にログされる",
        response.status === 200 &&
          receiveBotMessageCalls.length === 1 &&
          diagnostics.length === 1 &&
          (diagnostics[0] as { stage?: unknown }).stage === "event_match_resume"
      )
    );
  }

  // ---- duplicate delivery: identity解決/ExternalEvent ingestのいずれも試みない(既存dedupが先) ----
  {
    const envelope = makeAppMentionEnvelope({ event_id: "Ev-dup-event-1" });
    const { rawBody, headers } = makeSignedRequest(envelope);
    const { deps, identityResolveCalls, ingestTrustedExternalEventCalls } = makeFakeDeps({
      claimResult: "duplicate",
      identity: { tactUserId: "tact-user-6" },
    });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);

    results.push(
      check(
        "[絶対条件Section5「keep both dedup systems」] 既存のtact_bot_processed_events dedupがduplicateと判定した場合、canonical identity解決/ExternalEvent ingestのいずれにも到達しない(既存Bot dedupが引き続き最初の防衛線)",
        response.status === 200 &&
          identityResolveCalls.length === 0 &&
          ingestTrustedExternalEventCalls.length === 0
      )
    );
  }

  // ---- Approval(Block Kit)経路: ExternalEvent側へは一切ルーティングしない ----
  {
    const approvalPayload = {
      type: "block_actions",
      user: { id: "U123USER" },
      team: { id: "T123TEAM" },
      channel: { id: "C123CHANNEL" },
      container: { message_ts: "1893456000.000200" },
      actions: [{ action_id: "tact_approval_approve", value: "approval-1" }],
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(approvalPayload))}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSignature(SIGNING_SECRET, timestamp, rawBody);
    const headers = makeHeaders({ "x-slack-signature": signature, "x-slack-request-timestamp": timestamp });

    const { deps, scheduledTasks, identityResolveCalls, ingestTrustedExternalEventCalls, continueTrustedExternalEventArrivalCalls } = makeFakeDeps({
      identity: { tactUserId: "tact-user-approval-1" },
    });

    const response = await handleSlackWebhookRequest(rawBody, headers, deps);
    if (scheduledTasks.length > 0) {
      await scheduledTasks[0]();
    }

    results.push(
      check(
        "[絶対条件Section7「Approval path stays structurally separate」] Slack Block Kit approval callback(block_actions)は、通常のapp_mention経路(identity解決/ExternalEvent ingest/match-resume)へは一切到達しない(既存の早期returnのまま)",
        response.status === 200 &&
          identityResolveCalls.length === 0 &&
          ingestTrustedExternalEventCalls.length === 0 &&
          continueTrustedExternalEventArrivalCalls.length === 0
      )
    );
  }

  return summarize("bot/slackWebhookHandler", results);

}
