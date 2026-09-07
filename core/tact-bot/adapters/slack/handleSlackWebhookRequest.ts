import { after } from "next/server";
import type { ReceiveBotMessageResult } from "../../gateway/receiveMessage";
import type { BotAction, BotActionDeliveryResult, BotIncomingMessage } from "../../types";
import { receiveSlackBotMessageAsTrustedActor, executeSlackBotActions } from "./productionBotCore";
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
import type { SlackAppMentionEvent, SlackEventCallbackEnvelope } from "./types";

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

  receiveBotMessage: (message: BotIncomingMessage) => Promise<ReceiveBotMessageResult>;

  // S1c: BotAction[]をSlackへ配送する(既存BotAction execution gateway
  // 経由、絶対条件Section8)。
  executeBotActions: (actions: BotAction[]) => Promise<BotActionDeliveryResult[]>;

  // 絶対条件(Section20): normal app_mentionはACKを先に返す。
  scheduleBackgroundWork: (task: () => Promise<void>) => void;

  // テスト用DI(署名検証のreplay protectionへ伝播する)。
  now?: () => number;

}

const defaultDeps: HandleSlackWebhookRequestDeps = {

  getSigningSecret: getSlackSigningSecret,

  claimExternalEvent: defaultClaimExternalEvent,

  // S1b: receiveBotMessage()自体のdisconnected default(BOT-P1由来)
  // ではなく、Slack production wiring(./productionBotCore.ts、
  // Supabase-backed identity resolver/coreConnectorを注入する)を経由
  // する。receiveBotMessage()自身のglobal defaultは変更していない
  // (絶対条件Section3)。
  receiveBotMessage: receiveSlackBotMessageAsTrustedActor,

  // S1c: ./productionBotCore.tsのexecuteSlackBotActions()(実
  // core/tact-bot/gateway/executeBotActions.ts + SlackChannelAdapter)。
  executeBotActions: executeSlackBotActions,

  scheduleBackgroundWork: (task) => {
    after(task);
  },

};

function ackIgnored(): SlackWebhookHandlerResponse {
  return { status: 200, body: { ok: true } };
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

    try {

      const result = await deps.receiveBotMessage(message);
      await deps.executeBotActions(result.actions);

    } catch {

      console.error("[tact-bot] Slack bot background execution failed");

    }

  });

  return { status: 200, body: { ok: true } };

}
