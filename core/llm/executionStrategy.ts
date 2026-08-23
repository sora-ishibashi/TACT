// =========================
// Execution Strategy (STEP157)
// =========================
//
// 責務: TaskProfile(core/workflow/taskProfile.ts)を、実際に
// runLLM()へ渡すProvider/Modelへ変換する。この変換をここ1箇所に
// 集約し、Agent定義(core/agents/*.ts)やWorkflow側にモデル名を
// ハードコードさせない(STEP157の絶対条件7)。
//
//   TaskProfile.modelTier ("economy"|"standard"|"premium")
//     ↓
//   ExecutionStrategy { provider, model }
//     ↓
//   core/llm/index.ts の runLLM(request) が request.provider/model
//   をそのまま使う
//
// 重要な設計方針:
// - STEP155/157の調査で、.envに設定されているLLM Provider向け
//   API Keyは OPENAI_API_KEY のみであることを確認済み
//   (ANTHROPIC/CLAUDE/GEMINI系のキーは存在しない)。そのため、
//   今回すべてのModelTierはProvider "openai" にのみ対応付ける。
//   存在しないProvider(claude/gemini)を推測でダミー実装しない
//   (STEP157絶対条件4)。
// - 対応付けるモデル名は、実際にこのAPI Keyで呼び出し可能である
//   ことを事前に確認したものだけを使う(models.retrieve()および
//   実際のchat.completions.create()呼び出しで検証済み:
//   gpt-4o-mini / gpt-4o / gpt-4.1)。
// - Agent別の細かい最適化(Agentごとに異なるモデルを使う等)は
//   今回のスコープ外。1回のWorkflow実行につき、TaskProfileから
//   導かれる単一のExecutionStrategyを、その実行内の全Agent呼び出し
//   (Planner自身を除く。理由は下記resolveExecutionStrategy()参照)
//   に一律で適用する。

import { ModelTier } from "../workflow/taskProfile";
import type { Provider } from "../agent/types";

export interface ExecutionStrategy {

  provider: Provider;

  model: string;

}

// =========================
// modelTier → ExecutionStrategy
// =========================
//
// economy : 現行の既定(gpt-4o-mini)をそのまま踏襲する。TaskProfileが
//           未確定の場合(Planner自身の実行時。下記参照)のフォール
//           バックもこれと同じ値になるため、既存の挙動を変えない。
// standard: レポート・調査・比較等(qualityProfile "high")向けの
//           上位モデル。
// premium : 論文レベル・一次情報優先(qualityProfile "maximum")向けの
//           最上位モデル。
const EXECUTION_STRATEGY_BY_MODEL_TIER: Record<ModelTier, ExecutionStrategy> = {

  economy: {
    provider: "openai",
    model: "gpt-4o-mini",
  },

  standard: {
    provider: "openai",
    model: "gpt-4o",
  },

  premium: {
    provider: "openai",
    model: "gpt-4.1",
  },

};

// modelTierが未確定の場合の既定値。既存の挙動(常にgpt-4o-mini)を
// 変えないよう、economyと同じ値にする。
const DEFAULT_EXECUTION_STRATEGY: ExecutionStrategy =
  EXECUTION_STRATEGY_BY_MODEL_TIER.economy;

// =========================
// resolveExecutionStrategy
// =========================
//
// STEP163: 引数をTaskProfileからModelTierへ変更した。Execution
// Strategyの責務は「最終的に決定されたTierをProvider/Modelへ変換する
// こと」だけであり、TaskProfile自体を読む必要はない(STEP161絶対条件7:
// 「Execution Strategyの責務を、TaskProfile判定・Brain分析・Safety
// 判定まで肥大化させない」)。どのModelTierを最終的に使うか
// (TaskProfile.modelTierをそのまま使うか、Brain Recommendationを
// 安全制約で調停したEffectiveModelTierを使うか)は、呼び出し元
// (core/workflow/runAgent.ts)が
// core/brain/effectiveModelTier.tsのresolveEffectiveModelTier()の
// 結果(context.effectiveModelTier)を使って解決する責務であり、
// ここでは一切判断しない。
//
// TaskProfile/EffectiveModelTierのいずれも未確定な場合
// (Planner自身のLLM呼び出し時点。STEP157絶対条件6: 「Plannerの
// モデル選択を無理に変更しなくてよい」)は、DEFAULT_EXECUTION_STRATEGY
// (economy)を返すことで、この状況を特別扱いのコードなしに自然に
// 処理する(Planner呼び出し = 常にeconomy = 現行のgpt-4o-mini固定と
// 同じ)。
// STEP164: EXECUTION_STRATEGY_BY_MODEL_TIERのキー集合そのものから
// 動的に導出する(economy/standard/premiumという値をここで再度
// 書き出さない)。
const VALID_MODEL_TIERS =
  new Set(
    Object.keys(EXECUTION_STRATEGY_BY_MODEL_TIER)
  );

export function resolveExecutionStrategy(
  modelTier?: ModelTier
): ExecutionStrategy {

  // STEP164: TypeScriptの型上はModelTier(economy/standard/premium)
  // しか渡らないはずだが、DBに保存されたJSONBレコード経由で復元された
  // 値等、実行時の型保証が効かない経路も将来的にありうる
  // (core/brain/effectiveModelTier.tsのisValidModelTier()と同じ
  // 防御的設計)。未知の値の場合、undefinedを返して呼び出し元を
  // クラッシュさせるのではなく、DEFAULT_EXECUTION_STRATEGY(economy)へ
  // 安全側にフォールバックする。
  if (!modelTier || !VALID_MODEL_TIERS.has(modelTier)) {
    return DEFAULT_EXECUTION_STRATEGY;
  }

  return EXECUTION_STRATEGY_BY_MODEL_TIER[modelTier];

}
