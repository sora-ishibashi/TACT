// =========================
// pricing (STEP159)
// =========================
//
// core/tools/search/registry.ts(STEP151、Provider生成の集約点)・
// core/llm/executionStrategy.ts(STEP157、modelTier→Provider/Model)と
// 同じ思想で、「Provider + Modelから料金を解決する」処理をここへ
// 集約する。Workflow側(core/workflow/runAgent.ts等)は個々のモデルの
// 単価を一切意識しない。
//
// 重要な安全設計(STEP159の絶対条件): 料金が不明なモデルについて
// 勝手な価格を推測しない。ここに存在しないmodelはgetModelPricing()が
// undefinedを返し、calculateCost()もundefinedを返す。呼び出し元
// (core/llm/providers/openai.ts)はcalculateCost()の結果を
// LLMResponse.costへそのまま代入するだけで、undefinedであっても
// 例外を投げない(コスト計算失敗でWorkflowを失敗させないため)。

import type { Provider } from "../agent/types";
import { LLMCost, LLMUsage } from "./types";

export interface ModelPricing {

  // 100万トークンあたりの単価(USD)。
  inputPerMillionUSD: number;

  outputPerMillionUSD: number;

}

// STEP159調査時点(2026-08)でOpenAI公式料金ページに掲載されている値。
// STEP157で実在・利用可否を確認済みの3モデル(gpt-4o-mini/gpt-4o/
// gpt-4.1)のみを対象とする。将来料金改定があった場合、実際の請求額と
// estimatedUSD(あくまで見積もり)がずれる可能性がある。
const OPENAI_PRICING: Record<string, ModelPricing> = {

  "gpt-4o-mini": {
    inputPerMillionUSD: 0.15,
    outputPerMillionUSD: 0.60,
  },

  "gpt-4o": {
    inputPerMillionUSD: 2.50,
    outputPerMillionUSD: 10.00,
  },

  "gpt-4.1": {
    inputPerMillionUSD: 2.00,
    outputPerMillionUSD: 8.00,
  },

};

// STEP166調査時点(2026-08)でAnthropic公式Pricingページ
// (https://docs.anthropic.com/en/docs/about-claude/pricing)で確認した値。
// STEP166で実在・利用可否を確認済みの1モデル(claude-haiku-4-5-20251001、
// client.models.list()で実際にこのAPI Keyから取得可能であることを確認済み)
// のみを対象とする。claude-sonnet-5/claude-opus-5等の他モデルは
// STEP166時点では料金を未確認のため、意図的にこのテーブルへ含めない
// (STEP159の絶対条件「料金が不明なモデルについて勝手な価格を
// 推測しない」を踏襲。これらのモデルはgetModelPricing()がundefinedを
// 返し、calculateCost()もundefinedを返す)。
const ANTHROPIC_PRICING: Record<string, ModelPricing> = {

  "claude-haiku-4-5-20251001": {
    inputPerMillionUSD: 1.00,
    outputPerMillionUSD: 5.00,
  },

};

export function getModelPricing(
  provider: Provider,
  model: string
): ModelPricing | undefined {

  if (provider === "openai") {
    return OPENAI_PRICING[model];
  }

  if (provider === "claude") {
    return ANTHROPIC_PRICING[model];
  }

  // STEP166時点でgeminiは未実装(core/llm/index.ts参照)。
  // 対応するpricingも持たない。
  return undefined;

}

// usage・pricingのいずれかが欠けている場合はundefinedを返すだけで、
// 例外は一切投げない(呼び出し元のtry/catchに依存しない安全設計)。
export function calculateCost(
  usage: LLMUsage | undefined,
  provider: Provider,
  model: string
): LLMCost | undefined {

  if (!usage) {
    return undefined;
  }

  const pricing =
    getModelPricing(provider, model);

  if (!pricing) {
    return undefined;
  }

  const inputCostUSD =
    (usage.inputTokens / 1_000_000) *
    pricing.inputPerMillionUSD;

  const outputCostUSD =
    (usage.outputTokens / 1_000_000) *
    pricing.outputPerMillionUSD;

  return {

    tokens: usage.totalTokens,

    estimatedUSD: inputCostUSD + outputCostUSD,

  };

}
