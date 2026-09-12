import type { BotAction, BotActionDeliveryResult, BotIncomingMessage } from "../../types";
import type { ChannelAdapter } from "../types";
import { isAppMentionEventCallback, normalizeSlackAppMentionEvent } from "./normalizeSlackEvent";
import { getSlackWebApiClient, type SlackBlock, type SlackPostMessageParams, type SlackWebApiClient } from "./slackClient";
import { splitSlackMessageText } from "./splitMessageText";

// =========================
// TACT Bot — Slack ChannelAdapter (S1c)
// =========================
//
// core/tact-bot/adapters/types.tsのChannelAdapter interfaceを実装する
// (型変更なし、絶対条件Section2)。
//
// normalizeIncoming(): S1a/S1bで確立済みのisAppMentionEventCallback()/
// normalizeSlackAppMentionEvent()をそのまま再利用するだけの薄い
// wrapper(business logicの複製なし)。inbound webhook経路自体は
// 引き続きcore/tact-bot/adapters/slack/handleSlackWebhookRequest.ts
// (署名検証・dedup・ACK-first制御を担う専用handler)を経由する——
// この関数はChannelAdapter interfaceを完全に満たすために公開する
// (絶対条件: 既存interfaceで自然に実装できるなら型変更を避ける)。
//
// executeAction(): 今回のResearch MVPで対応するのはkind:"reply"のみ
// (絶対条件Section9)。それ以外のBotAction kindはsilent success/
// 独自変換をせず、明示的にunsupportedとして安全に拒否する。
//
// 絶対条件(Section1、Architecture invariant): このAdapterは
// core/tact-integration・Composio・integration.slack.send_message・
// executeApprovedIntegrationAction()のいずれも一切importしない
// (Bot Interface replyとIntegration business writeは完全に別物)。
export interface SlackChannelAdapterDeps {

  // 省略時はgetSlackWebApiClient()(実@slack/web-api、SLACK_BOT_TOKEN
  // 未設定時はnull)をexecuteAction()呼び出しのたびに遅延解決する。
  // テストは明示的にfake clientを注入できる(nullを渡してnot_configured
  // 経路も検証可能)。
  client?: SlackWebApiClient | null;

}

export const SLACK_APPROVAL_APPROVE_ACTION_ID = "tact_approval_approve";
export const SLACK_APPROVAL_REJECT_ACTION_ID = "tact_approval_reject";
export const SLACK_APPROVAL_BLOCK_ID = "tact_approval_controls";

function approvalBlocks(approvalId: string, summary: string): SlackBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*承認待ち*\n${summary}` } },
    {
      type: "actions",
      block_id: SLACK_APPROVAL_BLOCK_ID,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "承認" },
          action_id: SLACK_APPROVAL_APPROVE_ACTION_ID,
          value: approvalId,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "却下" },
          action_id: SLACK_APPROVAL_REJECT_ACTION_ID,
          value: approvalId,
          style: "danger",
        },
      ],
    },
  ];
}

function approvalMessage(action: Extract<BotAction, { kind: "request_approval" }>): SlackPostMessageParams {
  return {
    channel: action.target.conversation.externalConversationId,
    text: `承認待ち: ${action.summary}`,
    threadTs: action.target.conversation.threadId,
    blocks: approvalBlocks(action.approvalId, action.summary),
  };
}

export function createSlackChannelAdapter(
  deps: SlackChannelAdapterDeps = {}
): ChannelAdapter {

  return {

    channel: "slack",

    normalizeIncoming(rawPayload: unknown): BotIncomingMessage | null {

      if (!isAppMentionEventCallback(rawPayload)) {
        return null;
      }

      return normalizeSlackAppMentionEvent(rawPayload);

    },

    async executeAction(action: BotAction): Promise<BotActionDeliveryResult> {

      // 絶対条件(Section9): 未対応actionはsilent success/business
      // actionへの変換をせず、明示的にunsupportedとして拒否する。
      if (action.kind !== "reply" && action.kind !== "request_approval") {

        return {
          ok: false,
          actionKind: action.kind,
          error: "unsupported_action_kind",
        };

      }

      const client = deps.client !== undefined ? deps.client : getSlackWebApiClient();

      if (!client) {

        return {
          ok: false,
          actionKind: action.kind,
          error: "not_configured",
        };

      }

      // 絶対条件(Section7): channel/thread_tsの解釈はこのAdapter内だけで
      // 行う——Bot Core側(canonical domain)はSlack channel id/thread id
      // という概念そのものを再解釈しない(BotActionTarget.conversationの
      // 既存field、externalConversationId/threadIdをそのままSlack API
      // parameterへ変換するだけ)。
      if (action.kind === "request_approval") {
        const result = await client.postMessage(approvalMessage(action));
        return result.ok
          ? { ok: true, actionKind: action.kind, raw: { sentChunks: 1, totalChunks: 1 } }
          : { ok: false, actionKind: action.kind, error: "delivery_failed", raw: { sentChunks: 0, totalChunks: 1, providerErrorCode: result.error } };
      }

      const channel = action.target.conversation.externalConversationId;
      const threadTs = action.target.conversation.threadId;

      // 絶対条件(Section10、絶対条件): 追加LLM/summary/Research再実行
      // 無しで、TACTが既に作ったaction.textをそのまま(段落/改行境界で
      // 分割するだけ)Slackへ運ぶ。
      const chunks = splitSlackMessageText(action.text);

      if (chunks.length === 0) {

        return {
          ok: false,
          actionKind: action.kind,
          error: "empty_text",
        };

      }

      const sentTimestamps: string[] = [];

      // 絶対条件(Section12): 複数chunkはPromise.allで並列送信せず、
      // 順序を保証するため1件ずつawaitする。
      for (const chunk of chunks) {

        const result = await client.postMessage({ channel, text: chunk, threadTs });

        if (!result.ok) {

          // 絶対条件(Section13): 途中失敗時はrollbackせず、続く
          // chunkの送信も行わない(自動retryもしない、絶対条件
          // Section15/22)。安全な分類ラベルだけをerrorへ入れ、
          // provider raw error/response metadata/request idは
          // 診断用のraw内にのみ留める(絶対条件Section14)。
          return {
            ok: false,
            actionKind: action.kind,
            error: sentTimestamps.length > 0 ? "partial_failure" : "delivery_failed",
            raw: {
              sentChunks: sentTimestamps.length,
              totalChunks: chunks.length,
              providerErrorCode: result.error,
            },
          };

        }

        if (result.ts) {
          sentTimestamps.push(result.ts);
        }

      }

      return {
        ok: true,
        actionKind: action.kind,
        raw: { sentChunks: sentTimestamps.length, totalChunks: chunks.length },
      };

    },

  };

}
