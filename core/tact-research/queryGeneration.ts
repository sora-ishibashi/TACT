// =========================
// queryGeneration (STEP180/185)
// =========================
//
// core/agents/queryBuilder.ts(Legacy Agent、LLM 1回)を廃止し、
// CODEベースの検索Query生成へ置き換える。STEP179監査の結論
// (「searchTargetsは検索キーワードではなくカテゴリであり、
// カテゴリさえ決まればテーブル引きで済む」)を反映する。
//
// 重要: 巨大なテンプレートを一度に作らない(STEP180絶対条件)。
// まずはqueryBuilder.tsが持っていた知識のうち、最小限
// (企業/市場/競合の3カテゴリ)だけを移植する。該当カテゴリが
// 見つからない場合は、ユーザーのqueryをそのまま単一の検索語として
// 使う(=無理にカテゴリを当てはめない、安全側のフォールバック)。
//
// Legacy Agent(core/agents/queryBuilder.ts)自体はimportしない。
// ここに書くのは「検索対象カテゴリの知識」であり、Agent実行の
// 仕組みではない。

import type { ResearchRequirement } from "./knowledgeGap";

interface QueryCategory {

  name: string;

  // ユーザーのqueryにこのいずれかが含まれていればこのカテゴリとみなす。
  keywords: string[];

  // queryへ付加する検索観点(queryBuilder.tsの
  // searchTargets/検索観点の知識を最小限移植したもの)。
  suffixes: string[];

}

const QUERY_CATEGORIES: QueryCategory[] = [

  {
    name: "company",
    keywords: ["会社", "企業", "社について"],
    suffixes: ["会社概要", "事業内容", "業績"],
  },

  {
    name: "market",
    keywords: ["市場"],
    suffixes: ["市場規模", "市場成長率", "主要プレイヤー"],
  },

  {
    name: "competitor",
    keywords: ["競合", "比較"],
    suffixes: ["競合", "価格 比較"],
  },

];

export function buildResearchQueries(
  query: string
): string[] {

  const matchedCategory = QUERY_CATEGORIES.find((category) =>
    category.keywords.some((keyword) => query.includes(keyword))
  );

  if (!matchedCategory) {

    // 該当カテゴリが無い場合は、queryそのものを唯一の検索語とする
    // (存在しないカテゴリへ無理に当てはめない)。
    return [query];

  }

  const generatedQueries = matchedCategory.suffixes.map(
    (suffix) => `${query} ${suffix}`
  );

  // 元のqueryそのものも検索対象に含め、重複は除去する。
  return Array.from(new Set([query, ...generatedQueries]));

}

// =========================
// buildGapResearchQueries (STEP185)
// =========================
//
// Knowledge Gap Detectionが「covered」と判定したRequirementについては
// 検索Queryを一切生成しない(STEP185絶対条件: 不要な検索を消すことが
// 目的であり、query数を機械的に減らすことが目的ではない)。
// 「partial」「missing」のRequirementについてのみ、既存の
// buildResearchQueries()(企業/市場/競合カテゴリテンプレート)を
// Requirement単位で再利用する。新しいQuery生成ロジックは作らない。
export function buildGapResearchQueries(
  requirements: Pick<ResearchRequirement, "query" | "status">[]
): string[] {

  const needsSearch = requirements.filter(
    (requirement) => requirement.status !== "covered"
  );

  if (needsSearch.length === 0) {
    return [];
  }

  const queries = needsSearch.flatMap((requirement) =>
    buildResearchQueries(requirement.query)
  );

  return Array.from(new Set(queries));

}
