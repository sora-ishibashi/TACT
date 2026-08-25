// =========================
// webResearch (STEP180)
// =========================
//
// Coreだけでは回答できない場合の③Web Research。LLMは一切使わない。
// STEP179監査で確認済みの、既にCODE/SEARCHとして成立している
// 既存基盤(core/tools/search/*・core/tools/pipeline/*・
// core/evidence/*)をそのまま呼び出すだけで、新しい検索・Evidence
// 処理ロジックは実装しない(STEP180絶対条件7,9)。
//
// DI(searchImpl)について: このプロジェクトの既存パターン
// (core/llm/runLLMWithFallback.tsのrunLLMImpl、core/llm/evaluation/
// runEvaluation.tsのrunLLMImpl)と同じ理由。TypeScriptコンパイル後の
// CJS exportはgetter-onlyでありモジュール差し替えができないため、
// テストでモックを注入できるよう、実装本体(searchWithFallback)への
// 参照をデフォルト引数として受け取る。本番呼び出し元(runResearch.ts)は
// この引数を省略するため、挙動は変わらない。

import {
  searchWithFallback,
  SearchProviderAttempt,
} from "../tools/search/searchWithFallback";
import { executeEvidencePipeline } from "../tools/pipeline/evidence";
import { selectEvidence } from "../evidence/selectEvidence";
import type { Evidence } from "../context/types";

// Phase93: Discovery/Deepeningの統合Evidence Pool(runResearch.ts)が、
// 同じ既定値を新しい定数として重複定義せずそのまま参照できるようexportする。
export const DEFAULT_MAX_EVIDENCE = 10;

export interface WebResearchResult {

  evidence: Evidence[];

  // 実際に結果を返したSearch Provider。全Provider失敗時はnull。
  searchProvider: string | null;

  queriesUsed: string[];

  // STEP184: buildResearchQueries()が生成したQuery数
  // (queriesUsed.lengthと同値だが、metadata構築時に呼び出し元が
  // 意図を読み取りやすいよう明示的なフィールド名として持たせる)。
  searchQueryCount: number;

  // STEP184: 実際にSearch Providerへ送信されたリクエストの総数
  // (各queryについてsearchWithFallback()が試行したProvider数の合計。
  // Tavilyが毎回成功すればsearchQueryCountと一致し、Tavily失敗→
  // Brave fallbackが発生した分だけ増える)。
  searchRequestCount: number;

  // STEP184: 各Provider試行の詳細をqueryをまたいで集約したもの。
  // searchWithFallback()自身が既に持つattempts情報
  // (STEP151-F、変更なし)を、Research層まで透過的に伝播させる。
  searchAttempts: SearchProviderAttempt[];

}

export async function performWebResearch(
  queries: string[],
  userQuery: string,
  maxEvidence: number = DEFAULT_MAX_EVIDENCE,
  searchImpl: typeof searchWithFallback = searchWithFallback
): Promise<WebResearchResult> {

  const rawResults: unknown[] = [];

  let lastProvider: string | null = null;

  const searchAttempts: SearchProviderAttempt[] = [];

  for (const query of queries) {

    const result = await searchImpl({ query });

    if (result.provider) {
      lastProvider = result.provider;
    }

    // STEP184: searchWithFallback()が既に構築しているattempts
    // (Provider名・成功可否・失敗理由)を、query単位で失わず
    // 蓄積する(STEP183で発見した「attempts情報が消える」問題への対応)。
    searchAttempts.push(...result.attempts);

    rawResults.push(...result.results);

  }

  // Search結果 → Normalize → Evidence化 → 重複排除
  // (core/tools/pipeline/evidence.ts、既存・変更なし)。
  const evidence = executeEvidencePipeline(rawResults, "tact-research");

  // 関連度・confidence・sourceType・freshnessを合成したスコアで
  // 上位N件へ絞り込む(core/evidence/selectEvidence.ts、既存・変更なし)。
  const selected = selectEvidence(evidence, userQuery, maxEvidence);

  return {
    evidence: selected,
    searchProvider: lastProvider,
    queriesUsed: queries,
    searchQueryCount: queries.length,
    searchRequestCount: searchAttempts.length,
    searchAttempts,
  };

}
