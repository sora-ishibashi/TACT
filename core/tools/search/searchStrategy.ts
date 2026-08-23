// =========================
// SearchStrategy (STEP158)
// =========================
//
// core/llm/executionStrategy.ts(STEP157、TaskProfile.modelTier →
// LLM Provider/Model)と同じ思想を検索実行へ適用する。
//
// 重要な責務分離: SearchStrategyはTaskProfile.searchIntensity
// (「どの程度の検索強度が必要か」)を実行パラメータ(maxResults/
// searchDepth/enabled)へ変換するだけであり、「Tavilyを使うか
// Braveを使うか」というProvider選択には一切関与しない。Provider
// 選択・fallback順序は既存のcore/tools/search/registry.ts
// (getSearchProvider()/getSearchProviderFallbackOrder())の責務の
// ままとする。
//
// 値の根拠(STEP158調査):
// - tavilyProvider.ts/braveProvider.tsは共にDEFAULT_MAX_RESULTS=8を
//   個別に定義しており、これがSTEP158以前の実質的な既定検索件数
//   だった。
// - tavilyProvider.tsはsearchDepthを無条件で"advanced"固定していた
//   (Tavily APIが受け付けるのは"basic"|"advanced"の2値のみ)。
// - Brave Search APIにはsearchDepthに相当する概念がない
//   (count件数のみ)。braveProvider.tsはSearchRequest.searchDepthを
//   単に参照しないため、型を共有しても実害はない。
// - "standard"の値をこの既存デフォルト(maxResults 8 / searchDepth
//   "advanced")と完全に一致させることで、taskProfile未接続だった
//   既存呼び出し経路の挙動を変えずに済む(下記DEFAULT_SEARCH_STRATEGY
//   参照)。
import { SearchIntensity } from "../../workflow/taskProfile";

export interface SearchStrategy {

  // false の場合、Search Providerを一切呼び出さない
  // (searchIntensity === "none" に対応)。
  enabled: boolean;

  maxResults: number;

  searchDepth: "basic" | "advanced";

}

const SEARCH_STRATEGY_BY_INTENSITY: Record<SearchIntensity, SearchStrategy> = {

  // evidenceMode "none" と1:1対応。加えてhandlePlanner()側で
  // evidenceMode === "none" の場合はresearcher自体がfinalTeamから
  // 除外される(STEP70の既存ロジック、EVIDENCE_MODE_NONE_EXCLUDED_
  // AGENTS)ため、この分岐は現状の到達経路上は発生しない想定。
  // それでも「searchIntensity=noneならSearch Providerを呼ばない」
  // というSTEP158の絶対条件を、Tool実行の入口(executeToolPipeline.ts)
  // でも直接保証しておく(将来Researcher以外のAgentがweb-searchを
  // 持つ変更等が入っても壊れない防御的な実装)。
  none: {
    enabled: false,
    maxResults: 0,
    searchDepth: "basic",
  },

  // 少量・浅い検索。Tavilyの"basic"depthは"advanced"よりコスト・
  // レイテンシが低い(公式仕様)。
  light: {
    enabled: true,
    maxResults: 4,
    searchDepth: "basic",
  },

  // STEP158以前の既定値(DEFAULT_MAX_RESULTS=8 / searchDepth
  // "advanced")とそのまま一致させる。
  standard: {
    enabled: true,
    maxResults: 8,
    searchDepth: "advanced",
  },

  // 多め・深い検索。Tavily/Brave双方とも1回のリクエストで許容できる
  // 件数の範囲内(20件程度まで)に収める。
  deep: {
    enabled: true,
    maxResults: 14,
    searchDepth: "advanced",
  },

};

// taskProfileが存在しない呼び出し元向けのfallback。STEP158以前の
// webSearch.tsはsearchWithFallback({query})をmaxResults/searchDepth
// 省略で呼んでいた(=各Providerの既存デフォルト)ため、その挙動と
// 完全に一致する"standard"をそのまま流用する(既存動作を壊さない
// fallbackを新設するのではなく、既存動作そのものを表す値を再利用する)。
const DEFAULT_SEARCH_STRATEGY: SearchStrategy =
  SEARCH_STRATEGY_BY_INTENSITY.standard;

export function resolveSearchStrategy(
  searchIntensity?: SearchIntensity
): SearchStrategy {

  if (!searchIntensity) {
    return DEFAULT_SEARCH_STRATEGY;
  }

  return SEARCH_STRATEGY_BY_INTENSITY[searchIntensity];

}
