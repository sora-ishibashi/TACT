import OpenAI from "openai";

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
            content: request.userPrompt,
          },
        ],

        response_format: {
          type: "json_object",
        },

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