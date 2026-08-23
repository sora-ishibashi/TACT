import {
  ExecutionRecord
} from "../context/types";
import { EvidenceMode } from "../evidence/evidenceMode";
import { QualityProfile } from "../workflow/qualityProfile";
import { ModelTier } from "../workflow/taskProfile";


// ==========================
// Brain Pattern
// ==========================

export interface BrainPattern {

  // 使用されたAgent構成
  agents: string[];


  // 平均品質
  averageScore: number;


  // 実行回数
  count: number;


  // 成功率
  successRate: number;

}



// ==========================
// Pattern Analysis
// ==========================

export function analyzePatterns(
  records: ExecutionRecord[]
): BrainPattern[] {


  const patterns:
    Record<string, BrainPattern> = {};



  for (
    const record of records
  ) {


    const key =
      record.agents.join(",");



    if (
      !patterns[key]
    ) {


      patterns[key] = {

        agents:
          record.agents,


        averageScore:
          record.quality?.score ?? 0,


        count:
          1,


        successRate:
          record.success
            ? 1
            : 0,

      };


    } else {


      const pattern =
        patterns[key];


      pattern.count++;


      pattern.averageScore =
        (
          pattern.averageScore +
          (
            record.quality?.score ?? 0
          )
        ) / 2;



      if(record.success){

        pattern.successRate =
          (
            pattern.successRate *
            (pattern.count - 1)
            +
            1
          )
          /
          pattern.count;

      }
      else {

        pattern.successRate =
          (
            pattern.successRate *
            (pattern.count - 1)
          )
          /
          pattern.count;

      }

    }

  }



  return Object.values(
    patterns
  )
  .sort(
    (a,b)=>
      b.averageScore -
      a.averageScore
  );

}



// ==========================
// Model Tier Pattern (STEP160)
// ==========================
//
// 既存のBrainPattern(Agent構成中心のグルーピング)とは別に、
// TaskProfile(STEP156)・ExecutionRecord.cost(STEP159)を軸とした
// グルーピングを追加する。既存のanalyzePatterns()は変更せず、
// 同じ「Record[]を受け取り、キーごとに集計してから配列で返す」
// スタイルを踏襲した新規関数として追加する(既存Optimizerの
// 責務・データ構造は壊さない)。
//
// グルーピングキーはcategory×evidenceMode×qualityProfile×modelTierの
// 4軸とする(STEP160の「可能ならevidenceModeまで扱える設計にする」
// を満たす)。taskProfileを持たない過去Record(STEP156以前に保存された
// もの)は対象外とする。

export interface ModelTierPattern {

  category: string;

  evidenceMode: EvidenceMode;

  qualityProfile: QualityProfile;

  modelTier: ModelTier;

  // 平均品質(既存BrainPattern.averageScoreと同じ0-100スケール、
  // 同じ単純移動平均の考え方を踏襲する)。
  averageScore: number;

  count: number;

  successRate: number;

  // STEP159以前に保存されたExecutionRecordにはcostが存在しない。
  // costサンプルが1件もない場合は0円ではなくundefinedのままにする
  // (「コスト不明」と「無料だった」を混同しないため)。
  averageCostUSD?: number;

  costSampleCount: number;

}

export function analyzeModelTierPatterns(
  records: ExecutionRecord[]
): ModelTierPattern[] {

  const patterns:
    Record<string, ModelTierPattern> = {};

  for (
    const record of records
  ) {

    // STEP156以前のRecordにはtaskProfileが存在しないため、
    // Model Tier比較の対象から除外する(新しい判定ロジックは
    // 追加せず、単純にスキップするだけ)。
    if (!record.taskProfile) {
      continue;
    }

    const {
      category,
      evidenceMode,
      qualityProfile,
      modelTier,
    } = record.taskProfile;

    const key =
      `${category}|${evidenceMode}|${qualityProfile}|${modelTier}`;

    const scoreValue =
      record.quality?.score ?? 0;

    const hasCost =
      typeof record.cost?.estimatedUSD === "number";

    if (
      !patterns[key]
    ) {

      patterns[key] = {

        category,
        evidenceMode,
        qualityProfile,
        modelTier,

        averageScore:
          scoreValue,

        count:
          1,

        successRate:
          record.success
            ? 1
            : 0,

        averageCostUSD:
          hasCost
            ? record.cost!.estimatedUSD
            : undefined,

        costSampleCount:
          hasCost
            ? 1
            : 0,

      };

    } else {

      const pattern =
        patterns[key];

      pattern.count++;

      // 既存analyzePatterns()と同じ単純移動平均の考え方を踏襲する
      // (直近のRecordほど重みが大きくなる、既存の性質も引き継ぐ)。
      pattern.averageScore =
        (
          pattern.averageScore +
          scoreValue
        ) / 2;

      if (record.success) {

        pattern.successRate =
          (
            pattern.successRate *
            (pattern.count - 1)
            +
            1
          )
          /
          pattern.count;

      } else {

        pattern.successRate =
          (
            pattern.successRate *
            (pattern.count - 1)
          )
          /
          pattern.count;

      }

      if (hasCost) {

        pattern.averageCostUSD =
          pattern.costSampleCount === 0
            ? record.cost!.estimatedUSD
            : (
                (pattern.averageCostUSD ?? 0) +
                record.cost!.estimatedUSD
              ) / 2;

        pattern.costSampleCount++;

      }

    }

  }

  return Object.values(
    patterns
  );

}