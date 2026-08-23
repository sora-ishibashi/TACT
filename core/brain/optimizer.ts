import {
  BrainPattern,
  ModelTierPattern
} from "./pattern";
import { ModelTier, TaskProfile } from "../workflow/taskProfile";


// ==========================
// Brain Recommendation
// ==========================
//
// STEP160: agents/modeは既存のoptimizeWorkflow()(Agent構成中心の
// Recommendation)専用のフィールドであり、下記recommendModelTier()
// (modelTier専用のRecommendation)はこれらを設定しない。新しい型を
// 作らずこの既存型を拡張して両方の用途に使うため、agents/modeを
// 必須から任意へ緩和する(既存の唯一の呼び出し元
// core/workflow/index.tsはoptimizeWorkflow()経由で常にagents/modeを
// 設定済みのため、この変更で既存呼び出し元が壊れることはない)。
export interface BrainRecommendation {

  agents?: string[];

  mode?:
    | "quick"
    | "think"
    | "deep";

  reason: string;

  // STEP160: recommendModelTier()が設定する。optimizeWorkflow()側は
  // 設定しない(Agent構成の推奨とmodelTierの推奨は独立した軸のため)。
  modelTier?: ModelTier;

  // STEP160: 0〜1。過去データのサンプル数から算出する、この
  // Recommendationの信頼度。低い場合はrecommendModelTier()自体が
  // nullを返すため、この値が設定されている場合は常に
  // CONFIDENCE_THRESHOLD以上になる。
  confidence?: number;

}



// ==========================
// Workflow Optimization
// ==========================

export function optimizeWorkflow(

  userInput: string,

  patterns: BrainPattern[]

): BrainRecommendation | null {


  // 過去データなし

  if (
    patterns.length === 0
  ) {

    return null;

  }



  // 最も評価が高いPattern

  const bestPattern =
    patterns[0];



  return {

    agents:
      bestPattern.agents,


    mode:
      bestPattern.averageScore >= 85
        ? "deep"
        : "think",


    reason:
      `
過去の成功パターンを分析。

使用Agent:
${bestPattern.agents.join(", ")}

平均品質:
${bestPattern.averageScore}

実行回数:
${bestPattern.count}

成功率:
${Math.round(
  bestPattern.successRate * 100
)}%

今回の依頼:
${userInput}

`,

  };

}



// ==========================
// Model Tier Recommendation (STEP160)
// ==========================
//
// 目的: 過去のExecutionRecord(TaskProfile・cost・quality)から、
// 「この種類のタスクでは、どのmodelTierが品質とコストのバランスで
// 最も妥当だったか」を判断する。STEP160では判断結果を返すところまでで、
// TaskProfile.modelTierを実際に書き換える接続はまだ行わない
// (呼び出し元core/workflow/index.tsが結果をログ・ExecutionRecordへ
// 記録するだけに留める)。
//
// 比較粒度についての設計判断:
// TaskProfile.modelTierはqualityProfileから決定論的に導出される
// (core/workflow/taskProfile.tsのMODEL_TIER_BY_QUALITY_PROFILE、
// instant/standard→economy、high→standard、maximum→premium、他の
// 入力に依存しない1:1写像)。そのため、category×evidenceMode×
// qualityProfileを厳密一致でフィルタすると、qualityProfileが1つに
// 定まった時点でmodelTierも1つに定まってしまい、原理的に2つ以上の
// modelTierを比較できない(比較対象が常に1件になる)。
// このRecommendationの目的は「同じ種類の仕事(category)であれば、
// 過去に別のqualityProfile判定(→別のmodelTier)で実行された場合と
// 比べてどうだったか」を見ることなので、比較のグルーピングは
// categoryのみで行い、その中でmodelTierごとに(qualityProfile値が
// 異なっていても)再集計する。ModelTierPattern自体は
// category×evidenceMode×qualityProfile×modelTierの粒度で保持して
// いるため、より細かい粒度が必要になった場合も既存のデータ構造を
// 変更せずに済む。

// この件数未満のmodelTierは比較対象に含めない
// (サンプル1件だけで判断しない)。
const MIN_SAMPLES_PER_TIER = 2;

// 比較可能なmodelTierがこの数未満なら、そもそも比較が成立しない
// (=Recommendationを出さない)。
const MIN_COMPARABLE_TIERS = 2;

// 信頼度がこの値未満ならRecommendationを出さない
// (初期データ不足時に無理な推奨をしないための安全弁)。
const CONFIDENCE_THRESHOLD = 0.3;

// 品質スコア(0-100)の許容差。最高品質のTierからこの差の範囲内に
// あるTierは「品質面で同等」とみなし、その中で最もコストが低い
// Tierを推奨する(=単純に品質最大のモデルを選ばない、STEP160の
// 絶対条件)。
const QUALITY_TOLERANCE = 5;

// 比較対象の合計サンプル数がこの件数に達したら信頼度1.0とみなす
// (線形にスケールする単純な設計。STEP160では複雑な統計モデルは
// 導入しない)。
const CONFIDENCE_FULL_AT_TOTAL_COUNT = 10;

interface TierStats {

