// =========================
// TACT Bot — Slack Inbound -> TACT Research -> Slack Outbound
// End-to-End Regression (S1c)
// =========================
//
// 対象: core/tact-bot/adapters/slack/handleSlackWebhookRequest.tsを
// 実際のSlack app_mention envelope(署名付き)で駆動し、
//   Slack payload -> BotIncomingMessage(実normalizeSlackAppMentionEvent())
//   -> receiveBotMessage()(実identity解決[fake resolver] + 実
//      conversationConnector.ts) -> 実runOrchestration()経由でResearch
//      capability(fake、"OpenAI research result"を返す) -> BotAction[]
//   -> 実executeBotActions()(既存BotAction execution gateway)
//   -> Slack ChannelAdapter(実createSlackChannelAdapter()) ->
//      fake SlackWebApiClient.postMessage()
// までを一気通貫でlive Supabase/live LLM/live Search/live Slackへ
// 一切接続せずに証明する(絶対条件Section18/28)。
//
// 併せて、以下も本fileで確認する。
//   - 重複end-to-end(Section29): 同一event_idの再送は2回目のACKのみ、
//     identity解決0・Research 0・Slack outbound 0
//   - background failure(Section30): Research/Slack送信のいずれかで
//     例外が起きても、HTTP ACKは既に返っており、background task自体は
//     unhandled rejectionを発生させない(自動retryもしない)

