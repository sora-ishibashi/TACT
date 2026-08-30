// =========================
// TACT Bot — Conversation Connector Regression (BOT-P2)
// =========================
//
// 対象: core/tact-bot/connector/conversationConnector.tsの
// createConversationBotCoreConnector()(実行部分のみを、fakeな
// runTurn/findLink/createLink/getAccessTokenへ差し替えてテストする)。
//
// 環境制約: 実Supabase・実LLM・実Search APIは一切呼ばない。
// createConversationBotCoreConnector()自体は依存を全てDIで受け取る
// 設計のため、fakeのみでロジック(identity/service role gate・
// conversation link解決・retry・BotAction変換)を検証できる。
// 本番配線(createSupabaseConversationBotCoreConnector())自体は
// 実Supabaseアクセスを伴うため、この既存repository方針
// (core/tact-attachment/repository.ts等と同じ)によりここではテスト
// しない。

import "dotenv/config";
import {
  createConversationBotCoreConnector,
  type ConversationBotCoreConnectorDeps,
  type ConversationLinkCreate,
  type ConversationLinkLookup,
} from "../../../core/tact-bot/connector/conversationConnector";
import type {
  RunConversationTurnParams,
  RunConversationTurnResult,
} from "../../../core/tact-conversation";
import type { Conversation, ConversationMessage } from "../../../core/tact-conversation/types";
import type { BotContext, BotIncomingMessage } from "../../../core/tact-bot/types";
import { buildBotContext } from "../../../core/tact-bot/context/buildBotContext";
import { check, summarize, type CheckResult } from "../lib/check";

function makeMessage(overrides: Partial<BotIncomingMessage> = {}): BotIncomingMessage {

  return {
    channel: "slack",
    actor: { externalUserId: "U-external-123" },
    conversation: { externalConversationId: "C1", type: "channel", threadId: "T1" },
    messageId: "m1",
    text: "@TACT SROIについて調べて",
    mentionedTact: true,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };

}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {

  return {
    id: "conv-1",
    userId: "tact-user-1",
    title: "SROIについて調べて",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };

}

function makeMessageRow(overrides: Partial<ConversationMessage> = {}): ConversationMessage {

  return {
    id: "msg-1",
    conversationId: "conv-1",
    role: "assistant",
    content: "SROIについての回答です。",
    createdAt: "2026-08-30T00:01:00.000Z",
    ...overrides,
  };

}

function okResult(overrides: {
  conversation?: Partial<Conversation>;
  message?: Partial<ConversationMessage>;
} = {}): Extract<RunConversationTurnResult, { ok: true }> {

  const conversation = makeConversation(overrides.conversation);
  const message = makeMessageRow(overrides.message);

  return {
    ok: true,
    conversation,
    userMessage: makeMessageRow({ id: "user-msg-1", role: "user", content: "SROIについて調べて" }),
    message,
  };

}

interface RecordingDeps {
  deps: ConversationBotCoreConnectorDeps;
  runTurnCalls: RunConversationTurnParams[];
  findLinkCalls: ConversationLinkLookup[];
  createLinkCalls: ConversationLinkCreate[];
}

function recordingDeps(options: {
  accessToken?: string | null;
  existingTactConversationId?: string | null;
  runTurnResults?: RunConversationTurnResult[];
} = {}): RecordingDeps {

  const runTurnCalls: RunConversationTurnParams[] = [];
  const findLinkCalls: ConversationLinkLookup[] = [];
  const createLinkCalls: ConversationLinkCreate[] = [];

  const results = options.runTurnResults ?? [okResult()];
  let callIndex = 0;

  const deps: ConversationBotCoreConnectorDeps = {

    async runTurn(params) {
      runTurnCalls.push(params);
      const result = results[Math.min(callIndex, results.length - 1)];
      callIndex += 1;
      return result;
    },

    async findLink(params) {
      findLinkCalls.push(params);
      return options.existingTactConversationId ?? null;
    },

    async createLink(params) {
      createLinkCalls.push(params);
      return true;
    },

    getAccessToken() {
      return options.accessToken === undefined ? "service-role-key-fixture" : options.accessToken;
    },

  };

  return { deps, runTurnCalls, findLinkCalls, createLinkCalls };

}

