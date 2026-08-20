import type { Provider } from "../agent/types";

export interface LLMRequest {
  provider: Provider;

  systemPrompt: string;

  userPrompt: string;

  temperature?: number;

  maxTokens?: number;

  // STEP28: 既存の全Agent/Task Reconstructionは常にJSON応答を前提と
  // しているため、省略時(undefined)は従来どおりJSON modeのまま
  // 変更しない。Advisorのように自然文で回答させたい場合のみ
  // "text"を明示的に指定する。
  responseFormat?: "json" | "text";

  // STEP32: 画像添付ファイルの内容を説明させるためだけに使う
  // (core/fileAnalysis/describeImage.ts)。省略時(undefined)は
  // 従来どおりテキストのみのuserPromptとして扱われ、既存の
  // Agent/Task Reconstruction/Advisorの呼び出しには一切影響しない。
  images?: { dataUrl: string }[];
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