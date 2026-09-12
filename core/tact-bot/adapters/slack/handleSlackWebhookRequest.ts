import { after } from "next/server";
import type { ReceiveBotMessageResult } from "../../gateway/receiveMessage";
import type { BotAction, BotActionDeliveryResult, BotApprovalDecisionKind, BotIncomingMessage } from "../../types";
import {
  receiveSlackBotMessageAsTrustedActor,
  receiveSlackBotApprovalDecisionAsTrustedActor,
  executeSlackBotActions,
  type ReceiveSlackBotApprovalDecisionResult,
} from "./productionBotCore";
import {
  claimExternalEvent as defaultClaimExternalEvent,
  type ClaimExternalEventResult,
} from "../../eventDedup/supabaseEventDedupStore";
import { getSlackSigningSecret } from "./config";
import { verifySlackRequest } from "./verifySlackSignature";
import {
  isAppMentionEventCallback,
  isBotEchoEvent,
  normalizeSlackAppMentionEvent,
} from "./normalizeSlackEvent";
import { detectApprovalDecisionText as defaultDetectApprovalDecisionText } from "./detectApprovalDecisionText";
import {
  SLACK_APPROVAL_APPROVE_ACTION_ID,
  SLACK_APPROVAL_REJECT_ACTION_ID,
} from "./slackChannelAdapter";
import type { SlackAppMentionEvent, SlackEventCallbackEnvelope } from "./types";
import type { ConversationEvidence } from "../../../tact-conversation/conversationEvidence";
import {
  retrieveSlackConversationContext,
  triggerOnlySlackConversationEvidence,
  type SlackConversationContextTrigger,
} from "./slackConversationContext";
import { getSlackWebApiClient } from "./slackClient";
import {
  buildSafeSlackBackgroundFailureDiagnostic,
  type SlackBackgroundExecutionStage,
  type SlackBackgroundFailureDiagnostic,
} from "../../diagnostics/safeBackgroundFailureDiagnostic";

// =========================
// TACT Bot — Slack Webhook Request Handler (S1a)
// =========================
//
// app/api/tact/bot/slack/route.ts(薄いNext.js Route Handler)が実際に
// 委譲する処理本体。ここをroute.tsから分離するのは、
// (a) Route Handlerのexport signature(POST(request): Response)へ
//     DIを持ち込めないため、
// (b) 「fake dependencyを使ったroute/adapter testでreceiveBotMessage()
//     が1回呼ばれることを証明する」(絶対条件Section21)ためには
//     この処理本体自体がDI可能である必要があるため。
//
// 絶対条件(Section2、Architecture invariant): Slack raw payloadを
// core/tact-conversation・core/tact-work・core/tact-orchestrator・
// core/tact-research・core/tact-integration(Composio Integration
// Gateway)のいずれへも渡さない。ここで扱うのはSlack payload →
// canonical BotIncomingMessage → 既存receiveBotMessage()という
// 境界だけであり、Integration Gateway/Composio/
// executeApprovedIntegrationAction()は一切importしない。
//
// 処理順序(絶対条件Section17、この通りの順序を維持する):
//   署名検証 → JSON parse → event_callback/app_mention確認 →
//   bot echo除外 → event_id確認 → atomic event claim →
//   canonical normalization → receiveBotMessage()
//
// ACK境界(絶対条件Section20): 通常のapp_mentionは、receiveBotMessage()
// の完了を待たずにACK(200)を返す。本番既定はNext.js
// after()(local node_modules/next/server.d.ts・
// dist/server/after/after.d.tsで実際のAPI signatureを確認済み:
// `after<T>(task: Promise<T> | (() => T | Promise<T>)): void`、
// レスポンス送出後に実行される)。testは即時実行のfakeスケジューラへ
// 差し替え、receiveBotMessage()の呼び出し回数を直接観測する。

export interface SlackWebhookHandlerResponse {

  status: number;

  body: Record<string, unknown>;

}

export interface HandleSlackWebhookRequestDeps {

  getSigningSecret: () => string | undefined;

  claimExternalEvent: (params: {
    channel: "slack";
    externalEventId: string;
  }) => Promise<ClaimExternalEventResult>;

  receiveBotMessage: (message: BotIncomingMessage, conversationEvidence?: ConversationEvidence) => Promise<ReceiveBotMessageResult>;

  retrieveConversationContext?: (trigger: SlackConversationContextTrigger) => Promise<ConversationEvidence>;

