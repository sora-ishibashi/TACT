import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";

import {
  LLMRequest,
  LLMResponse,
} from "../types";

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

        model: "gpt-4o-mini",

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

    return {

      content:
        message.content ?? "",

      toolCalls: [],

      toolResults: [],

    };

  } catch (error) {

    console.error(
      "OpenAI API Error:",
      error
    );

    throw new Error(
      "Failed to execute OpenAI request."
    );

  }

}