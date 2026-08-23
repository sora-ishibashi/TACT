// =========================
// Claude Provider (STEP166)
// =========================
//
// core/llm/providers/openai.ts(STEP157〜164で確立したOpenAI Providerの
// 責務分離)と同じ構造で実装する。このProviderの責務は、
//
// - Claude(Anthropic Messages API)へのリクエスト
// - model指定
// - messages/system promptへの変換
// - responseの正規化(LLMResponse.content)
// - usage取得(LLMResponse.usage)
// - cost計算に必要なtoken情報の返却(core/llm/pricing.ts経由)
// - APIエラーの正規化(LLMProviderError)
//
// だけであり、Brain/TaskProfile/ExecutionStrategyを直接参照しない
// (STEP164絶対条件2、Providerの責務分離)。
//
// モデル名について: 実際にこのAPI Keyで呼び出し可能であることを
// client.models.list()で確認済みのモデルのみを使う
// (STEP157の「存在しないモデル名を推測して実装しない」という方針を
// 踏襲)。STEP166時点で確認・対応しているのはclaude-haiku-4-5-20251001
// のみ(core/llm/pricing.tsのANTHROPIC_PRICINGも同じモデルのみ対応)。
// 他のClaude模型(claude-sonnet-5/claude-opus-5等、いずれもAPI経由で
// 実在は確認済み)は、料金が未確認のためデフォルトモデルとしては
// 使わない(呼び出し元がrequest.modelで明示的に指定した場合は
// そのまま渡す。ただしcalculateCost()は未確認モデルに対しては
// undefinedを返す)。

import Anthropic, {
  APIError,
  APIConnectionError,
} from "@anthropic-ai/sdk";

import {
  LLMRequest,
  LLMResponse,
  LLMUsage,
  LLMProviderError,
  LLMProviderFailureReason,
} from "../types";
import { calculateCost } from "../pricing";

// STEP166時点で実在・利用可能なことを確認済みの唯一のモデル
// (core/llm/pricing.tsのANTHROPIC_PRICINGと同じキー)。
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";

// Anthropic Messages APIはmax_tokensが必須(OpenAIと異なりデフォルト値が
// 存在しない)。既存のLLMRequest.maxTokensは現時点でどの呼び出し元も
// 設定していないため、TACTのAgent出力(構造化JSON、比較的長文になり
// 得る)を打ち切らない程度の値をデフォルトとして採用する。
const DEFAULT_MAX_TOKENS = 8192;

// =========================
// classifyClaudeError (STEP166)
// =========================
//
// core/llm/providers/openai.tsのclassifyOpenAIError()と同じ思想。
// Anthropic SDKの型付きエラークラス(APIError/APIConnectionError、
// パッケージのトップレベルからexport済みであることを確認済み)を使い、
// 構造的に分類する。
//
// 重要な注意(STEP166時点の確認事項): Anthropic APIのエラーは
// OpenAIのような専用の`code`フィールド(例: credit_balance_exhausted)を
// 持たない。公式ドキュメント上、クレジット残高不足は400
// (invalid_request_error)として返されることがあるため、429
// (rate_limit_error、純粋なレート制限)とは区別し、400かつメッセージに
// 残高不足を示す語彙が含まれる場合のみquota_exceededとして扱う
// (このメッセージベースの判定は実機のクレジット枯渇事例で検証できて
// いないため、100%の精度は保証しない。誤ってinvalid_requestに
// 分類されても、Workflow側の扱い上は同じ「失敗」として扱われるため
// 実害は小さい)。
export function classifyClaudeError(
  error: unknown
): { reason: LLMProviderFailureReason; message: string } {

  // APIConnectionErrorはAPIErrorのサブクラスのため、より広い基底
  // クラスの判定より先にチェックする(core/llm/providers/openai.tsと
  // 同じ理由)。
  if (error instanceof APIConnectionError) {
    return { reason: "network_error", message: error.message };
  }

  if (error instanceof APIError) {

    const message = error.message;

    const lowerMessage = message.toLowerCase();

    if (error.status === 429) {
      return { reason: "rate_limited", message };
    }

    if (error.status === 401) {
      return { reason: "authentication_failed", message };
    }

    if (error.status === 403) {
      return { reason: "authentication_failed", message };
    }

    if (error.status === 400) {

      if (
        lowerMessage.includes("credit balance") ||
        lowerMessage.includes("insufficient")
      ) {
        return { reason: "quota_exceeded", message };
      }

      return { reason: "invalid_request", message };

    }

    if (error.status === 422) {
      return { reason: "invalid_request", message };
    }

    return { reason: "unknown_error", message };

  }

  const message =
    error instanceof Error ? error.message : String(error);

  return { reason: "unknown_error", message };

}

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    "ANTHROPIC_API_KEY is missing. Please check your .env file."
  );
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// data URL("data:image/png;base64,....")をAnthropicのimage content block
// (base64 source)へ変換する。不正な形式の場合はnullを返す
// (呼び出し元は該当画像を無視する。Workflow全体は失敗させない)。
function parseDataUrl(
  dataUrl: string
): { mediaType: string; data: string } | null {

  const match =
    /^data:([^;]+);base64,(.+)$/.exec(dataUrl);

  if (!match) {
    return null;
  }

  return {
    mediaType: match[1],
    data: match[2],
  };

}

