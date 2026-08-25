// =========================
// knowledgeGap (STEP185/187)
// =========================
//
// Knowledge Gap Detection。「Coreに何が既に存在し、何が不足して
// いるのか」をCODEだけで判定する(LLMは一切使わない、STEP185絶対
// 条件)。
//
// decomposeIntoRequirements()(requirementDecomposition.ts)が
// queryを情報要求単位(Requirement)へ分解した後、各Requirementに
// ついてCoreとの関連度を評価し、covered/partial/missingへ分類する。
//
// 重要: 新しい関連度アルゴリズムは作らない(STEP185絶対条件)。
// relevance.tsのscoreRelevance()(既存、STEP180)をそのまま再利用し、
// 閾値もanswerability.tsのMIN_RELEVANCE_SCORE(既存、STEP181)を
// そのまま再利用する。
//
// STEP187: relevanceScoreだけでcoveredと判定すると、「共有prefix
// 汚染」(同じ主語を持つ別Requirementが、n-gramの部分一致だけで
// coveredになってしまう問題、STEP185/186で発見)が起こり得る。
// これを補正するため、status==="covered"と判定した場合のみ、
// requirementSafety.tsのcheckRequirementSafety()で「年度不一致」
// 「時点の古さ」「数値不一致」「属性・指標不一致」を確認し、
// 問題があれば安全側(partial)へ降格する。昇格(missing/partial→
// covered)は行わない。

import type { CoreContext, CoreMemory, KnowledgeItem } from "../tact-core";
import { scoreRelevance } from "./relevance";
import { MIN_RELEVANCE_SCORE, hasTimeSensitiveSignal, isVolatileResearchKnowledge } from "./answerability";
import { decomposeIntoRequirements } from "./requirementDecomposition";
import {
  checkRequirementSafety,
  RequirementSafetyIssue,
} from "./requirementSafety";

export type RequirementStatus = "covered" | "partial" | "missing";

export interface ResearchRequirement {

  id: string;

  query: string;

  relevanceScore: number;

  matchedKnowledgeIds: string[];

  matchedMemoryIds: string[];

  matchedExampleIds: string[];

  status: RequirementStatus;

  // STEP187: このRequirementがcoveredから安全側へ降格された場合、
  // その理由を保持する(観測性・テスト用途)。降格が発生しなかった
  // 場合(covered維持・partial・missingいずれも)は空配列。
  safetyIssues: RequirementSafetyIssue[];

}

// STEP185: 「partial」の下限。answerability.tsのMIN_RELEVANCE_SCORE
// (covered相当)の半分を「関連情報が一部存在する」の目安とする
// (絶対条件: 既存のMIN_RELEVANCE_SCOREとの整合性を優先する)。
const PARTIAL_THRESHOLD = Math.ceil(MIN_RELEVANCE_SCORE / 2);

interface ScoredItem<T> {
  item: T;
  score: number;
}

function scoreItems<T>(
  items: T[],
  toSearchableText: (item: T) => string,
  query: string
): ScoredItem<T>[] {

  return items
    .map((item) => ({ item, score: scoreRelevance(toSearchableText(item), query) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score);

}

function classifyRequirement(
  id: string,
  requirementQuery: string,
  context: CoreContext
): ResearchRequirement {

  // Phase94: assessAnswerability()と同じ理由で、Requirementを
  // "covered"にできる根拠からvolatileなResearch由来Knowledgeを除外する
  // (isVolatileResearchKnowledge()、core/tact-research/answerability.ts参照)。
  const scoredKnowledge = scoreItems<KnowledgeItem>(
    context.knowledge.filter((item) => !isVolatileResearchKnowledge(item)),
    (item) => `${item.title} ${item.description ?? ""} ${item.content}`,
    requirementQuery
  );

  const scoredMemories = scoreItems<CoreMemory>(
    context.memories,
    (item) => item.content,
    requirementQuery
  );

  const topScore = Math.max(
    scoredKnowledge[0]?.score ?? 0,
    scoredMemories[0]?.score ?? 0
  );

  let status: RequirementStatus;

  if (topScore >= MIN_RELEVANCE_SCORE) {
    status = "covered";
  } else if (topScore >= PARTIAL_THRESHOLD) {
    status = "partial";
  } else {
    status = "missing";
  }

  // covered/partialの根拠として使うのは、閾値以上のものだけに限定する
  // (スコアが低い偶然の一致まで「一致した」として扱わない)。
  const matchedKnowledgeIds = scoredKnowledge
    .filter((scored) => scored.score >= PARTIAL_THRESHOLD)
    .map((scored) => scored.item.id);

  const matchedMemoryIds = scoredMemories
    .filter((scored) => scored.score >= PARTIAL_THRESHOLD)
    .map((scored) => scored.item.id);

  // STEP187: Requirement Safety Check。「covered」と判定された
  // 場合のみ、最上位一致(scoredKnowledge[0]/scoredMemories[0]の
  // うちスコアが高い方)の実際の文言をRequirementの文言と突き合わせ、
  // 年度・時点・数値・属性の明確な不一致が無いか確認する。
  // 安全側にしか動かさない(covered→partialのみ。missing/partialから
  // coveredへの昇格は行わない)。
  let safetyIssues: RequirementSafetyIssue[] = [];

  if (status === "covered") {

    const topKnowledge = scoredKnowledge[0];
    const topMemory = scoredMemories[0];

    const topMatchedText =
      topKnowledge && (!topMemory || topKnowledge.score >= topMemory.score)
        ? `${topKnowledge.item.title} ${topKnowledge.item.description ?? ""} ${topKnowledge.item.content}`
        : topMemory
          ? topMemory.item.content
          : "";

    const safety = checkRequirementSafety(requirementQuery, topMatchedText);

    if (!safety.safe) {
      status = "partial";
      safetyIssues = safety.issues;
    }

  }

  return {

    id,

    query: requirementQuery,

    relevanceScore: topScore,

    matchedKnowledgeIds,

    matchedMemoryIds,

    safetyIssues,

    // STEP180のbuildCoreOnlyAnswer()と同じ方針: Example(お手本)は
    // 事実回答の根拠としては用いない(将来のTACT Design接続向けの
    // 概念であり、Research Gap判定の対象外とする)。
    matchedExampleIds: [],

    status,

  };

}

export function detectKnowledgeGap(
  query: string,
  context: CoreContext
): ResearchRequirement[] {

  const requirementQueries = decomposeIntoRequirements(query);

  return requirementQueries.map((requirementQuery, index) =>
    classifyRequirement(`req-${index}`, requirementQuery, context)
  );

}

// STEP185絶対条件(セクション13): assessAnswerability()と矛盾しない
// ようにする。全Requirementがcoveredであっても、元のqueryが時間依存
// (「最新」「現在」「2026年」等)であれば、0回経路(Core-only)への
// 短絡を許可しない(hasTimeSensitiveSignal()をそのまま再利用する)。
export function canAnswerAllFromCoreOnly(
  query: string,
  requirements: ResearchRequirement[]
): boolean {

  if (hasTimeSensitiveSignal(query)) {
    return false;
  }

  if (requirements.length === 0) {
    return false;
  }

  return requirements.every((requirement) => requirement.status === "covered");

}
