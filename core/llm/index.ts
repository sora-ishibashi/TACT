import { LLMRequest, LLMResponse } from "./types";
import { runOpenAI } from "./providers/openai";

export async function runLLM(
  request: LLMRequest
): Promise<LLMResponse> {

  return await runOpenAI(request);

}