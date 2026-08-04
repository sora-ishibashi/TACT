import type { Provider } from "../agent/types";

export interface LLMRequest {
  provider: Provider;

  systemPrompt: string;

  userPrompt: string;

  temperature?: number;

  maxTokens?: number;
}

export interface ToolCall {
  id: string;

  name: string;

  arguments: string;
}

export interface ToolExecution {
  toolCallId: string;

  output: string;
}

export interface LLMResponse {
  content: string;

  toolCalls?: ToolCall[];

  toolResults?: ToolExecution[];
}