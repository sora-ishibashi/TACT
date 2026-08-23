import type { Provider } from "../agent/types";

export interface LLMRequest {
  provider: Provider;

  // STEP157: Execution Strategy(core/llm/executionStrategy.ts)が
  // TaskProfile.modelTierから解決した具体的なモデル名。省略時
  // (undefined、Task Reconstruction/Advisor/画像説明等、Workflowの
  // Execution Strategyを経由しない既存呼び出し元)は、各Provider実装
  // 側の既存デフォルト(例: core/llm/providers/openai.tsの
  // "gpt-4o-mini")をそのまま使う。既存呼び出し元の挙動は変えない。
  model?: string;

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

// STEP159: OpenAI Chat Completions APIのresponse.usageをそのまま
// 保持するための構造体。推測によるtoken数計算は行わず、SDKレスポンス
// の実測値のみを保持する(絶対条件)。Provider側がusageを返さなかった
// 場合はLLMResponse.usage自体がundefinedになる。
export interface LLMUsage {
  inputTokens: number;

  outputTokens: number;

  totalTokens: number;
}

// STEP159: core/context/types.tsのExecutionRecord.cost(STEP155調査で
// 既に存在を確認済み)と全く同じ形状。新しいcostの概念を増やすのでは
// なく、1回のLLM呼び出し単位でも同じ形状を使うことで、Workflow側の
// 集計(core/context/index.tsのaccumulateLLMCost())を単純な加算だけで
// 済ませる。
export interface LLMCost {
  tokens: number;

  estimatedUSD: number;
}

export interface LLMResponse {
  content: string;

  toolCalls?: ToolCall[];

  toolResults?: ToolExecution[];

  // STEP159: usage取得に失敗した場合(Provider未対応・レスポンス欠落等)
  // はundefinedのまま。呼び出し元はusage欠落時にコスト計算を行わない
  // (Workflowを失敗させない)。
  usage?: LLMUsage;

  // STEP159: usageとpricing(core/llm/pricing.ts)の両方が判明した
  // 場合のみ設定される。未知のmodel・usage取得失敗時はundefinedのまま。
  cost?: LLMCost;
}

// =========================
// LLM Provider Error (STEP164)
// =========================
//
// core/tools/search/types.tsのSearchProviderError/
// SearchProviderFailureReason(STEP151)と同じ思想。Provider固有の
// 例外(OpenAI SDKのAPIError等)を、Provider横断で扱える形へ正規化する。
// 「APIエラーの正規化」はProviderの責務の一つ(STEP164絶対条件2)であり、
// 将来Claude/Gemini Providerを追加した際も同じ型・同じreasonの集合を
// 再利用できるようにするため、core/llm/providers/配下ではなくこの
// 共有型ファイルへ置く。
//
// API Keyそのものは絶対にmessageへ含めない(各Provider実装側の責務。
// OpenAI SDKのエラーレスポンス自体にAPI Keyが含まれることはない)。
export type LLMProviderFailureReason =
  | "quota_exceeded"
  | "authentication_failed"
  | "rate_limited"
  | "invalid_request"
  | "network_error"
  | "unknown_error";

export class LLMProviderError extends Error {

  readonly provider: Provider;

  readonly reason: LLMProviderFailureReason;

  constructor(
    provider: Provider,
    reason: LLMProviderFailureReason,
    message: string
  ) {

    super(message);

    this.provider = provider;

    this.reason = reason;

    this.name = "LLMProviderError";

  }

}