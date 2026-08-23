// =========================
// answerability (STEP180)
// =========================
//
// 「この質問はCoreにある情報だけで安全に回答できるか？」をLLMを
// 使わずに判定する純関数。STEP179監査の結論(CODE化可能な判定を
// LLMへ投げない)を反映した、Research Pipelineの②Answerability判定。
//
// 重要: 「Coreに関連情報が1件見つかった」だけでLLM 0回経路へ倒しては
// いけない(STEP180絶対条件)。以下の条件をすべて満たす場合のみ
// canAnswerFromCoreOnly=trueとする。
//
//   1. Simple fact pattern に一致する(曖昧な質問・比較・推論を伴う
//      質問は対象外)
//   2. 時間依存シグナルを含まない(「最新」「現在」「2026年」等)
//   3. Core内に十分関連度の高いKnowledge/Memoryが存在する
//      (MIN_RELEVANCE_SCORE以上)
//   4. 上位候補が拮抗していない(僅差で複数ヒットする場合は、矛盾・
//      曖昧さの可能性を疑い0回経路を見送る)
//
// 1つでも満たさない場合は必ずfalseを返し、呼び出し元(runResearch.ts)は
// Web Research経路(LLM最大1回)へ進む。

import type { CoreContext, CoreMemory, KnowledgeItem } from "../tact-core";
import { scoreRelevance } from "./relevance";

// STEP179監査で確認した、core/evidence/researchRequirement.ts・
// evidenceMode.tsと同じ考え方(正規表現ベースの機械判定)を、
// TACT Research内で独立して適用する。既存ファイル自体はimportも
// 変更もしない(STEP180絶対条件: core/evidence/*は変更禁止。
// importして再利用することは許可されているが、ここでの判定基準は
// Research固有の「Core-onlyで答えてよいか」であり、Legacy Workflowの
// 「検索が必要か」の判定とは目的が異なるため独立実装とした)。
const TIME_SENSITIVE_PATTERNS: RegExp[] = [
  /最新/,
  /現在/,
  /今日/,
  /今年/,
  /今月/,
  /今週/,
  /最近/,
  /直近/,
  /今の/,
  /現時点/,
  /トレンド/,
  /将来/,
  /今後/,
  /20\d{2}年/,
  /\blatest\b/i,
  /\bcurrent\b/i,
  /\btoday\b/i,
  /\bnow\b/i,
];

// STEP180の指示に挙げられた例(「○○とは？」「○○の所在地は？」等)を
// そのまま反映した、意図的に狭い正規表現セット。判定を緩くしすぎない
// ため、曖昧な質問・比較・分析を要求する質問には一致しないようにする。
const SIMPLE_FACT_PATTERNS: RegExp[] = [
  /とは[?？]?$/,
  /の(所在地|代表者|設立年|目的|定義)は/,
  /(以前|前回)決めた.*は(何|なに|どれ)/,
];

// 「十分関連度が高い」の閾値。scoreRelevance()はn-gram単位の重複を
// 加点していくため、真に関連するKnowledge/Memoryは複数のn-gramが
// 重複して比較的高いスコアになりやすい。偶然の短い部分一致だけで
// 0回経路に倒れないよう、単純な空白区切りtoken一致数(STEP177時点の
// 閾値=2)より高めに設定する。
//
// STEP185: knowledgeGap.tsのcovered/partial/missing判定でも、
// 「新しい関連度アルゴリズムを勝手に作らない」という絶対条件に
// 従い、この閾値をそのまま再利用する(exportして共有する)。
export const MIN_RELEVANCE_SCORE = 4;

// 上位候補と次点候補が僅差(次点 × 1.5 > 上位)の場合は、複数の
// Knowledge/Memoryが競合している可能性が高いとみなし、拮抗と判定する。
const DOMINANCE_RATIO = 1.5;

export interface AnswerabilityMatch {

  knowledge: KnowledgeItem[];

  memories: CoreMemory[];

}

export interface AnswerabilityResult {

  canAnswerFromCoreOnly: boolean;

  reason: string;

  match: AnswerabilityMatch;

}

// STEP185: knowledgeGap.tsの「全Requirementがcoveredであっても、
// 元のqueryが時間依存なら0回経路(Core-only)を許可しない」という
// 安全弁でもこの判定をそのまま再利用する(exportして共有する)。
// 時間依存性の判定基準を2箇所で別々に持たない。
export function hasTimeSensitiveSignal(query: string): boolean {
  return TIME_SENSITIVE_PATTERNS.some((pattern) => pattern.test(query));
}

function isSimpleFactPattern(query: string): boolean {
  return SIMPLE_FACT_PATTERNS.some((pattern) => pattern.test(query));
}

type ScoredItem =
  | { type: "knowledge"; item: KnowledgeItem; score: number }
  | { type: "memory"; item: CoreMemory; score: number };

const EMPTY_MATCH: AnswerabilityMatch = { knowledge: [], memories: [] };

export function assessAnswerability(
  query: string,
  context: CoreContext
): AnswerabilityResult {

  if (hasTimeSensitiveSignal(query)) {

    return {
      canAnswerFromCoreOnly: false,
      reason:
        "時間依存の質問(最新/現在/年号等)と判定したため、" +
        "Core情報のみでは回答せずWeb Researchへ進む。",
      match: EMPTY_MATCH,
    };

  }

  if (!isSimpleFactPattern(query)) {

    return {
      canAnswerFromCoreOnly: false,
      reason:
        "単純な事実質問のパターンに一致しないため、比較・分析・推論が" +
        "必要な可能性があると判断し、Web Research経路へ進む。",
      match: EMPTY_MATCH,
    };

  }

  const scoredKnowledge: ScoredItem[] = context.knowledge.map((item) => ({
    type: "knowledge",
    item,
    score: scoreRelevance(
      `${item.title} ${item.description ?? ""} ${item.content}`,
      query
    ),
  }));

  const scoredMemories: ScoredItem[] = context.memories.map((item) => ({
    type: "memory",
    item,
    score: scoreRelevance(item.content, query),
  }));

  const candidates = [...scoredKnowledge, ...scoredMemories]
    .filter((scored) => scored.score >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {

    return {
      canAnswerFromCoreOnly: false,
      reason:
        "十分に関連度の高いKnowledge/Memoryが見つからなかったため、" +
        "Web Research経路へ進む。",
      match: EMPTY_MATCH,
    };

  }

  const top = candidates[0];
  const second = candidates[1];

  if (second && second.score * DOMINANCE_RATIO > top.score) {

    return {
      canAnswerFromCoreOnly: false,
      reason:
        "複数のKnowledge/Memoryが拮抗しており、矛盾または曖昧さの" +
        "可能性があるため、0回経路を見送りWeb Research経路へ進む。",
      match: EMPTY_MATCH,
    };

  }

  const match: AnswerabilityMatch =
    top.type === "knowledge"
      ? { knowledge: [top.item], memories: [] }
      : { knowledge: [], memories: [top.item] };

  return {
    canAnswerFromCoreOnly: true,
    reason:
      "単純な事実質問であり、時間依存性がなく、Coreに十分関連する" +
      "情報が一意に存在するため、LLMを使わずCore情報のみで回答する。",
    match,
  };

}
