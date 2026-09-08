// =========================
// TACT Bot — Slack Text Approval Decision Routing Regression (S1e)
// =========================
//
// 対象:
//   1. core/tact-bot/adapters/slack/productionBotCore.tsの
//      receiveSlackBotApprovalDecisionAsTrustedActor()
//      (identity解決 → thread相関 → canonical
//      receiveBotApprovalDecision()への委譲、をDIで検証)
//   2. core/tact-bot/adapters/slack/handleSlackWebhookRequest.tsの
//      「decision text matchならreceiveBotMessage()へ絶対に
//      fallbackしない」というrouting分岐そのもの
//
// 実Supabase・実LLM・実Slack APIには一切接続しない。

import { createHmac } from "node:crypto";
import {
  receiveSlackBotApprovalDecisionAsTrustedActor,
  type ReceiveSlackBotApprovalDecisionDeps,
} from "../../../core/tact-bot/adapters/slack/productionBotCore";
import {
  handleSlackWebhookRequest,
  type SlackWebhookHeaders,
} from "../../../core/tact-bot/adapters/slack/handleSlackWebhookRequest";
import type { BotIdentityResolver } from "../../../core/tact-bot/identity/resolver";
import type {
  ResolvePendingApprovalForThreadParams,
  ResolvePendingApprovalForThreadResult,
} from "../../../core/tact-bot/execution/resolvePendingApprovalForThread";
import type { ReceiveBotApprovalDecisionResult } from "../../../core/tact-bot/gateway/receiveApprovalDecision";
import type { BotApprovalDecision, BotIncomingMessage } from "../../../core/tact-bot/types";
import type { ApprovalDecisionTextMatch } from "../../../core/tact-bot/adapters/slack/detectApprovalDecisionText";
import type { Approval } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeMessage(overrides: Partial<BotIncomingMessage> = {}): BotIncomingMessage {
  return {
    channel: "slack",
    actor: { externalUserId: "U123EXTERNAL" },
    conversation: { externalConversationId: "C123", type: "channel", threadId: "TS1" },
    organizationId: "T123TEAM",
    messageId: "TS1",
    text: "承認",
    mentionedTact: true,
    receivedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "integration.slack.send_message",
    requestedFromActorKind: "user",
    requestedFromActorId: "user-1",
    status: "pending",
    reason: "test",
    payload: {},
    requestedAt: "2026-09-10T00:00:00.000Z",
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReceiveSlackBotApprovalDecisionDeps> = {}): {
  deps: ReceiveSlackBotApprovalDecisionDeps;
  identityResolveCalls: number;
  resolveCalls: ResolvePendingApprovalForThreadParams[];
  receiveBotApprovalDecisionCalls: BotApprovalDecision[];
} {

  const identityResolveState = { count: 0 };
  const resolveCalls: ResolvePendingApprovalForThreadParams[] = [];
  const receiveBotApprovalDecisionCalls: BotApprovalDecision[] = [];

  const identityResolver: BotIdentityResolver = {
    async resolve(actor) {
      identityResolveState.count += 1;
      return actor.externalUserId === "U123EXTERNAL" ? { tactUserId: "trusted-user-1" } : null;
    },
  };

  const resolvePendingApprovalForThread = async (
    params: ResolvePendingApprovalForThreadParams
  ): Promise<ResolvePendingApprovalForThreadResult> => {
    resolveCalls.push(params);
    return { status: "resolved", workId: "work-1", approval: makeApproval() };
  };

  const receiveBotApprovalDecision = async (
    decision: BotApprovalDecision
  ): Promise<ReceiveBotApprovalDecisionResult> => {
    receiveBotApprovalDecisionCalls.push(decision);
    return {
      handled: true,
      outcomeStatus: decision.decision === "approve" ? "approved" : "rejected",
      actions: [
        {
          kind: "reply",
          target: decision.target,
          inReplyToMessageId: decision.inReplyToMessageId,
          text: decision.decision === "approve" ? "承認しました。" : "却下しました。",
        },
      ],
    };
  };

  const deps: ReceiveSlackBotApprovalDecisionDeps = {
    identityResolver,
    resolvePendingApprovalForThread,
    receiveBotApprovalDecision,
    ...overrides,
  };

  return {
    deps,
    get identityResolveCalls() {
      return identityResolveState.count;
    },
    resolveCalls,
    receiveBotApprovalDecisionCalls,
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case20/21: identity未解決 -> decideできない、tactUserIdは外部idそのものではない ----
  {
    const { deps, receiveBotApprovalDecisionCalls } = makeDeps();

    const result = await receiveSlackBotApprovalDecisionAsTrustedActor(
      makeMessage({ actor: { externalUserId: "U_UNKNOWN" } }),
      "approve",
      deps
    );

    results.push(
      check(
        "[Case20] identity未解決の外部actorはdecideできない(handled:false)、canonical receiverへも一切到達しない",
        result.handled === false && receiveBotApprovalDecisionCalls.length === 0
      )
    );

    const text = result.actions[0]?.kind === "reply" ? result.actions[0].text : "";
    results.push(
      check(
        "[Case20] identity未解決時の返信は連携案内の固定文言(raw情報を含まない)",
        text === "このアカウントはまだTACTアカウントと連携されていません。連携後にもう一度お試しください。"
      )
    );
  }

  // ---- Case21: 解決済みtactUserIdがcanonical receiverへ渡る(外部idそのものではない) ----
  {
    const { deps, receiveBotApprovalDecisionCalls, resolveCalls } = makeDeps();

    await receiveSlackBotApprovalDecisionAsTrustedActor(makeMessage(), "approve", deps);

    results.push(
      check(
        "[Case21] pending Approval解決へ渡るtactUserIdは、identityResolverが解決した'trusted-user-1'であり、外部Slack user id('U123EXTERNAL')そのものではない",
        resolveCalls[0]?.tactUserId === "trusted-user-1"
      )
    );

    results.push(
      check(
        "[Case21] canonical receiveBotApprovalDecision()へ渡るBotApprovalDecision.actor.externalUserIdは、あくまでexternal識別子であり、tactUserIdという値自体を含まない(型定義上も存在しない)",
        receiveBotApprovalDecisionCalls[0]?.actor.externalUserId === "U123EXTERNAL" &&
          !("tactUserId" in (receiveBotApprovalDecisionCalls[0] as unknown as Record<string, unknown>))
      )
    );
  }

  // ---- Case22: 他人のApproval(ownership不一致) -> resolvePendingApprovalForThreadがwork_missingを返す形で構造的に防がれる ----
  {
    const { deps, receiveBotApprovalDecisionCalls } = makeDeps({
      resolvePendingApprovalForThread: async () => ({ status: "work_missing" }),
    });

    const result = await receiveSlackBotApprovalDecisionAsTrustedActor(makeMessage(), "approve", deps);

    results.push(
      check(
        "[Case22] 他user所有のWork(ownership不一致でgetConversation()がundefinedを返すケース相当)は、work_missingとして安全に拒否され、canonical receiverへ到達しない",
        result.handled === false && receiveBotApprovalDecisionCalls.length === 0
      )
    );
  }

  // ---- Case16/no_pending_approval, Caseambiguous: 安全な固定reply ----
  {
    const noPending = await receiveSlackBotApprovalDecisionAsTrustedActor(
      makeMessage(),
      "approve",
      makeDeps({ resolvePendingApprovalForThread: async () => ({ status: "no_pending_approval" }) }).deps
    );

    const noPendingText = noPending.actions[0]?.kind === "reply" ? noPending.actions[0].text : "";

    results.push(
      check(
        "[no_pending_approval] 承認待ちが無い場合、安全な固定文言を返す(承認待ちが見つからなかったことだけを伝える)",
        noPendingText === "承認待ちの操作が見つかりませんでした。"
      )
    );

    const ambiguous = await receiveSlackBotApprovalDecisionAsTrustedActor(
      makeMessage(),
      "approve",
      makeDeps({ resolvePendingApprovalForThread: async () => ({ status: "ambiguous_pending_approval", count: 2 }) }).deps
    );

    const ambiguousText = ambiguous.actions[0]?.kind === "reply" ? ambiguous.actions[0].text : "";

    results.push(
      check(
        "[Case18] pendingが複数ある場合、どちらか一方を自動選択せず、安全な固定文言(件数等の詳細を出さない)を返す",
        ambiguousText === "承認待ちの操作が複数あるため、自動では判定できません。担当者にご確認ください。" &&
          !ambiguousText.includes("2")
      )
    );
  }

  // ---- Case23: 正常系approve -> canonical receiverへ正確に1回到達、BotApprovalDecisionの形が正しい ----
  {
    const { deps, receiveBotApprovalDecisionCalls } = makeDeps();

    const result = await receiveSlackBotApprovalDecisionAsTrustedActor(makeMessage(), "approve", deps);

    results.push(
      check(
        "[Case23] canonical receiveBotApprovalDecision()が正確に1回呼ばれ、workId/approvalId/decisionがresolve結果と一致する",
        receiveBotApprovalDecisionCalls.length === 1 &&
          receiveBotApprovalDecisionCalls[0].workId === "work-1" &&
          receiveBotApprovalDecisionCalls[0].approvalId === "approval-1" &&
          receiveBotApprovalDecisionCalls[0].decision === "approve"
      )
    );

    results.push(
      check(
        "[Case23] Approval IDはuser input(message.text)から一切取得されず、resolvePendingApprovalForThread()の結果からのみ渡る(text自体はただの'承認'という文字列)",
        !("承認" === receiveBotApprovalDecisionCalls[0]?.approvalId)
      )
    );

    results.push(
      check(
        "[Approve] 最終的なhandled/actionsはcanonical receiverの結果をそのまま返す",
        result.handled === true && result.actions[0]?.kind === "reply"
      )
    );
  }

  // ---- Case29/30: reject -> canonical receiverへdecision:'reject'で到達 ----
  {
    const { deps, receiveBotApprovalDecisionCalls } = makeDeps();

    await receiveSlackBotApprovalDecisionAsTrustedActor(makeMessage({ text: "却下" }), "reject", deps);

    results.push(
      check(
        "[Case29] reject時もcanonical receiveBotApprovalDecision()が正確に1回、decision:'reject'で呼ばれる",
        receiveBotApprovalDecisionCalls.length === 1 && receiveBotApprovalDecisionCalls[0].decision === "reject"
      )
    );
  }

  // ---- Case31: replyが同じthreadへ返る(target.conversationがmessage.conversationと一致) ----
  {
    const { deps, receiveBotApprovalDecisionCalls } = makeDeps();

    await receiveSlackBotApprovalDecisionAsTrustedActor(
      makeMessage({ conversation: { externalConversationId: "C_SPECIFIC", type: "channel", threadId: "TS_SPECIFIC" } }),
      "approve",
      deps
    );

    results.push(
      check(
        "[Case31] canonical receiverへ渡るtarget.conversationは、元messageのexternalConversationId/threadIdと完全一致する(同一thread)",
        receiveBotApprovalDecisionCalls[0]?.target.conversation.externalConversationId === "C_SPECIFIC" &&
          receiveBotApprovalDecisionCalls[0]?.target.conversation.threadId === "TS_SPECIFIC"
      )
    );
  }

  // ---- Case32-35: エラー系replyがhash/payload/connectionId/approvalId/workIdを含まない ----
  {
    const failureStatuses: ResolvePendingApprovalForThreadResult[] = [
      { status: "trusted_execution_not_configured" },
      { status: "conversation_link_missing" },
      { status: "work_missing" },
      { status: "no_pending_approval" },
      { status: "ambiguous_pending_approval", count: 3 },
    ];

    let allSafe = true;

    for (const failureStatus of failureStatuses) {

      const { deps } = makeDeps({ resolvePendingApprovalForThread: async () => failureStatus });
      const result = await receiveSlackBotApprovalDecisionAsTrustedActor(makeMessage(), "approve", deps);
      const text = result.actions[0]?.kind === "reply" ? result.actions[0].text.toLowerCase() : "";

      if (
        text.includes("approval-1") ||
        text.includes("work-1") ||
        text.includes("task-1") ||
        /[0-9a-f]{64}/.test(text) ||
        text.includes("connectionid") ||
        text.includes("payload")
      ) {
        allSafe = false;
      }

    }

    results.push(
      check(
        "[Case32-35] resolution失敗系の全パターンで、reply textにapprovalId/workId/taskId/hash/connectionId/payloadのいずれも含まれない",
        allSafe
      )
    );
  }

  // =========================
  // Routing branch(handleSlackWebhookRequest()レベル、Case11/12/13)
  // =========================

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

  function makeAppMentionEnvelope(text: string, eventId: string) {
    return {
      type: "event_callback",
      team_id: "T123TEAM",
      event_id: eventId,
      event_time: 1893456000,
      event: {
        type: "app_mention",
        user: "U123EXTERNAL",
        text: `<@U999TACTBOT> ${text}`,
        ts: "1893456000.000100",
        channel: "C123CHANNEL",
      },
    };
  }

  async function driveHandler(envelope: unknown, deps: {
    detectApprovalDecisionText: (text: string) => ApprovalDecisionTextMatch;
    receiveApprovalDecision: (message: BotIncomingMessage, decisionKind: "approve" | "reject") => Promise<{ handled: boolean; actions: never[] }>;
    receiveBotMessage: (message: BotIncomingMessage) => Promise<{ handled: boolean; actions: never[] }>;
  }): Promise<void> {

    const { rawBody, headers } = makeSignedRequest(envelope);
    let scheduledPromise: Promise<void> | undefined;

    await handleSlackWebhookRequest(rawBody, headers, {
      getSigningSecret: () => SIGNING_SECRET,
      claimExternalEvent: async () => "claimed",
      executeBotActions: async () => [],
      scheduleBackgroundWork: (task) => {
        scheduledPromise = task();
      },
      ...deps,
    });

    if (scheduledPromise) {
      await scheduledPromise;
    }

  }

  // ---- Case11/12: decision text matchはreceiveBotMessage()へ絶対にfallbackしない ----
  {
    let receiveBotMessageCalls = 0;
    let receiveApprovalDecisionCalls = 0;
    let capturedDecisionKind: "approve" | "reject" | undefined;

    await driveHandler(makeAppMentionEnvelope("承認", "Ev-decision-approve-1"), {
      detectApprovalDecisionText: (text) =>
        text === "承認" ? { matched: true, decision: "approve" } : { matched: false },
      receiveApprovalDecision: async (_message, decisionKind) => {
        receiveApprovalDecisionCalls += 1;
        capturedDecisionKind = decisionKind;
        return { handled: true, actions: [] };
      },
      receiveBotMessage: async () => {
        receiveBotMessageCalls += 1;
        return { handled: true, actions: [] };
      },
    });

    results.push(
      check(
        "[Case11] 「承認」がdecision textとしてmatchした場合、receiveApprovalDecision()が正確に1回呼ばれ、receiveBotMessage()(通常Conversation/LLM経路)は一切呼ばれない",
        receiveApprovalDecisionCalls === 1 && receiveBotMessageCalls === 0 && capturedDecisionKind === "approve"
      )
    );
  }

  {
    let receiveBotMessageCalls = 0;
    let receiveApprovalDecisionCalls = 0;

    await driveHandler(makeAppMentionEnvelope("却下", "Ev-decision-reject-1"), {
      detectApprovalDecisionText: (text) =>
        text === "却下" ? { matched: true, decision: "reject" } : { matched: false },
      receiveApprovalDecision: async () => {
        receiveApprovalDecisionCalls += 1;
        return { handled: true, actions: [] };
      },
      receiveBotMessage: async () => {
        receiveBotMessageCalls += 1;
        return { handled: true, actions: [] };
      },
    });

    results.push(
      check(
        "[Case12] 「却下」がdecision textとしてmatchした場合も同様に、receiveBotMessage()は一切呼ばれない",
        receiveApprovalDecisionCalls === 1 && receiveBotMessageCalls === 0
      )
    );
  }

  // ---- Case13: decision textにmatchしない通常messageは既存receiveBotMessage()経路をそのまま使う ----
  {
    let receiveBotMessageCalls = 0;
    let receiveApprovalDecisionCalls = 0;

    await driveHandler(makeAppMentionEnvelope("OpenAIについて調べて", "Ev-normal-1"), {
      detectApprovalDecisionText: () => ({ matched: false }),
      receiveApprovalDecision: async () => {
        receiveApprovalDecisionCalls += 1;
        return { handled: true, actions: [] };
      },
      receiveBotMessage: async () => {
        receiveBotMessageCalls += 1;
        return { handled: true, actions: [] };
      },
    });

    results.push(
      check(
        "[Case13] decision textにmatchしない通常messageは、既存のreceiveBotMessage()経路がそのまま使われ、receiveApprovalDecision()は一切呼ばれない",
        receiveBotMessageCalls === 1 && receiveApprovalDecisionCalls === 0
      )
    );
  }

  return summarize("bot/slackApprovalDecisionRouting", results);

}