  modelTier: ModelTier;

  averageScore: number;

  successRate: number;

  count: number;

  averageCostUSD?: number;

}

export function recommendModelTier(
  taskProfile: TaskProfile,
  modelTierPatterns: ModelTierPattern[]
): BrainRecommendation | null {

  // 同じcategoryのPatternのみを対象にする(理由は上記コメント参照)。
  const relevant =
    modelTierPatterns.filter(
      (p) => p.category === taskProfile.category
    );

  if (relevant.length === 0) {
    return null;
  }

  // modelTierごとに再集計する。同じmodelTierが複数の
  // evidenceMode/qualityProfileにまたがっている場合、countで
  // 加重平均する(既存BrainPatternの単純移動平均とは異なり、
  // ここでは複数Patternの束ね直しのため加重平均を使う)。
  const byTier = new Map<
    ModelTier,
    {
      weightedScoreSum: number;
      weightedSuccessSum: number;
      totalCount: number;
      weightedCostSum: number;
      totalCostSampleCount: number;
    }
  >();

  for (const p of relevant) {

    const acc =
      byTier.get(p.modelTier) ?? {
        weightedScoreSum: 0,
        weightedSuccessSum: 0,
        totalCount: 0,
        weightedCostSum: 0,
        totalCostSampleCount: 0,
      };

    acc.weightedScoreSum += p.averageScore * p.count;
    acc.weightedSuccessSum += p.successRate * p.count;
    acc.totalCount += p.count;

    if (p.averageCostUSD !== undefined) {
      acc.weightedCostSum += p.averageCostUSD * p.costSampleCount;
      acc.totalCostSampleCount += p.costSampleCount;
    }

    byTier.set(p.modelTier, acc);

  }

  const tierStats: TierStats[] =
    Array.from(byTier.entries())
      .map(([modelTier, acc]) => ({
        modelTier,
        averageScore: acc.weightedScoreSum / acc.totalCount,
        successRate: acc.weightedSuccessSum / acc.totalCount,
        count: acc.totalCount,
        averageCostUSD:
          acc.totalCostSampleCount > 0
            ? acc.weightedCostSum / acc.totalCostSampleCount
            : undefined,
      }))
      .filter((t) => t.count >= MIN_SAMPLES_PER_TIER);

  if (tierStats.length < MIN_COMPARABLE_TIERS) {
    // 比較できるmodelTierが1つ以下(=データ不足)。
    return null;
  }

  const totalCount =
    tierStats.reduce((sum, t) => sum + t.count, 0);

  const confidence =
    Math.min(1, totalCount / CONFIDENCE_FULL_AT_TOTAL_COUNT);

  if (confidence < CONFIDENCE_THRESHOLD) {
    // データ不足でBrainが無理に推奨しない(STEP160の絶対条件)。
    return null;
  }

  const bestScore =
    Math.max(...tierStats.map((t) => t.averageScore));

  // 最高品質からQUALITY_TOLERANCE以内のTierを「品質面で同等」とみなす。
  const acceptable =
    tierStats.filter(
      (t) => t.averageScore >= bestScore - QUALITY_TOLERANCE
    );

  const costComparable =
    acceptable.filter((t) => t.averageCostUSD !== undefined);

  let recommended: TierStats;
  let costNote: string;

  if (costComparable.length > 0) {

    // 品質面で同等なTierの中から、最もコストが低いものを選ぶ
    // (=単純に品質最大のモデルを選ばない)。
    recommended =
      costComparable.reduce((cheapest, t) =>
        t.averageCostUSD! < cheapest.averageCostUSD!
          ? t
          : cheapest
      );

    costNote = "";

  } else {

    // 比較対象の全Tierにcostデータが存在しない(STEP159以前の
    // Recordのみで構成されている)場合、コスト比較はできないため
    // 品質最良のTierをそのまま推奨する。
    recommended =
      acceptable.reduce((best, t) =>
        t.averageScore > best.averageScore
          ? t
          : best
      );

    costNote =
      "(比較対象にコストデータがないため、品質のみで判断しました)";

  }

  console.log(`[Brain] task category=${taskProfile.category}`);
  console.log(`[Brain] current modelTier=${taskProfile.modelTier}`);
  console.log(`[Brain] recommended modelTier=${recommended.modelTier}`);
  console.log(`[Brain] confidence=${confidence.toFixed(2)}`);

  const reason =
    `
過去実績分析(category=${taskProfile.category}):

${tierStats
  .map(
    (t) =>
      `${t.modelTier}: quality=${t.averageScore.toFixed(1)}, ` +
      `cost=${
        t.averageCostUSD !== undefined
          ? `$${t.averageCostUSD.toFixed(4)}`
          : "不明"
      }, count=${t.count}, successRate=${Math.round(
        t.successRate * 100
      )}%`
  )
  .join("\n")}

現在のmodelTier: ${taskProfile.modelTier}
推奨modelTier: ${recommended.modelTier}
${costNote}
`.trim();

  console.log(`[Brain] reason=${reason}`);

  return {

    modelTier: recommended.modelTier,

    confidence,

    reason,

  };

}