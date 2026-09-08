// =========================
// TACT Bot — Slack app_mention -> Trusted Bot Core -> Research
// Routing Regression (S1b)
// =========================
//
// 対象: core/tact-bot/adapters/slack/handleSlackWebhookRequest.tsを
// 実際のSlack app_mention envelope(署名付き)で駆動し、
//   Slack payload -> BotIncomingMessage(実normalizeSlackAppMentionEvent())
//   -> receiveBotMessage() -> identity解決(fake) -> BotCoreConnector
//   (実core/tact-bot/connector/conversationConnector.tsのpure logic、
//   BOT-P2/BOT-P2.5で確立済み) -> Conversation Turn(fake、ただし
//   Research capability選択は実core/tact-orchestrator/runOrchestration()
//   を経由する) -> BotAction[]
// までを、live Supabase/live LLM/live Search/live Slackへ一切接続せずに
// 証明する。
//
// 絶対条件: 新しいResearch-specific routingをSlack層へ追加しない
// (既存core/tact-intent/core/tact-orchestrator/core/tact-core/
// capabilities/registry.tsをそのまま利用する、Section8)。

import { createHmac } from "node:crypto";
import { handleSlackWebhookRequest } from "../../../core/tact-bot/adapters/slack/handleSlackWebhookRequest";
import type { SlackWebhookHeaders } from "../../../core/tact-bot/adapters/slack/handleSlackWebhookRequest";
import { receiveBotMessage, type ReceiveBotMessageResult } from "../../../core/tact-bot/gateway/receiveMessage";
import { createConversationBotCoreConnector } from "../../../core/tact-bot/connector/conversationConnector";
import type {
  ConversationLinkCreate,
  ConversationLinkLookup,
} from "../../../core/tact-bot/connector/conversationConnector";
import type { BotIdentityResolver } from "../../../core/tact-bot/identity/resolver";
import type {
  RunConversationTurnAsTrustedActorParams,
  RunConversationTurnAsTrustedActorResult,
} from "../../../core/tact-bot/execution/trustedConversationTurn";
import type { BotIncomingMessage } from "../../../core/tact-bot/types";
import { runOrchestration } from "../../../core/tact-orchestrator";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import type { ResearchResult, ResearchParams, ResearchMetadata } from "../../../core/tact-research/types";
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

function makeSignedRequest(envelope: unknown): { rawBody: string; headers: SlackWebhookHeaders } {
  const rawBody = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeSignature(SIGNING_SECRET, timestamp, rawBody);
  return { rawBody, headers: makeHeaders({ "x-slack-signature": signature, "x-slack-request-timestamp": timestamp }) };
}

function makeAppMentionEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T123TEAM",
    event_id: "Ev-routing-1",
    event_time: 1893456000,
    event: {
      type: "app_mention",
      user: "U456USER",
      text: "<@U999TACTBOT> OpenAIの最近の動向を調べて",
      ts: "1893456000.000100",
      channel: "C123CHANNEL",
    },
    ...overrides,
  };
}

function makeMetadata(): ResearchMetadata {
  return {
    executionMode: "web-research", llmAttempts: 1, llmSuccesses: 1, llmFailures: 0,
    searchQueryCount: 1, searchRequestCount: 1, searchAttempts: [],
    retrievedKnowledgeCount: 0, retrievedMemoryCount: 0, retrievedExampleCount: 0,
    usedKnowledgeCount: 0, usedMemoryCount: 0, usedExampleCount: 0,
    usedKnowledgeIds: [], usedMemoryIds: [], usedExampleIds: [],
    durationMs: 10, mocked: true, requirementCount: 1, coveredRequirementCount: 1,
    partialRequirementCount: 0, missingRequirementCount: 0, gapQueries: [], safetyDowngradeCount: 0,
  };
}

