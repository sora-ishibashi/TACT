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
    // Phase88(Repository Evidence: Phase87投資調査): 以前は「比較」も
    // このカテゴリのkeywordに含めていたが、「数字で比較できる情報」
    // 「5件を比較」「比較表にしてください」のような、Comparison Table
    // 生成の文脈で自然に使われる表現まで誤って"competitor"へ分類され、
    // 無関係な検索接尾辞(「競合」「価格 比較」)が付加されていた。
    // 本当の競合調査(「競合サービスを比較して」「競合他社の価格を
    // 比較して」)は必ず「競合」という語自体を伴うため、「比較」単体は
    // このカテゴリの対象から外す(「競合」のみで判定する、既存の
    // 真の競合クエリは影響を受けない最小修正)。
    keywords: ["競合"],
    suffixes: ["競合", "価格 比較"],
  },

];

// Phase92(Repository Evidence: Phase91 Reality Test): 該当カテゴリが
// 無いqueryは、これまでqueryそのものをそのままSearch Providerへ渡して
// いた。しかし実Reality Testで、複数文にまたがる依頼(例:「愛知県内で
// 、大学生が参加しやすいインターンシップ・キャリアイベントについて
// 調査してください。2026年8月〜10月に開催されるものを中心に…確認
// できない情報は推測せず、確認できないものとして扱ってください。」)を
// そのままTavilyへ渡すと、「確認できない情報は推測せず」のような
// メタ指示文までもが検索語に混入し、個別イベントページではなく
// キーワードが広く一致するポータル/一覧ページばかりが上位に来ることが
// コードレベルで確認された(buildGapResearchQueries()→
// buildResearchQueries(requirement.query)→本関数、requirement.query=
// 生の複数文入力そのもの、Phase92投資調査)。
//
// 修正: queryが複数文(「。」を含む)にまたがる場合のみ、既存の
// extractResearchTopic()(Phase88、最初の文から依頼動詞句を除去する
// だけの決定論的処理、新しいNLUは追加しない)で得た核心トピックを
// 「追加の」検索語として使う。既存のqueryそのものは削除せず必ず残す
// (Section12絶対条件・既存Regression Testの「queries.length===1」
// 「queries.includes(query)」という契約を壊さないため)。単一文の
// queryや、条件抽出後にqueryと変わらない場合は従来通り[query]のまま
// (無関係な検索呼び出しを増やさない、既存挙動を尊重する)。
export function buildResearchQueries(
  query: string
): string[] {

  const matchedCategory = QUERY_CATEGORIES.find((category) =>
    category.keywords.some((keyword) => query.includes(keyword))
  );

  if (!matchedCategory) {

    if (query.includes("。")) {

      const condensedTopic = extractResearchTopic(query);

      if (condensedTopic && condensedTopic !== query) {
        return Array.from(new Set([condensedTopic, query]));
      }

    }

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
// extractResearchTopic (Phase88)
// =========================
//
// Root Cause(Phase87投資調査): 複数ターン会話で「さっき調べた内容に、
// 〜をさらに5件ほど追加で確認してください」のような追加調査要求が
// あった場合、この文自体には核心トピック(例:「愛知県」「スポーツ
// イベント」)が含まれない——「さっき調べた内容」という指示語で前Turn
// を参照しているだけであり、実際の検索クエリ(composeInputWithDependencies()
// → ResearchParams.query → buildResearchQueries())はこの文をそのまま
// 使うため、Search Providerへ渡るクエリから核心トピックが失われて
// いた。
//
// 修正方針: 前Turnのuser発言(OrchestrationRequest.previousUserInput、
// Phase86で追加済み)から、決定論的にトピック部分だけを抽出する
// (前Turn全文をそのまま検索語へ連結しない、絶対条件)。
//
// 依存方向の制約: core/tact-researchはcore/tact-conversationに依存
// できない(逆方向のみが許可された既存の一方向依存、Repository
// Evidenceで確認済み)。そのため、core/tact-conversation/
// artifactMutation.tsのderiveArtifactTitle()と同じ「最初の文から
// 依頼動詞句を取り除く」という考え方を、tact-research層で独立して
// 再実装する(コードの共有ではなく、同じ決定論的な技法を踏襲する
// だけ——新しいLLM呼び出し・新しいContext Architectureは追加しない)。
const TRAILING_RESEARCH_REQUEST_CLAUSE_PATTERN =
  /(?:について|を)?(?:調査し|調べ|確認し|探し|見つけ|整理し|まとめ|教え)(?:て|てください|てほしい|てもらえる)[^。]*$/;

export function extractResearchTopic(text: string): string {

  const trimmed = text.trim();

  if (!trimmed) {
    return "";
  }

  // 最初の文だけを対象にする(複数文にまたがる依頼の後半は「目的の
  // 説明」であることが多く、調査対象そのものではないため、
  // deriveArtifactTitle()と同じ判断)。
  const firstSentenceEnd = trimmed.indexOf("。");
  const firstSentence =
    firstSentenceEnd === -1 ? trimmed : trimmed.slice(0, firstSentenceEnd);

  const stripped = firstSentence.replace(TRAILING_RESEARCH_REQUEST_CLAUSE_PATTERN, "").trim();

  return stripped || firstSentence.trim();

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

// =========================
// buildDeepeningQueries (Phase93 Section8)
// =========================
//
// Discoveryで見つかったCandidate Entity(個別の調査対象らしいもの、
// candidateDiscovery.ts)について、不足Attributeを埋めるための検索語を
// 決定論的に生成する。LLMにQueryを自由生成させない(絶対条件、
// Section8「LLMに自由にSearch Queryを作らせることを第一選択に
// しない」)。「{entityName} {attribute1} {attribute2} ...」という
// 単純な連結のみ(新しいQuery文法・テンプレートエンジンは作らない、
// buildResearchQueries()と同じ「シンプルな文字列組み立てのみ」という
// 既存方針を踏襲する)。
// candidateDiscovery.tsのneedsDeepening()/selectDeepeningCandidates()も
// 同じ既定Attribute一覧を参照する(検索語生成と対象選定で語彙が
// 食い違わないよう、この配列を単一の情報源として共有する)。
export const DEFAULT_DEEPENING_ATTRIBUTES = ["開催日", "参加費", "定員"];

export function buildDeepeningQueries(
  candidateNames: string[],
  attributes?: string[]
): string[] {

  const attrs =
    attributes && attributes.length > 0 ? attributes : DEFAULT_DEEPENING_ATTRIBUTES;

  return candidateNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => `${name} ${attrs.join(" ")}`);

}