import { createHmac } from "node:crypto";
import {
  handleSlackWebhookRequest,
  type HandleSlackWebhookRequestDeps,
  type SlackWebhookHeaders,
} from "../../../core/tact-bot/adapters/slack/handleSlackWebhookRequest";
import { receiveBotMessage } from "../../../core/tact-bot/gateway/receiveMessage";
import { executeBotActions } from "../../../core/tact-bot/gateway/executeBotActions";
import { createSlackChannelAdapter } from "../../../core/tact-bot/adapters/slack/slackChannelAdapter";
import type {
  SlackPostMessageParams,
  SlackPostMessageResult,
  SlackWebApiClient,
} from "../../../core/tact-bot/adapters/slack/slackClient";
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
import type { ChannelAdapterRegistry } from "../../../core/tact-bot/adapters/types";
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
    event_id: "Ev-e2e-1",
    event_time: 1893456000,
    event: {
      type: "app_mention",
      user: "U789USER",
      text: "<@U999TACTBOT> OpenAIの最近の動向を調べて",
      ts: "1893456000.000100",
      channel: "C_E2E",
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

function makeFakeSlackClient(
  behavior?: (params: SlackPostMessageParams, callIndex: number) => SlackPostMessageResult
): { client: SlackWebApiClient; calls: SlackPostMessageParams[] } {

  const calls: SlackPostMessageParams[] = [];

  const client: SlackWebApiClient = {
    async postMessage(params) {
      calls.push(params);
      if (behavior) {
        const result = behavior(params, calls.length - 1);
        if (result.ok === false && result.error === "__throw__") {
          throw new Error("fake Slack client failure");
        }
        return result;
      }
      return { ok: true, ts: `ts-${calls.length}` };
    },
  };

  return { client, calls };

}

function makeConnectorDeps(runTrustedTurn: (
  params: RunConversationTurnAsTrustedActorParams
) => Promise<RunConversationTurnAsTrustedActorResult>): {
  runTrustedTurn: typeof runTrustedTurn;
  findLink: (params: ConversationLinkLookup) => Promise<string | null>;
  createLink: (params: ConversationLinkCreate) => Promise<boolean>;
} {
  return {
    runTrustedTurn,
    findLink: async () => null,
    createLink: async () => true,
  };
}

function makeRunTrustedTurnViaRealOrchestration(): (
  params: RunConversationTurnAsTrustedActorParams
) => Promise<RunConversationTurnAsTrustedActorResult> {

  return async (params) => {

    const orchestrationResult = await runOrchestration({ input: params.content });

    return {
      ok: true,
      conversation: {
        id: "fake-conv-e2e-1",
        userId: params.tactUserId,
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
      },
      userMessage: {
        id: "fake-user-msg-e2e-1",
        conversationId: "fake-conv-e2e-1",
        role: "user",
        content: params.content,
        createdAt: "2026-09-08T00:00:00.000Z",
      },
      message: {
        id: "fake-assistant-msg-e2e-1",
        conversationId: "fake-conv-e2e-1",
        role: "assistant",
        content: orchestrationResult.answer,
        createdAt: "2026-09-08T00:00:00.000Z",
      },
    };

  };

}

async function driveHandler(
  envelope: unknown,
  deps: Omit<
    HandleSlackWebhookRequestDeps,
    "getSigningSecret" | "scheduleBackgroundWork" | "claimExternalEvent" | "detectApprovalDecisionText" | "receiveApprovalDecision"
  >,
  claimResult: "claimed" | "duplicate" | "error" = "claimed"
): Promise<{ status: number; unhandledRejections: unknown[] }> {

  const unhandledRejections: unknown[] = [];
  const listener = (reason: unknown) => { unhandledRejections.push(reason); };
  process.on("unhandledRejection", listener);

  try {

    const { rawBody, headers } = makeSignedRequest(envelope);

    // 絶対条件(Section19/20): handleSlackWebhookRequest()自身は
    // scheduleBackgroundWork()の戻り値をawaitしない(ACK優先の
    // fire-and-forget)。testではtaskの実行Promiseを外側でcaptureし、
    // response確定後に明示的にawaitしてから結果を検証する。
    let scheduledPromise: Promise<void> | undefined;

    const response = await handleSlackWebhookRequest(rawBody, headers, {
      getSigningSecret: () => SIGNING_SECRET,
      claimExternalEvent: async () => claimResult,
      // S1e: このtest fileはSlack outbound配送のend-to-end検証が
      // 目的であり、Approval decision routing自体は対象としない
      // ため、常にmatched:falseを返す最小fake(既存receiveBotMessage
      // pathがそのまま使われる、既存挙動を変えない)。
      detectApprovalDecisionText: () => ({ matched: false }),
      receiveApprovalDecision: async () => ({ handled: false, actions: [] }),
      ...deps,
      scheduleBackgroundWork: (task) => {
        scheduledPromise = task();
      },
    });

    if (scheduledPromise) {
      await scheduledPromise;
    }

    // background task内で何らかのfloating promiseが残っていた場合に
    // unhandledRejection eventがmicrotask queue経由で発火するのを
    // 拾えるよう、1 tick待つ。
    await new Promise((resolve) => setImmediate(resolve));

    return { status: response.status, unhandledRejections };

  } finally {

    process.off("unhandledRejection", listener);

  }

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Section28: full end-to-end local test ----
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
        return actor.externalUserId === "U789USER" ? { tactUserId: "user-e2e-1" } : null;
      },
    };

    const coreConnector = createConversationBotCoreConnector(
      makeConnectorDeps(makeRunTrustedTurnViaRealOrchestration())
    );

    const { client: fakeSlackClient, calls: slackCalls } = makeFakeSlackClient();
    const registry: ChannelAdapterRegistry = { slack: createSlackChannelAdapter({ client: fakeSlackClient }) };

    const { status } = await driveHandler(makeAppMentionEnvelope({ event_id: "Ev-e2e-1" }), {
      receiveBotMessage: (message) => receiveBotMessage(message, { identityResolver, coreConnector }),
      executeBotActions: (actions) => executeBotActions(actions, registry),
    });

    results.push(
      check(
        "[Section28] 署名付きapp_mention -> 200 ACK",
        status === 200
      )
    );

    results.push(
      check(
        "[Section28] 実runOrchestration()経由でResearch capabilityが正確に1回選択される",
        researchInvocationCount === 1
      )
    );

    results.push(
      check(
        "[Section28] fake Slack clientのpostMessageが正確に1回呼ばれる(chat.postMessage相当)",
        slackCalls.length === 1
      )
    );

    results.push(
      check(
        "[Section28] {channel, thread_ts, text}が期待どおり: channel='C_E2E'、threadTs=root message ts('1893456000.000100')、textにResearch結果('OpenAI research result')がそのまま含まれる",
        slackCalls[0]?.channel === "C_E2E" &&
          slackCalls[0]?.threadTs === "1893456000.000100" &&
          typeof slackCalls[0]?.text === "string" &&
          slackCalls[0].text.includes("OpenAI research result")
      )
    );
  }

  // ---- Section29: 重複end-to-end ----
  {
    let identityResolveCalls = 0;
    let researchInvocationCount = 0;

    registerCapability<ResearchParams, ResearchResult>("research", async () => {
      researchInvocationCount += 1;
      return { success: true, answer: "should not be reached", evidence: [], metadata: makeMetadata() };
    });

    const identityResolver: BotIdentityResolver = {
      async resolve() {
        identityResolveCalls += 1;
        return { tactUserId: "user-dup-e2e-1" };
      },
    };

    const coreConnector = createConversationBotCoreConnector(
      makeConnectorDeps(makeRunTrustedTurnViaRealOrchestration())
    );

    const { client: fakeSlackClient, calls: slackCalls } = makeFakeSlackClient();
    const registry: ChannelAdapterRegistry = { slack: createSlackChannelAdapter({ client: fakeSlackClient }) };

    const deps = {
      receiveBotMessage: (message: Parameters<typeof receiveBotMessage>[0]) =>
        receiveBotMessage(message, { identityResolver, coreConnector }),
      executeBotActions: (actions: Parameters<typeof executeBotActions>[0]) => executeBotActions(actions, registry),
    };

    const envelope = makeAppMentionEnvelope({ event_id: "Ev-e2e-dup-1" });

    const first = await driveHandler(envelope, deps, "claimed");
    const second = await driveHandler(envelope, deps, "duplicate");

    results.push(
      check(
        "[Section29] 1回目(claimed)は200・Slack outbound 1回、2回目(同一event_idのduplicate)も200 ACKを返す",
        first.status === 200 && second.status === 200 && slackCalls.length === 1
      )
    );

    results.push(
      check(
        "[Section29] 2回目(duplicate)ではidentity resolution・Research・Slack outboundのいずれも追加で実行されない(1回目の1回のみ)",
        identityResolveCalls === 1 && researchInvocationCount === 1 && slackCalls.length === 1
      )
    );
  }

  // ---- Section30: background failure(Research側で例外) ----
  {
    const identityResolver: BotIdentityResolver = {
      async resolve() {
        return { tactUserId: "user-bgfail-research-1" };
      },
    };

    const coreConnector = createConversationBotCoreConnector(
      makeConnectorDeps(async () => {
        throw new Error("fake trusted turn failure (research side)");
      })
    );

    const { client: fakeSlackClient, calls: slackCalls } = makeFakeSlackClient();
    const registry: ChannelAdapterRegistry = { slack: createSlackChannelAdapter({ client: fakeSlackClient }) };

    const { status, unhandledRejections } = await driveHandler(
      makeAppMentionEnvelope({ event_id: "Ev-e2e-bgfail-research-1" }),
      {
        receiveBotMessage: (message) => receiveBotMessage(message, { identityResolver, coreConnector }),
        executeBotActions: (actions) => executeBotActions(actions, registry),
      }
    );

    results.push(
      check(
        "[Section30/Research側失敗] HTTP ACKは200のまま(既にACK済み)、background failureがunhandled rejectionとして漏れない、Slack outboundは一切実行されない(自動retryなし)",
        status === 200 && unhandledRejections.length === 0 && slackCalls.length === 0
      )
    );
  }

  // ---- Section30: background failure(Slack outbound側で例外) ----
  {
    const identityResolver: BotIdentityResolver = {
      async resolve() {
        return { tactUserId: "user-bgfail-slack-1" };
      },
    };

    const coreConnector = createConversationBotCoreConnector(
      makeConnectorDeps(async (params) => ({
        ok: true,
        conversation: {
          id: "fake-conv-bgfail-slack-1",
          userId: params.tactUserId,
          createdAt: "2026-09-08T00:00:00.000Z",
          updatedAt: "2026-09-08T00:00:00.000Z",
        },
        userMessage: {
          id: "fake-user-msg-bgfail-slack-1",
          conversationId: "fake-conv-bgfail-slack-1",
          role: "user",
          content: params.content,
          createdAt: "2026-09-08T00:00:00.000Z",
        },
        message: {
          id: "fake-assistant-msg-bgfail-slack-1",
          conversationId: "fake-conv-bgfail-slack-1",
          role: "assistant",
          content: "ack",
          createdAt: "2026-09-08T00:00:00.000Z",
        },
      }))
    );

    // fake Slack clientのpostMessage自体が例外を投げるケース
    // (executeBotActions.tsの既存try/catchでBotActionDeliveryResultへ
    // 変換されるが、それでもhandleSlackWebhookRequest側のbackground
    // try/catchがunhandled rejectionを生まないことを確認する)。
    const { client: fakeSlackClient, calls: slackCalls } = makeFakeSlackClient(() => ({
      ok: false,
      error: "__throw__",
    }));

    const registry: ChannelAdapterRegistry = { slack: createSlackChannelAdapter({ client: fakeSlackClient }) };

    const { status, unhandledRejections } = await driveHandler(
      makeAppMentionEnvelope({ event_id: "Ev-e2e-bgfail-slack-1" }),
      {
        receiveBotMessage: (message) => receiveBotMessage(message, { identityResolver, coreConnector }),
        executeBotActions: (actions) => executeBotActions(actions, registry),
      }
    );

    results.push(
      check(
        "[Section30/Slack outbound側失敗] fake Slack clientが例外を投げても、HTTP ACKは200のまま・unhandled rejectionは発生しない(postMessageは正確に1回のみ呼ばれ、自動retryしない)",
        status === 200 && unhandledRejections.length === 0 && slackCalls.length === 1
      )
    );
  }

  return summarize("bot/slackOutboundEndToEnd", results);

}