  // S1e: 決定論的なpure text判定(LLM不使用、絶対条件2/11)。
  // normalizeSlackAppMentionEvent()が既にmention除去・trim済みの
  // BotIncomingMessage.textを渡す。
  // Deprecated compatibility injection. Text is never used to authorize an
  // Approval; only a signed Block Kit action reaches receiveApprovalDecision.
  detectApprovalDecisionText: typeof defaultDetectApprovalDecisionText;

  // S1e: detectApprovalDecisionText()がmatchした場合にのみ呼ばれる、
  // canonical receiveBotApprovalDecision()への専用入口(絶対条件7:
  // approveApproval()/rejectApproval()/executeApprovedIntegrationAction()
  // をこのfileから直接呼ばない)。
  receiveApprovalDecision: (
    message: BotIncomingMessage,
    decisionKind: BotApprovalDecisionKind,
    expectedApprovalId?: string
  ) => Promise<ReceiveSlackBotApprovalDecisionResult>;

  // S1c: BotAction[]をSlackへ配送する(既存BotAction execution gateway
  // 経由、絶対条件Section8)。
  executeBotActions: (actions: BotAction[]) => Promise<BotActionDeliveryResult[]>;

  // 絶対条件(Section20): normal app_mentionはACKを先に返す。
  scheduleBackgroundWork: (task: () => Promise<void>) => void;

  // テスト用DI(署名検証のreplay protectionへ伝播する)。
  now?: () => number;

  logBackgroundFailure?: (diagnostic: SlackBackgroundFailureDiagnostic) => void;

}

const defaultDeps: HandleSlackWebhookRequestDeps = {

  getSigningSecret: getSlackSigningSecret,

  claimExternalEvent: defaultClaimExternalEvent,

  // S1b: receiveBotMessage()自体のdisconnected default(BOT-P1由来)
  // ではなく、Slack production wiring(./productionBotCore.ts、
  // Supabase-backed identity resolver/coreConnectorを注入する)を経由
  // する。receiveBotMessage()自身のglobal defaultは変更していない
  // (絶対条件Section3)。
  receiveBotMessage: (message, conversationEvidence) =>
    receiveSlackBotMessageAsTrustedActor(message, undefined, conversationEvidence),

  retrieveConversationContext: (trigger) => {
    const client = getSlackWebApiClient();
    const api = client?.getThreadReplies && client.getChannelHistory ? client as import("./slackConversationContext").SlackConversationContextApi : null;
    return retrieveSlackConversationContext(trigger, api, { tactBotUserId: process.env.SLACK_BOT_USER_ID });
  },

  // S1e: ./detectApprovalDecisionText.tsのpure判定関数そのまま。
  detectApprovalDecisionText: defaultDetectApprovalDecisionText,

  // S1e: ./productionBotCore.tsのreceiveSlackBotApprovalDecisionAsTrustedActor()。
  receiveApprovalDecision: (message, decisionKind, expectedApprovalId) =>
    receiveSlackBotApprovalDecisionAsTrustedActor(message, decisionKind, undefined, expectedApprovalId),

  // S1c: ./productionBotCore.tsのexecuteSlackBotActions()(実
  // core/tact-bot/gateway/executeBotActions.ts + SlackChannelAdapter)。
  executeBotActions: executeSlackBotActions,

  scheduleBackgroundWork: (task) => {
    after(task);
  },

  logBackgroundFailure: (diagnostic) => {
    console.error("[tact-bot] Slack bot background execution failed", diagnostic);
  },

};

function ackIgnored(): SlackWebhookHandlerResponse {
  return { status: 200, body: { ok: true } };
}

type SlackApprovalInteraction = {
  message: BotIncomingMessage;
  decision: BotApprovalDecisionKind;
  approvalId: string;
};