// core/tact-bot/gateway/receiveMessage.tsを、指定したfake identity
// resolver/coreConnectorで呼ぶ、handleSlackWebhookRequestDeps.
// receiveBotMessage向けのwrapper。呼び出し結果(ReceiveBotMessageResult)
// をcaptureして後で検証できるようにする(handleSlackWebhookRequest()
// 自身はACK優先のため戻り値を外部へ公開しない、絶対条件Section13)。
function makeReceiveBotMessageDep(
  identityResolver: BotIdentityResolver,
  connectorDeps: {
    runTrustedTurn: (params: RunConversationTurnAsTrustedActorParams) => Promise<RunConversationTurnAsTrustedActorResult>;
    findLink: (params: ConversationLinkLookup) => Promise<string | null>;
    createLink: (params: ConversationLinkCreate) => Promise<boolean>;
  }
): { dep: (message: BotIncomingMessage) => Promise<ReceiveBotMessageResult>; results: ReceiveBotMessageResult[] } {

  const results: ReceiveBotMessageResult[] = [];
  const coreConnector = createConversationBotCoreConnector(connectorDeps);

  const dep = async (message: BotIncomingMessage): Promise<ReceiveBotMessageResult> => {
    const result = await receiveBotMessage(message, { identityResolver, coreConnector });
    results.push(result);
    return result;
  };

  return { dep, results };

}