export async function runClaude(
  request: LLMRequest
): Promise<LLMResponse> {

  try {

    // STEP32のOpenAI Provider実装と同じ思想: imagesが指定された場合
    // のみマルチモーダルなcontent配列にする。省略時は文字列のまま。
    const userContent:
      | string
      | Anthropic.MessageParam["content"] =
      request.images && request.images.length > 0
        ? [
            {
              type: "text" as const,
              text: request.userPrompt,
            },
            ...request.images
              .map((image) => parseDataUrl(image.dataUrl))
              .filter(
                (parsed): parsed is { mediaType: string; data: string } =>
                  parsed !== null
              )
              .map((parsed) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type:
                    parsed.mediaType as
                      | "image/jpeg"
                      | "image/png"
                      | "image/gif"
                      | "image/webp",
                  data: parsed.data,
                },
              })),
          ]
        : request.userPrompt;

    // STEP28のOpenAI Provider実装と同じ思想: responseFormatが明示的に
    // "text"の場合を除き、JSON出力を期待する。ただしAnthropic Messages
    // APIにはOpenAIのresponse_format:{type:"json_object"}に相当する
    // 専用モードが無いため、system prompt側への短い指示で代替する
    // (TACTの既存Agent呼び出し元は、いずれの場合もcleanJSON()で
    // Markdownコードフェンス等を許容して解析するため、この指示が
    // 効かなかった場合でも既存のパース処理でカバーされる)。
    const systemPrompt =
      request.responseFormat === "text"
        ? request.systemPrompt
        : `${request.systemPrompt}\n\nRespond with valid JSON only. Do not include Markdown code fences or any explanation outside the JSON.`;

    const response =
      await client.messages.create({

        model: request.model ?? DEFAULT_CLAUDE_MODEL,

        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,

        system: systemPrompt,

        messages: [
          {
            role: "user",
            content: userContent,
          },
        ],

      });

    // content配列のうちtext blockだけを連結する(tool_use等の
    // 他ブロック種別は現時点で使わないため無視する)。
    const content =
      response.content
        .filter(
          (block): block is Anthropic.TextBlock =>
            block.type === "text"
        )
        .map((block) => block.text)
        .join("");

    // STEP159のOpenAI Provider実装と同じ思想: SDKレスポンスの実測値
    // (input_tokens/output_tokens)をそのまま保持する。推測によるtoken数
    // 計算は行わない。
    const usage: LLMUsage | undefined =
      response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens:
              response.usage.input_tokens +
              response.usage.output_tokens,
          }
        : undefined;

    const resolvedModel =
      request.model ?? DEFAULT_CLAUDE_MODEL;

    // STEP159のOpenAI Provider実装と同じ思想: usage・pricingのいずれか
    // が欠けていてもcalculateCost()は例外を投げずundefinedを返す
    // (コスト計算失敗でWorkflowを失敗させないため)。
    const cost =
      calculateCost(
        usage,
        "claude",
        resolvedModel
      );

    return {

      content,

      toolCalls: [],

      toolResults: [],

      usage,

      cost,

    };

  } catch (error) {

    console.error(
      "Claude API Error:",
      error
    );

    // STEP164のOpenAI Provider実装と同じ思想: 生のAnthropic SDKエラーを
    // そのまま投げず、Provider横断で扱える形(LLMProviderError)へ
    // 正規化する。
    const { reason, message } =
      classifyClaudeError(error);

    throw new LLMProviderError(
      "claude",
      reason,
      message
    );

  }

}
