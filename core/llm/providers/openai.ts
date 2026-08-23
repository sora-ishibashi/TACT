import OpenAI, { APIError, APIConnectionError } from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";

import {
  LLMRequest,
  LLMResponse,
  LLMUsage,
  LLMProviderError,
  LLMProviderFailureReason,
} from "../types";
import { calculateCost } from "../pricing";

// =========================
// classifyOpenAIError (STEP164)
// =========================
//
// core/tools/search/tavilyProvider.tsのclassifyTavilyError()と同じ
// 思想。OpenAI SDK(v6系)が公開している型付きエラークラス
// (openai/core/error.tsで定義、パッケージのトップレベルからexport
// 済みであることを確認済み)を使い、文字列マッチングに頼らず
// 構造的に分類する。
//
// 重要: quota超過(credit_balance_exhausted等)もrate limit超過も、
// OpenAI APIは同じHTTP 429(RateLimitError)で返す。実機で観測した
// エラー(STEP157/160)ではerror.code === "credit_balance_exhausted"、
// error.type === "insufficient_quota"だったため、これらをquota_exceeded
// として区別する。それ以外の429はrate_limited(一時的な制限、
// 再試行の余地がある)として区別する。
// exportするのはunit testから直接検証できるようにするため
// (副作用のない純粋関数であり、公開しても既存の振る舞いは変わらない)。
export function classifyOpenAIError(
  error: unknown
): { reason: LLMProviderFailureReason; message: string } {

  // 重要: APIConnectionErrorはAPIError(status/code/type等を持つ、
  // 実際にHTTPレスポンスが返ってきた場合のエラー)のサブクラスだが、
  // 意味的には別物(ネットワークレベルで接続自体に失敗し、
  // HTTPレスポンス自体が存在しない場合。DNS解決失敗・接続拒否等)。
  // そのため、より広い基底クラスであるAPIErrorのinstanceofチェックより
  // 先に判定する必要がある(順序を逆にすると、APIConnectionErrorも
  // 常にAPIError分岐へ吸収されてしまい、到達しない)。
  if (error instanceof APIConnectionError) {
    return { reason: "network_error", message: error.message };
  }

  if (error instanceof APIError) {

    const message = error.message;

    if (error.status === 429) {

      if (
        error.code === "credit_balance_exhausted" ||
        error.type === "insufficient_quota"
      ) {
        return { reason: "quota_exceeded", message };
      }

      return { reason: "rate_limited", message };

    }

    if (error.status === 401 || error.status === 403) {
      return { reason: "authentication_failed", message };
    }

    if (error.status === 400 || error.status === 422) {
      return { reason: "invalid_request", message };
    }

    return { reason: "unknown_error", message };

  }

  const message =
    error instanceof Error ? error.message : String(error);

  return { reason: "unknown_error", message };

}

if (!process.env.OPENAI_API_KEY) {
  throw new Error(
    "OPENAI_API_KEY is missing. Please check your .env file."
  );
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function runOpenAI(
  request: LLMRequest
): Promise<LLMResponse> {

  try {

    // STEP28: responseFormatが明示的に"text"の場合のみプレーンテキスト
    // 応答にする。省略時(undefined)を含め、それ以外は既存どおり
    // JSON modeを維持する(全既存Agent・Task Reconstructionの挙動を
    // 変えないため)。
    //
    // STEP32: imagesが指定された場合のみ、userメッセージを
    // マルチモーダル(text + image_url)なcontent配列にする。
    // 省略時(undefined、既存の全呼び出し)は従来どおり文字列のまま。
    const userContent: string | ChatCompletionContentPart[] =
      request.images && request.images.length > 0
        ? [
            {
              type: "text",
              text: request.userPrompt,
            },
            ...request.images.map((image) => ({
              type: "image_url" as const,
              image_url: {
                url: image.dataUrl,
              },
            })),
          ]
        : request.userPrompt;

    const response =
      await client.chat.completions.create({

        // STEP157: Execution Strategyが解決したモデル名を使う。
        // 省略時(Task Reconstruction/Advisor/画像説明等、Execution
        // Strategyを経由しない既存呼び出し元)は、従来どおり
        // "gpt-4o-mini"を使う(既存挙動を変えない)。
        model: request.model ?? "gpt-4o-mini",

        messages: [
          {
            role: "system",
            content: request.systemPrompt,
          },
          {
            role: "user",
            content: userContent,
          },
        ],

        response_format:
          request.responseFormat === "text"
            ? { type: "text" }
            : { type: "json_object" },

      });

    const message =
      response.choices[0].message;

    // STEP159: OpenAI SDKのresponse.usageをそのまま保持する
    // (推測によるtoken数計算は行わない)。usageが返らない場合
    // (旧APIバージョン・一部のレスポンス形式等)はundefinedのまま。
    const usage: LLMUsage | undefined =
      response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined;

    const resolvedModel =
      request.model ?? "gpt-4o-mini";

    // STEP159: usage・pricingのいずれかが欠けていてもcalculateCost()は
    // 例外を投げずundefinedを返す(コスト計算失敗でWorkflowを
    // 失敗させないため)。
    const cost =
      calculateCost(
        usage,
        "openai",
        resolvedModel
      );

    return {

      content:
        message.content ?? "",

      toolCalls: [],

      toolResults: [],

      usage,

      cost,

    };

  } catch (error) {

    console.error(
      "OpenAI API Error:",
      error
    );

    // STEP164: 生のOpenAI SDKエラーをそのまま投げず、Provider横断で
    // 扱える形(LLMProviderError)へ正規化する。呼び出し元
    // (core/workflow/runAgent.ts等)は既存どおりinstanceof Error・
    // error.messageで扱えるため、既存のcatch処理は変更不要
    // (LLMProviderErrorはErrorのサブクラス)。
    const { reason, message } =
      classifyOpenAIError(error);

    throw new LLMProviderError(
      "openai",
      reason,
      message
    );

  }

}