function contextWithIdentity(
  message: BotIncomingMessage,
  tactUserId: string | null
): BotContext {
  return buildBotContext(message, tactUserId ? { tactUserId } : null);
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Security: identity未解決時は業務実行しない
  // ==========================================================

  {
    const { deps, runTurnCalls, findLinkCalls, createLinkCalls } = recordingDeps();
    const connector = createConversationBotCoreConnector(deps);
    const context = contextWithIdentity(makeMessage(), null);

    const actions = await connector.handle(context);

    results.push(
      check(
        "[Security-1] identity未解決時、reply Actionを1件だけ返し「連携が必要」を含む",
        actions.length === 1 && actions[0].kind === "reply" && actions[0].text.includes("連携")
      )
    );

    results.push(
      check(
        "[Security-2] identity未解決時、runTurn/findLink/createLinkのいずれも呼ばれない(業務実行しない絶対条件)",
        runTurnCalls.length === 0 && findLinkCalls.length === 0 && createLinkCalls.length === 0
      )
    );

  }

  {
    const { deps } = recordingDeps();
    const connector = createConversationBotCoreConnector({
      ...deps,
      accountLinkingUrl: "https://tact.example.com/link",
    });

    const actions = await connector.handle(contextWithIdentity(makeMessage(), null));

    results.push(
      check(
        "[Security-3] accountLinkingUrlを設定した場合、案内メッセージにURLが含まれる",
        actions[0].kind === "reply" && actions[0].text.includes("https://tact.example.com/link")
      )
    );

  }

  // ==========================================================
  // Security: service role未設定時は業務実行しない
  // ==========================================================

  {
    const { deps, runTurnCalls } = recordingDeps({ accessToken: null });
    const connector = createConversationBotCoreConnector(deps);

    const actions = await connector.handle(contextWithIdentity(makeMessage(), "tact-user-1"));

    results.push(
      check(
        "[Security-4] service role未設定時、reply1件を返しrunTurnを呼ばない",
        actions.length === 1 && actions[0].kind === "reply" && runTurnCalls.length === 0
      )
    );

  }

  // ==========================================================
  // Security: userIdは常にresolve済みのtactUserId(外部messageの
  // 値をそのまま信用しない)
  // ==========================================================

  {
    const { deps, runTurnCalls } = recordingDeps();
    const connector = createConversationBotCoreConnector(deps);

    // actor.externalUserIdが仮に他人のTACT user idと同じ文字列
    // だったとしても、runTurnへ渡るuserIdは常にidentity.tactUserId
    // (resolverが検証済みの値)であることを確認する。
    const spoofLikeMessage = makeMessage({ actor: { externalUserId: "tact-user-victim" } });
    const context = contextWithIdentity(spoofLikeMessage, "tact-user-1-correctly-resolved");

    await connector.handle(context);

    results.push(
      check(
        "[Security-5] runTurnへ渡るuserIdはidentity.tactUserIdであり、外部actor.externalUserIdではない",
        runTurnCalls[0]?.userId === "tact-user-1-correctly-resolved"
      )
    );

  }

  // ==========================================================
  // 新規Conversation(既存linkなし)
  // ==========================================================

  {
    const { deps, runTurnCalls, findLinkCalls, createLinkCalls } = recordingDeps({
      existingTactConversationId: null,
    });
    const connector = createConversationBotCoreConnector(deps);

    const actions = await connector.handle(contextWithIdentity(makeMessage(), "tact-user-1"));

    results.push(
      check(
        "[Test1-1] 既存linkが無い場合、conversationId未指定でrunTurnを呼ぶ(新規作成)",
        runTurnCalls.length === 1 && runTurnCalls[0].conversationId === undefined
      )
    );

    results.push(
      check(
        "[Test1-2] findLinkはchannel/externalConversationId/threadIdで呼ばれる",
        findLinkCalls[0]?.channel === "slack" &&
          findLinkCalls[0]?.externalConversationId === "C1" &&
          findLinkCalls[0]?.externalThreadId === "T1"
      )
    );

    results.push(
      check(
        "[Test1-3] 成功後、新しく作られたconversation.idでcreateLinkが呼ばれる(以後の継続のため)",
        createLinkCalls.length === 1 && createLinkCalls[0].tactConversationId === "conv-1"
      )
    );

    results.push(
      check(
        "[Test1-4] 通常回答はreply Actionになる",
        actions.length === 1 && actions[0].kind === "reply" && actions[0].text === "SROIについての回答です。"
      )
    );

  }

  // ==========================================================
  // 既存Conversationの継続(同一thread)
  // ==========================================================

  {
    const { deps, runTurnCalls } = recordingDeps({ existingTactConversationId: "conv-existing" });
    const connector = createConversationBotCoreConnector(deps);

    await connector.handle(contextWithIdentity(makeMessage(), "tact-user-1"));

    results.push(
      check(
        "[Test2-1] 既存linkがある場合、そのconversationIdでrunTurnを呼ぶ(同一thread続き)",
        runTurnCalls[0]?.conversationId === "conv-existing"
      )
    );

  }

  // ==========================================================
  // Clarification応答
  // ==========================================================

  {
    const { deps } = recordingDeps({
      runTurnResults: [
        okResult({ message: { messageType: "clarification_question", content: "対象期間はいつですか？" } }),
      ],
    });
    const connector = createConversationBotCoreConnector(deps);

    const actions = await connector.handle(contextWithIdentity(makeMessage(), "tact-user-1"));

    results.push(
      check(
        "[Test3-1] clarificationはreply Actionとして質問文を返す",
        actions.length === 1 && actions[0].kind === "reply" && actions[0].text === "対象期間はいつですか？"
      )
    );

  }

  // ==========================================================
  // Artifactが紐付いた場合はdeliver_result
  // ==========================================================

  {
    const { deps } = recordingDeps({
      runTurnResults: [okResult({ conversation: { artifactId: "artifact-1" } })],
    });
    const connector = createConversationBotCoreConnector(deps);

    const actions = await connector.handle(contextWithIdentity(makeMessage(), "tact-user-1"));

    results.push(
      check(
        "[Test4-1] Artifactが紐付いた場合、deliver_result Actionになりartifactidを保持する",
        actions.length === 1 &&
          actions[0].kind === "deliver_result" &&
          actions[0].artifactId === "artifact-1"
      )
    );

  }

  // ==========================================================
  // stale link(conversation_not_found) → 1回だけ新規作成にfallback
  // ==========================================================

  {
    const { deps, runTurnCalls, createLinkCalls } = recordingDeps({
      existingTactConversationId: "conv-deleted",
      runTurnResults: [{ ok: false, error: "conversation_not_found" }, okResult({ conversation: { id: "conv-fresh" } })],
    });
    const connector = createConversationBotCoreConnector(deps);

    const actions = await connector.handle(contextWithIdentity(makeMessage(), "tact-user-1"));

    results.push(
      check(
        "[Test5-1] stale linkの場合、conversationId未指定で1回だけ再試行する",
        runTurnCalls.length === 2 &&
          runTurnCalls[0].conversationId === "conv-deleted" &&
          runTurnCalls[1].conversationId === undefined
      )
    );

    results.push(
      check(
        "[Test5-2] 再試行成功後、新しいconversation.idでlinkを更新する",
        createLinkCalls[0]?.tactConversationId === "conv-fresh"
      )
    );

    results.push(
      check(
        "[Test5-3] 再試行成功後は通常通りBotActionを返す",
        actions.length === 1 && actions[0].kind === "reply"
      )
    );

  }

  // ==========================================================
  // 再試行後も失敗した場合は安全なエラーreplyを返す
  // ==========================================================

  {
    const { deps } = recordingDeps({
      existingTactConversationId: "conv-deleted",
      runTurnResults: [
        { ok: false, error: "conversation_not_found" },
        { ok: false, error: "conversation_not_found" },
      ],
    });
    const connector = createConversationBotCoreConnector(deps);

    const actions = await connector.handle(contextWithIdentity(makeMessage(), "tact-user-1"));

    results.push(
      check(
        "[Test6-1] 再試行後も失敗した場合、例外を投げず安全なエラーreplyを返す",
        actions.length === 1 && actions[0].kind === "reply"
      )
    );

  }

  // ==========================================================
  // unknown channel(識別不能): link解決自体を行わない
  // ==========================================================

  {
    const { deps, findLinkCalls, createLinkCalls, runTurnCalls } = recordingDeps();
    const connector = createConversationBotCoreConnector(deps);

    const message = makeMessage({ channel: "unknown" });
    const actions = await connector.handle(contextWithIdentity(message, "tact-user-1"));

    results.push(
      check(
        "[Test7-1] unknown channelはfindLink/createLinkを呼ばず、常に新規Conversationとして扱う",
        findLinkCalls.length === 0 && createLinkCalls.length === 0 && runTurnCalls[0]?.conversationId === undefined
      )
    );

    results.push(
      check(
        "[Test7-2] unknown channelでも通常通り応答は返る",
        actions.length === 1
      )
    );

  }

  return summarize("bot/conversationConnector", results);

}
