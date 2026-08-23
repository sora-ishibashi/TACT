// =========================
// LLM Evaluation Types (STEP170)
// =========================
//
// 目的: 「TaskProfile.modelTier → Brain → effectiveModelTier →
// ExecutionStrategy」という本番経路とは完全に独立した、
// Provider/Modelを直接指定して比較評価するための型を定義する。
//
// 重要な設計方針(STEP170絶対条件):
// - Tierを経由しない。ModelCandidateはprovider/modelを直接持つ。
// - 本番のExecutionRecord/ModelTierPattern(core/context/types.ts、
//   core/brain/pattern.ts)とは型を共有・混在させない
//   (「本番実行データ」と「モデルベンチマークデータ」を混同しない
//   ため)。構造が似ていても、意図的に別の型として定義する。
// - Brain/effectiveModelTier/ExecutionStrategyはこのファイルから
//   一切参照しない。

import type { Provider } from "../../agent/types";

// =========================
// EvaluationTaskCategory
// =========================
//
// TaskProfile.category(core/workflow/planner.tsがLLMで判定する
// 自由文字列)とは別の、評価専用の固定カテゴリ。本番のcategory判定
// ロジックには一切依存しない、評価ケースを分類するためだけの列挙。
export type EvaluationTaskCategory =
  | "simple"
  | "writing"
  | "research"
  | "reasoning"
  | "structured-output"
  | "long-context";

// =========================
// EvaluationCase
// =========================
//
// 同一入力を複数のModelCandidateへ投げて比較するための1ケース。
// runLLM()が受け取るLLMRequest(core/llm/types.ts)のうち、
// provider/modelを除いた部分(systemPrompt/userPrompt/
// responseFormat)だけを持つ(provider/modelはModelCandidate側が
// 決めるため、EvaluationCase自体は特定のモデルに依存しない)。
export interface EvaluationCase {

  id: string;

  category: EvaluationTaskCategory;

  systemPrompt: string;

  userPrompt: string;

  responseFormat?: "json" | "text";

}

// =========================
// ModelCandidate
// =========================
//
// 評価対象のProvider/Modelを直接指定する(STEP170絶対条件3、
// Tierを経由しない)。
export interface ModelCandidate {

  provider: Provider;

  model: string;

}

// =========================
// EvaluationResult
// =========================
//
// 1回の評価実行(1 EvaluationCase × 1 ModelCandidate)の結果。
// STEP170絶対条件7で列挙されたフィールドをそのまま採用する。
// 既存のExecutionRecord/ModelTierPatternとは意図的に型を共有しない。
export interface EvaluationResult {

  // 「1回の比較セッション」を表すID。同一EvaluationCaseを複数の
  // ModelCandidateへ投げて比較する場合、runEvaluationSuite()が
  // 全結果へ同じevaluationIdを発行するため、後から
  // 「どの結果同士が同じ比較対象だったか」を突き合わせられる
  // (個々のAPI呼び出し1回ごとのユニークIDではない)。
  evaluationId: string;

  caseId: string;

  taskCategory: EvaluationTaskCategory;

  provider: Provider;

  model: string;

  success: boolean;

  // successがtrueの場合のみ設定される。
  response?: string;

  // successがfalseの場合のみ設定される。APIキー等の秘密情報は
  // 含めない(core/llm/types.tsのLLMProviderError.messageと同じ
  // 既存方針を踏襲する。呼び出し元はcatchしたerrorのmessageを
  // そのまま使うだけで、新しい秘密情報の扱いは発生しない)。
  errorMessage?: string;

  // usage/costは既存のLLMResponse.usage/costが取得できた場合のみ
  // 設定される(取得できなかった場合はundefinedのまま。STEP159の
  // 「コスト計算失敗で処理を失敗させない」という既存方針を評価系でも
  // 踏襲する)。
  inputTokens?: number;

  outputTokens?: number;

  totalTokens?: number;

  estimatedUSD?: number;

  latencyMs: number;

  createdAt: string;

}