// Block Kit values are correlation data only. This parser intentionally has no
// natural-language decision path and accepts neither work IDs nor free-form
// authorization instructions.
function parseSlackApprovalInteraction(rawBody: string): SlackApprovalInteraction | null {
  let payload: unknown;
  try {
    const encoded = new URLSearchParams(rawBody).get("payload");
    payload = encoded ? JSON.parse(encoded) : null;
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as {
    type?: unknown;
    user?: { id?: unknown };
    team?: { id?: unknown };
    channel?: { id?: unknown };
    container?: { message_ts?: unknown; thread_ts?: unknown };
    actions?: Array<{ action_id?: unknown; value?: unknown }>;
  };
  const action = Array.isArray(candidate.actions) && candidate.actions.length === 1
    ? candidate.actions[0]
    : undefined;
  const decision = action?.action_id === SLACK_APPROVAL_APPROVE_ACTION_ID
    ? "approve"
    : action?.action_id === SLACK_APPROVAL_REJECT_ACTION_ID
      ? "reject"
      : undefined;
  const userId = candidate.user?.id;
  const teamId = candidate.team?.id;
  const channelId = candidate.channel?.id;
  const messageTs = candidate.container?.message_ts;
  const threadTs = candidate.container?.thread_ts;
  const approvalId = action?.value;

  if (
    candidate.type !== "block_actions" || !decision ||
    typeof userId !== "string" || !userId ||
    typeof teamId !== "string" || !teamId ||
    typeof channelId !== "string" || !channelId ||
    typeof messageTs !== "string" || !messageTs ||
    typeof approvalId !== "string" || !approvalId
  ) return null;

  return {
    decision,
    approvalId,
    message: {
      channel: "slack",
      actor: { externalUserId: userId },
      conversation: {
        externalConversationId: channelId,
        type: "channel",
        threadId: typeof threadTs === "string" && threadTs ? threadTs : messageTs,
      },
      organizationId: teamId,
      messageId: messageTs,
      text: "",
      mentionedTact: false,
      receivedAt: new Date().toISOString(),
    },
  };
}

function toSlackContextTrigger(
  event: SlackAppMentionEvent,
  message: BotIncomingMessage
): SlackConversationContextTrigger {
  const threadRef = typeof event.thread_ts === "string" && event.thread_ts.length > 0
    ? event.thread_ts
    : undefined;
  return {
    channelRef: message.conversation.externalConversationId,
    triggerMessageRef: message.messageId,
    triggerAuthorRef: message.actor.externalUserId,
    triggerText: message.text,
    triggerTimestamp: message.messageId,
    ...(threadRef ? { threadRef } : {}),
  };
}

// Fetch API Headersの最小subset(NextRequest.headers/テスト用の
// new Headers()いずれも満たす)。
export interface SlackWebhookHeaders {
  get(name: string): string | null;
}

export async function handleSlackWebhookRequest(
  rawBody: string,
  headers: SlackWebhookHeaders,
  deps: HandleSlackWebhookRequestDeps = defaultDeps
): Promise<SlackWebhookHandlerResponse> {

  // 絶対条件(Section5): Signing Secret未設定ではそもそも検証できない
  // ——「検証をskipして信用する」ことは絶対にしない、401で安全側へ倒す。
  const signingSecret = deps.getSigningSecret();

  if (!signingSecret) {
    return { status: 401, body: { error: "not_configured" } };
  }

  const verification = verifySlackRequest({
    rawBody,
    timestamp: headers.get("x-slack-request-timestamp"),
    signature: headers.get("x-slack-signature"),
    signingSecret,
    now: deps.now,
  });

  if (!verification.ok) {
    return { status: 401, body: { error: "invalid_signature" } };
  }

  const interaction = parseSlackApprovalInteraction(rawBody);
  if (interaction) {
    deps.scheduleBackgroundWork(async () => {
      try {
        const result = await deps.receiveApprovalDecision(
          interaction.message,
          interaction.decision,
          interaction.approvalId
        );
        await deps.executeBotActions(result.actions);
      } catch (error) {
        (deps.logBackgroundFailure ?? defaultDeps.logBackgroundFailure!)(
          buildSafeSlackBackgroundFailureDiagnostic(error, "approval_decision", [rawBody])
        );
      }
    });
    return { status: 200, body: { ok: true } };
  }

  // 絶対条件(Section5、7): JSON.parse前のraw bodyだけを署名検証に使い、
  // parseはその後に行う。
  let envelope: unknown;

  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }

  if (!envelope || typeof envelope !== "object") {
    return { status: 400, body: { error: "invalid_payload" } };
  }

  const parsed = envelope as { type?: unknown; challenge?: unknown };

  // 絶対条件(Section7): 署名未検証のchallengeを返さない
  // (この時点で既に署名検証を通過済み)。
  if (parsed.type === "url_verification") {

    if (typeof parsed.challenge !== "string" || parsed.challenge.length === 0) {
      return { status: 400, body: { error: "invalid_challenge" } };
    }

    return { status: 200, body: { challenge: parsed.challenge } };

  }

  // 絶対条件(Section8): MVP対象外のevent(event_callback以外のtype、
  // またはapp_mention以外のevent種別)は安全にignore/ACKする。
  if (!isAppMentionEventCallback(envelope)) {
    return ackIgnored();
  }

  const callbackEnvelope = envelope as SlackEventCallbackEnvelope & {
    event: SlackAppMentionEvent;
  };

  const event = callbackEnvelope.event;

  // 絶対条件(Section9): Bot自身のechoをTACT入力にしない(bot loop防止)。
  // dedup claimより前に行う(対象外eventでdedup recordを無駄に作らない、
  // 絶対条件Section17)。
  if (isBotEchoEvent(event)) {
    return ackIgnored();
  }

  const externalEventId =
    typeof (callbackEnvelope as { event_id?: unknown }).event_id === "string"
      ? (callbackEnvelope as { event_id: string }).event_id
      : undefined;

  if (!externalEventId) {
    // 署名検証を既に通過しているため改ざんの可能性は無いが、
    // event_idが無ければdedup自体が成立しない——安全側で処理しない
    // (Slack公式仕様上event_callbackには常にevent_idが付与される
    // ため、通常到達しない防御的分岐)。
    return ackIgnored();
  }

  const claim = await deps.claimExternalEvent({ channel: "slack", externalEventId });

  if (claim === "duplicate") {
    return ackIgnored();
  }

  if (claim === "error") {
    // 絶対条件(Section18、最重要): dedup storageの障害を「duplicate扱い
    // で捨てる」ことも「claimed扱いで処理を進める」ことも安全ではない。
    // fail closedで5xxを返し、Slackの自然な再送(retry)へ委ねる。
    return { status: 500, body: { error: "dedup_unavailable" } };
  }

  // claim === "claimed"(このevent_idの初回配信)。
  const message = normalizeSlackAppMentionEvent(callbackEnvelope);

  if (!message) {
    return ackIgnored();
  }

  // References are derived only after signature verification and event
  // normalization. No HTTP caller-supplied channel/thread/user reference enters
  // the context retrieval boundary.
  const contextTrigger = toSlackContextTrigger(event, message);

  // 絶対条件(Section19/20): Research/Conversation/Slack outbound完了を
  // 待たずにACKを返す。background pipelineはTrusted Bot Message受信
  // →BotAction[]取得→Slack outbound配送(executeBotActions()、既存
  // BotAction execution gateway経由)まで一気通貫で行う。
  //
  // 絶対条件(Section20/21、known debt解消): background callback自体を
  // try/catchで包み、Research/Conversation/Work/Slack outboundの
  // いずれで例外が発生してもunhandled rejectionとして外部へ漏らさない
  // (Next.js after()自体のtask rejection semanticsがdocument/型定義
  // からは確認できなかったため、こちら側のcallbackで確実に捕捉する)。
  // secret/raw Slack payload/provider error detail/user message全文は
  // ログに出さない、固定文言だけを記録する(過剰なerror infrastructure
  // は作らない、絶対条件Section21)。
  deps.scheduleBackgroundWork(async () => {

    let stage: SlackBackgroundExecutionStage = "approval_detection";
    let conversationEvidence: ConversationEvidence | undefined;

    try {

      // S1e(絶対条件Section2/3、最重要): normalized textが
      // Approval decision(承認/却下)と決定論的に判定された場合、
      // 通常のConversation/LLM経路(receiveBotMessage())へは絶対に
      // 流さない——detectApprovalDecisionText()は純粋なtext判定
      // だけを行い、識別・相関解決・実行判断のいずれも行わない
      // (それらはreceiveApprovalDecision()側、さらにその内部の
      // canonical receiveBotApprovalDecision()の責務)。
      const retrieveConversationContext = deps.retrieveConversationContext ?? defaultDeps.retrieveConversationContext!;
      stage = "conversation_context";
      conversationEvidence = await retrieveConversationContext(contextTrigger).catch(() =>
        triggerOnlySlackConversationEvidence(contextTrigger, true)
      );

      stage = "conversation_intake";
      const result: ReceiveBotMessageResult = await deps.receiveBotMessage(message, conversationEvidence);

      stage = "slack_action_delivery";
      await deps.executeBotActions(result.actions);

    } catch (error) {

      const knownSensitiveValues = [
        rawBody,
        message.text,
        ...(conversationEvidence?.messages.map((contextMessage) => contextMessage.text) ?? []),
      ];
      (deps.logBackgroundFailure ?? defaultDeps.logBackgroundFailure!)(
        buildSafeSlackBackgroundFailureDiagnostic(error, stage, knownSensitiveValues)
      );

    }

  });

  return { status: 200, body: { ok: true } };

}