async function driveHandler(
  envelope: unknown,
  receiveBotMessageDep: (message: BotIncomingMessage) => Promise<ReceiveBotMessageResult>,
  claimResult: "claimed" | "duplicate" | "error" = "claimed"
): Promise<{ status: number }> {

  const { rawBody, headers } = makeSignedRequest(envelope);

  // 絶対条件(Section13/20): handleSlackWebhookRequest()自身は
  // scheduleBackgroundWork()の戻り値(Promise)をawaitしない(ACK優先の
  // fire-and-forget、production既定のafter()と同じ意味論)。そのため
  // ここではtaskの実行Promiseを外側でcaptureし、response確定後に
  // 明示的にawaitしてから結果を検証する(testでだけ「background処理の
  // 完了を待つ」ことを許容する、production挙動自体は変更しない)。
  let scheduledPromise: Promise<void> | undefined;

  const response = await handleSlackWebhookRequest(rawBody, headers, {
    getSigningSecret: () => SIGNING_SECRET,
    claimExternalEvent: async () => claimResult,
    receiveBotMessage: receiveBotMessageDep,
    // S1e: このtest fileはApproval decision routing自体を対象としない
    // ため、常にmatched:falseを返す最小fake(既存receiveBotMessage
    // pathがそのまま使われる、既存Research routing regressionを
    // 変えない)。
    detectApprovalDecisionText: () => ({ matched: false }),
    receiveApprovalDecision: async () => ({ handled: false, actions: [] }),
    // このtest fileはSlack outbound配送自体を対象としない
    // (tests/tact/bot/slackOutbound*.test.tsが担う)ため、
    // BotAction[]を受け取って空の配送結果を返すだけの最小fake。
    executeBotActions: async () => [],
    scheduleBackgroundWork: (task) => {
      scheduledPromise = task();
    },
  });

  if (scheduledPromise) {
    await scheduledPromise;
  }

  return { status: response.status };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Section16/26: identity unresolved -> account-not-linked、Research 0 ----
  {
    let identityResolveCalls = 0;
    let runTrustedTurnCalls = 0;

    const identityResolver: BotIdentityResolver = {
      async resolve() {
        identityResolveCalls += 1;
        return null;
      },
    };

    const { dep, results: capturedResults } = makeReceiveBotMessageDep(identityResolver, {
      runTrustedTurn: async () => {
        runTrustedTurnCalls += 1;
        throw new Error("runTrustedTurn must not be called when identity is unresolved");
      },
      findLink: async () => null,
      createLink: async () => true,
    });

    await driveHandler(makeAppMentionEnvelope({ event_id: "Ev-unresolved-1" }), dep);

    const actions = capturedResults[0]?.actions ?? [];

    results.push(
      check(
        "[Section16/26] identity未解決の場合、BotActionはaccount-not-linked相当のreplyになり、Conversation/Work/Research(runTrustedTurn)へは一切進まない",
        identityResolveCalls === 1 &&
          runTrustedTurnCalls === 0 &&
          actions.length === 1 &&
          actions[0].kind === "reply" &&
          "text" in actions[0] &&
          actions[0].text.includes("連携")
      )
    );
  }

  // ---- Section21: duplicate delivery -> identity resolution自体0 ----
  {
    let identityResolveCalls = 0;

    const identityResolver: BotIdentityResolver = {
      async resolve() {
        identityResolveCalls += 1;
        return { tactUserId: "user-should-not-be-resolved" };
      },
    };

    const { dep } = makeReceiveBotMessageDep(identityResolver, {
      runTrustedTurn: async () => { throw new Error("must not be called"); },
      findLink: async () => null,
      createLink: async () => true,
    });

    const response = await driveHandler(makeAppMentionEnvelope({ event_id: "Ev-dup-routing-1" }), dep, "duplicate");

    results.push(
      check(
        "[Section21] duplicate delivery(claim=='duplicate')の場合、200 ACKを返すが、identity resolutionそのものが一切呼ばれない(receiveBotMessage自体が呼ばれないため)",
        response.status === 200 && identityResolveCalls === 0
      )
    );
  }

  // ---- Section8/15/16/17/27: resolved identity -> 実runOrchestration()経由でResearch capability 1回選択、結果がBotActionへ到達 ----
  {
    let researchInvocationCount = 0;

    registerCapability<ResearchParams, ResearchResult>("research", async () => {
      researchInvocationCount += 1;
      return {
        success: true,
        answer: "OpenAI research result",
        evidence: [],
        metadata: makeMetadata(),
      };
    });

    const identityResolver: BotIdentityResolver = {
      async resolve(actor) {
        return actor.externalUserId === "U456USER" ? { tactUserId: "user-123" } : null;
      },
    };

    let capturedTrustedTurnParams: RunConversationTurnAsTrustedActorParams | undefined;

    const fakeRunTrustedTurnViaRealOrchestration = async (
      params: RunConversationTurnAsTrustedActorParams
    ): Promise<RunConversationTurnAsTrustedActorResult> => {

      capturedTrustedTurnParams = params;

      // 絶対条件: userIdを渡すとbuildTaskContext()が実Supabaseへ
      // 問い合わせを試みる(tests/tact/orchestrator/orchestrateRoute.test.ts
      // Test Eと同じ既存の回避策——tactUserIdはこの層(runTrustedTurn呼び出し
      // 引数)で受け取ったことの確認にとどめ、runOrchestration()自体へは
      // 転送しない)。
      const orchestrationResult = await runOrchestration({ input: params.content });

      return {
        ok: true,
        conversation: { id: "fake-conv-research-1", userId: params.tactUserId, createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" },
        userMessage: { id: "fake-user-msg-1", conversationId: "fake-conv-research-1", role: "user", content: params.content, createdAt: "2026-09-08T00:00:00.000Z" },
        message: { id: "fake-assistant-msg-1", conversationId: "fake-conv-research-1", role: "assistant", content: orchestrationResult.answer, createdAt: "2026-09-08T00:00:00.000Z" },
      };

    };

    const { dep, results: capturedResults } = makeReceiveBotMessageDep(identityResolver, {
      runTrustedTurn: fakeRunTrustedTurnViaRealOrchestration,
      findLink: async () => null,
      createLink: async () => true,
    });

    await driveHandler(makeAppMentionEnvelope({ event_id: "Ev-research-1" }), dep);

    const actions = capturedResults[0]?.actions ?? [];

    results.push(
      check(
        "[Section13] trusted identity boundaryへ渡るのはtactUserId(解決済み'user-123')のみ、Slack external user id('U456USER')そのものではない",
        capturedTrustedTurnParams?.tactUserId === "user-123"
      )
    );

    results.push(
      check(
        "[Section11] runTrustedTurnへ渡るcontentは、Slack app_mentionのmention除去後のtext('OpenAIの最近の動向を調べて')そのもの",
        capturedTrustedTurnParams?.content === "OpenAIの最近の動向を調べて"
      )
    );

    results.push(
      check(
        "[Section8/16] 実runOrchestration()経由でResearch capabilityが正確に1回選択される(新しいSlack専用routingを追加せず、既存classifyIntent/decomposer/executor/Capability Registryをそのまま通した結果)",
        researchInvocationCount === 1
      )
    );

    results.push(
      check(
        "[Section18/27] 最終BotActionのkindはreply/deliver_resultのいずれか(既存conversationConnector.tsの分岐、Slack専用BotActionを新設していない)",
        actions.length >= 1 && (actions[0].kind === "reply" || actions[0].kind === "deliver_result")
      )
    );

    results.push(
      check(
        "[Section19/27] 最終BotActionのtextに、fake Research capabilityが返したanswer('OpenAI research result')がそのまま含まれる(Slack層でLLM再生成・要約・Research再実行をしていない)",
        actions.length >= 1 &&
          ((actions[0].kind === "reply" && "text" in actions[0] && actions[0].text.includes("OpenAI research result")) ||
            (actions[0].kind === "deliver_result" && "resultText" in actions[0] && !!actions[0].resultText?.includes("OpenAI research result")))
      )
    );
  }

  // ---- Section6/7/18/28: same-thread continuity / separate-thread ----
  {
    const linkStore = new Map<string, string>();

    function linkKey(params: ConversationLinkLookup): string {
      return `${params.channel}:${params.externalConversationId}:${params.externalThreadId ?? ""}`;
    }

    let nextConvId = 1;

    const identityResolver: BotIdentityResolver = {
      async resolve() {
        return { tactUserId: "user-thread-test" };
      },
    };

    const runTrustedTurnCalls: (string | undefined)[] = [];
    const resultingConversationIds: string[] = [];

    const fakeRunTrustedTurnSimple = async (
      params: RunConversationTurnAsTrustedActorParams
    ): Promise<RunConversationTurnAsTrustedActorResult> => {

      runTrustedTurnCalls.push(params.conversationId);

      const conversationId = params.conversationId ?? `conv-auto-${nextConvId++}`;

      resultingConversationIds.push(conversationId);

      return {
        ok: true,
        conversation: { id: conversationId, userId: params.tactUserId, createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" },
        userMessage: { id: `user-msg-${conversationId}`, conversationId, role: "user", content: params.content, createdAt: "2026-09-08T00:00:00.000Z" },
        message: { id: `assistant-msg-${conversationId}`, conversationId, role: "assistant", content: "ack", createdAt: "2026-09-08T00:00:00.000Z" },
      };

    };

    const { dep } = makeReceiveBotMessageDep(identityResolver, {
      runTrustedTurn: fakeRunTrustedTurnSimple,
      findLink: async (params) => linkStore.get(linkKey(params)) ?? null,
      createLink: async (params) => {
        linkStore.set(linkKey(params), params.tactConversationId);
        return true;
      },
    });

    // message1: channel C1 / thread TS1(新規thread、このmessage自身がroot)。
    await driveHandler(
      makeAppMentionEnvelope({
        event_id: "Ev-thread-1",
        event: { type: "app_mention", user: "U456USER", text: "<@U999TACTBOT> 1件目", ts: "TS1", channel: "C1" },
      }),
      dep
    );

    // message2: 同じchannel C1 / 同じthread(thread_ts=TS1) -> 同一Conversation。
    await driveHandler(
      makeAppMentionEnvelope({
        event_id: "Ev-thread-2",
        event: { type: "app_mention", user: "U456USER", text: "<@U999TACTBOT> 2件目(同じthread)", ts: "TS1-reply-1", channel: "C1", thread_ts: "TS1" },
      }),
      dep
    );

    // message3: 同じchannel C1 / 別thread(thread_ts無し、別message自身がroot) -> 別Conversation。
    await driveHandler(
      makeAppMentionEnvelope({
        event_id: "Ev-thread-3",
        event: { type: "app_mention", user: "U456USER", text: "<@U999TACTBOT> 別件", ts: "TS2", channel: "C1" },
      }),
      dep
    );

    results.push(
      check(
        "[Section18/28-同一thread] 同じchannel+threadの2件目は、1件目がcreateLinkしたTACT ConversationIdをfindLinkで再利用し、同一Conversationとして継続する(runTrustedTurnの2回目呼び出しに1回目のconversationIdが渡る)",
        runTrustedTurnCalls[0] === undefined && runTrustedTurnCalls[1] === "conv-auto-1"
      )
    );

    results.push(
      check(
        "[Section18/28-別thread] 別thread(TS2)の3件目はfindLinkが見つからず新規Conversationとして扱われ(runTrustedTurnへconversationId=undefinedで渡る)、実際に払い出されるConversationId(conv-auto-2)は1件目/2件目のconv-auto-1とは異なる",
        runTrustedTurnCalls[2] === undefined &&
          resultingConversationIds[0] === "conv-auto-1" &&
          resultingConversationIds[1] === "conv-auto-1" &&
          resultingConversationIds[2] === "conv-auto-2"
      )
    );
  }

  return summarize("bot/slackBotResearchRouting", results);

}
