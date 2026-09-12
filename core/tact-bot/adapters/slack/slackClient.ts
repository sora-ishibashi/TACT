import { WebClient, WebAPIPlatformError, WebAPIRateLimitedError, WebAPIHTTPError, WebAPIRequestError } from "@slack/web-api";
import { getSlackBotToken } from "./slackOutboundConfig";
import type { SlackContextSourceMessage, SlackConversationContextApi } from "./slackConversationContext";

// =========================
// TACT Bot — Slack Web API Client Boundary (S1c)
// =========================
//
// @slack/web-apiのWebClient/型はこのfileだけに閉じ込める(絶対条件
// Section4)。core/tact-bot/adapters/slack/slackChannelAdapter.tsを
// 含むそれ以外のどのfileも@slack/web-apiを直接importしない
// (core/tact-integration/providers/composio/配下だけが@composio/core
// をimportする既存パターンと同じ設計)。
//
// 絶対条件(No automatic retry、TACT全体で一貫した既存方針):
// @slack/web-apiのWebClientは、何も指定しない場合
// retryConfig="tenRetriesInAboutThirtyMinutes"(最大10回・約30分に
// わたる自動retry、node_modules/@slack/web-api/dist/WebClient.js
// のconstructor既定値で確認済み)をSDK自身が既定で行う。これは
// core/tact-integration/providers/composio/adapter.tsが
// Composio SDKに対して行っているのと同じ「protected writeへの
// 自動retryを許さない」既存絶対条件に反するため、このfileで明示的に
// retryConfig:{retries:0}を渡し、SDKレベルの自動retryを無効化する
// (1回だけ呼ぶ、既存Composio Adapterと同じ設計判断)。
//
// エラーnormalize方針(既存core/tact-integration/providers/composio/
// adapter.tsのnormalizeComposioError()と同じ設計): Slack SDKの例外
// 階層(WebAPIPlatformError/WebAPIRequestError/WebAPIHTTPError/
// WebAPIRateLimitedError)から、raw response/headers/tokenを含まない
// 短いerror codeだけを取り出す。

// canonical/testable最小interface。Slack SDK型をこの外へ広げない。
export interface SlackPostMessageParams {

  channel: string;

  text: string;

  threadTs?: string;

  // Narrow Block Kit shape used by the provider-neutral request_approval
  // BotAction. Keeping this at the Slack boundary prevents Slack fields from
  // leaking into the canonical BotAction model.
  blocks?: SlackBlock[];

}

export type SlackBlock =
  | { type: "section"; text: { type: "mrkdwn" | "plain_text"; text: string } }
  | {
      type: "actions";
      block_id: string;
      elements: Array<{
        type: "button";
        text: { type: "plain_text"; text: string };
        action_id: string;
        value: string;
        style?: "primary" | "danger";
      }>;
    };

export interface SlackPostMessageResult {

  ok: boolean;

  // 成功時のみ設定される(診断用、canonical BotActionDeliveryResult.raw
  // 経由でのみ外部から観測可能——絶対条件Section14: user-facing層への
  // 直接露出はしない)。
  ts?: string;

  // 失敗時のみ設定される。Slackの短いerror code文字列のみ
  // (raw HTTP response/headers/request id/token関連detailは含めない)。
  error?: string;

}

export interface SlackWebApiClient {

  postMessage(params: SlackPostMessageParams): Promise<SlackPostMessageResult>;

  getThreadReplies?: SlackConversationContextApi["getThreadReplies"];

  getChannelHistory?: SlackConversationContextApi["getChannelHistory"];

}

function toContextMessages(messages: unknown): SlackContextSourceMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((value): SlackContextSourceMessage[] => {
    if (!value || typeof value !== "object") return [];
    const message = value as { ts?: unknown; user?: unknown; text?: unknown; subtype?: unknown; bot_id?: unknown; files?: unknown };
    const files = Array.isArray(message.files)
      ? message.files.flatMap((file) => file && typeof file === "object" ? [{
          id: typeof (file as { id?: unknown }).id === "string" ? (file as { id: string }).id : undefined,
          name: typeof (file as { name?: unknown }).name === "string" ? (file as { name: string }).name : undefined,
          mimetype: typeof (file as { mimetype?: unknown }).mimetype === "string" ? (file as { mimetype: string }).mimetype : undefined,
        }] : [])
      : undefined;
    return [{
      ts: typeof message.ts === "string" ? message.ts : undefined,
      user: typeof message.user === "string" ? message.user : undefined,
      text: typeof message.text === "string" ? message.text : undefined,
      subtype: typeof message.subtype === "string" ? message.subtype : undefined,
      bot_id: typeof message.bot_id === "string" ? message.bot_id : undefined,
      files,
    }];
  });
}

function normalizeSlackWebApiError(error: unknown): string {

  if (error instanceof WebAPIPlatformError) {
    // Slack自身が返す短いerror code(例: "channel_not_found"、
    // "invalid_auth")。raw HTTP response/headersは含まない。
    return error.data.error;
  }

  if (error instanceof WebAPIRateLimitedError) {
    return "rate_limited";
  }

  if (error instanceof WebAPIHTTPError) {
    return `http_error_${error.statusCode}`;
  }

  if (error instanceof WebAPIRequestError) {
    return "request_error";
  }

  return "unknown_error";

}

export function createProductionSlackWebApiClient(token: string): SlackWebApiClient {

  const client = new WebClient(token, {
    // 絶対条件(No automatic retry): SDK既定の自動retryを無効化する。
    retryConfig: { retries: 0 },
  });

  return {

    async postMessage(params: SlackPostMessageParams): Promise<SlackPostMessageResult> {

      try {

        const response = await client.chat.postMessage({
          channel: params.channel,
          text: params.text,
          ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
          ...(params.blocks ? { blocks: params.blocks } : {}),
        });

        return {
          ok: response.ok !== false,
          ts: typeof response.ts === "string" ? response.ts : undefined,
        };

      } catch (error) {

        return { ok: false, error: normalizeSlackWebApiError(error) };

      }

    },

    async getThreadReplies(params) {
      try {
        const response = await client.conversations.replies({
          channel: params.channel,
          ts: params.ts,
          latest: params.latest,
          inclusive: true,
          limit: params.limit,
        });
        return { ok: response.ok !== false, messages: toContextMessages(response.messages) };
      } catch {
        return { ok: false, messages: [] };
      }
    },

    async getChannelHistory(params) {
      try {
        const response = await client.conversations.history({
          channel: params.channel,
          latest: params.latest,
          inclusive: false,
          limit: params.limit,
        });
        return { ok: response.ok !== false, messages: toContextMessages(response.messages) };
      } catch {
        return { ok: false, messages: [] };
      }
    },

  };

}

// SLACK_BOT_TOKEN未設定時は安全にnullを返す(既存core/tact-integration/
// providers/composio/client.tsのgetComposioClient()と同じ
// 「未設定時はclientを構築しない」既存パターン)。遅延生成+キャッシュ。
let cachedClient: SlackWebApiClient | null | undefined;

export function getSlackWebApiClient(): SlackWebApiClient | null {

  const token = getSlackBotToken();

  if (!token) {
    return null;
  }

  if (cachedClient !== undefined) {
    return cachedClient;
  }

  cachedClient = createProductionSlackWebApiClient(token);

  return cachedClient;

}
