// =========================
// Effective Model Tier (STEP161)
// =========================
//
// 責務分離(STEP161絶対条件1):
//
//   TaskProfile.modelTier (Base Model Tier)
//     ↓
//   BrainRecommendation (core/brain/optimizer.ts, STEP160)
//     ↓
//   Safety / Constraint Check ← このファイル
//     ↓
//   EffectiveModelTier
//     ↓
//   core/llm/executionStrategy.ts の resolveExecutionStrategy()
//
// Brainは「決定者」ではなく「最適化提案者」である。
// TaskProfile.modelTier(Base Model Tier)は一切書き換えない
// (STEP161絶対条件11: BaseとRecommendationとEffectiveを常に区別する。
// これによって将来のOptimizerが「タスク特性から決定されたTier」と
// 「過去実績からBrainが推薦したTier」を混同せずに学習できる)。
//
// 新しい型は作らない(STEP161絶対条件2): EffectiveModelTierは
// core/workflow/taskProfile.tsのModelTier型をそのまま使う
// (economy/standard/premiumの3値そのものであり、専用の型を
// 増やす必要がないため)。

import {
  ModelTier,
  TaskProfile,
  MODEL_TIER_BY_QUALITY_PROFILE,
} from "../workflow/taskProfile";
import { BrainRecommendation } from "./optimizer";

// =========================
// 定数
// =========================
//
// core/brain/optimizer.tsのCONFIDENCE_THRESHOLD(0.3)は「そもそも
// Recommendationを生成するか」の閾値であり、ここでの
// MIN_RECOMMENDATION_CONFIDENCEは「生成済みのRecommendationを実際に
// 採用するか」というより慎重な、別の判断軸である。既存の思想
// (confidenceが低ければ無理をしない)とは整合させつつ、意図的に
// より高い閾値を新設する(STEP161絶対条件3-1: 「新しい恣意的な数値を
// 増やす必要がある場合は定数化してください」)。
const MIN_RECOMMENDATION_CONFIDENCE = 0.5;

// Base Model TierよりTierを引き上げる(=コストが増える方向の変更)
// 場合は、引き下げる場合よりも慎重に扱う。「不要にpremiumへ
// 上げ続ける設計にはしない」(STEP161絶対条件4)ための、
// より高い専用閾値。
const MIN_UPGRADE_CONFIDENCE = 0.75;

const MODEL_TIER_RANK: Record<ModelTier, number> = {
  economy: 0,
  standard: 1,
  premium: 2,
};

// BrainRecommendation.modelTierは型上ModelTier | undefinedだが、
// DBに保存されたJSONBレコード経由で復元された値等、実行時の型保証が
// 効かない経路も将来的にありうるため、防御的にランタイムでも
// 検証する(STEP161絶対条件5「recommendationの構造が不正」への対応)。
function isValidModelTier(
  value: unknown
): value is ModelTier {

  return (
    value === "economy" ||
    value === "standard" ||
    value === "premium"
  );

}

// =========================
// resolveEffectiveModelTier
// =========================
//
// TaskProfileとBrainRecommendation、安全制約をすべて考慮した結果、
// 今回実際にLLM実行へ使用するModelTierを決定する。
//
// 採用しないケース(すべてBase Model Tierへフォールバックする。
// STEP161絶対条件5・15):
//   - brainRecommendationがnull/undefined
//   - brainRecommendation.modelTierが有効なModelTierでない
//   - confidenceが数値でない、またはMIN_RECOMMENDATION_CONFIDENCE未満
//   - 推薦Tierが、qualityProfileが要求する最低Tierを下回る
//   - 推薦TierがBaseより上位で、かつMIN_UPGRADE_CONFIDENCE未満
//
// 重要: taskProfile.modelTier自体はここで一切変更しない
// (呼び出し元がこの関数の戻り値を別の変数として保持する)。
export function resolveEffectiveModelTier(
  taskProfile: TaskProfile,
  brainRecommendation: BrainRecommendation | null | undefined
): ModelTier {

  const baseModelTier =
    taskProfile.modelTier;

  if (!brainRecommendation) {
    return baseModelTier;
  }

  if (!isValidModelTier(brainRecommendation.modelTier)) {
    return baseModelTier;
  }

  if (
    typeof brainRecommendation.confidence !== "number" ||
    brainRecommendation.confidence < MIN_RECOMMENDATION_CONFIDENCE
  ) {
    return baseModelTier;
  }

  const recommendedTier =
    brainRecommendation.modelTier;

  // qualityProfileが要求する最低Tierを、taskProfile.modelTierからでは
  // なくqualityProfileから独立に算出する(通常の実行経路では
  // taskProfile.modelTierと一致するが、安全側の基準を明示的に
  // qualityProfileから求めることで、将来taskProfile.modelTierの
  // 算出方法が変わっても、この安全制約自体は独立して機能する)。
  const minTier =
    MODEL_TIER_BY_QUALITY_PROFILE[taskProfile.qualityProfile];

  if (MODEL_TIER_RANK[recommendedTier] < MODEL_TIER_RANK[minTier]) {
    // qualityProfileが要求する品質水準を下回るため採用しない
    // (STEP161絶対条件3-2・11)。
    return baseModelTier;
  }

  if (recommendedTier === baseModelTier) {
    // 推薦がBaseと同じ場合、変更の必要がない。
    return baseModelTier;
  }

  if (
    MODEL_TIER_RANK[recommendedTier] > MODEL_TIER_RANK[baseModelTier] &&
    brainRecommendation.confidence < MIN_UPGRADE_CONFIDENCE
  ) {
    // Baseより上位のTierへの変更(コスト増加方向)は、より高い
    // confidenceが無ければ採用しない(STEP161絶対条件4)。
    return baseModelTier;
  }

  return recommendedTier;

}
