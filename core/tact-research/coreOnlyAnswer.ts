// =========================
// coreOnlyAnswer (STEP180/185)
// =========================
//
// assessAnswerability()がcanAnswerFromCoreOnly=trueと判定した場合に、
// LLMを一切使わずCode側で回答を構築する。
//
// 重要(STEP180絶対条件): 「文章の自然な言い換え」までLLMに依頼しては
// いけない。ここではKnowledge/Memoryのcontentフィールドをそのまま
// 採用するだけで、要約・言い換え・整形をLLMは一切行わない。
//
// STEP185: knowledgeGap.tsのcanAnswerAllFromCoreOnly()がtrueと
// 判定した場合(=全Requirementがcoveredかつ時間依存でない)に、
// 複数Requirement分の回答を組み立てるbuildCoreOnlyAnswerFromRequirements()
// を追加した。単一事実の場合(buildCoreOnlyAnswer())と同じ
// 「LLMに言い換えさせない」方針を維持する。

import type { AnswerabilityMatch } from "./answerability";
import type { ResearchRequirement } from "./knowledgeGap";
import type { CoreContext } from "../tact-core";
import type { ResearchEvidenceItem } from "./types";

export interface CoreOnlyAnswer {

  answer: string;

  evidence: ResearchEvidenceItem[];

  usedKnowledgeIds: string[];

  usedMemoryIds: string[];

  usedExampleIds: string[];

}

export function buildCoreOnlyAnswer(
  match: AnswerabilityMatch
): CoreOnlyAnswer {

  // assessAnswerability()は常にknowledge/memoriesのどちらか一方に
  // 最大1件だけを詰めて返す(拮抗する場合は0回経路自体を選ばないため)。
  const knowledgeItem = match.knowledge[0];
  const memoryItem = match.memories[0];

  const answer = knowledgeItem?.content ?? memoryItem?.content ?? "";

  // STEP195: idにKnowledgeItem/CoreMemory自身のidをそのまま使う
  // (Evidenceを新規生成しないCore-only経路では、根拠そのものである
  // KnowledgeItem.id/CoreMemory.idが監査対象として最も自然な識別子)。
  const evidence: ResearchEvidenceItem[] = [
    ...match.knowledge.map((item) => ({
      id: item.id,
      claim: item.title,
      source: item.source,
      confidence: "high" as const,
    })),
    ...match.memories.map((item) => ({
      id: item.id,
      claim: item.content,
      source: item.source,
      confidence: item.confidence,
    })),
  ];

  return {
    answer,
    evidence,
    usedKnowledgeIds: knowledgeItem ? [knowledgeItem.id] : [],
    usedMemoryIds: memoryItem ? [memoryItem.id] : [],
    // STEP180: Core-only経路は単純な事実取得(FAQ的質問)を対象と
    // しており、Example(お手本/成果物)は対象外とする(Exampleは
    // 将来のTACT Design接続で重視される概念であり、事実回答の
    // 根拠としては用いない、というSTEP180の設計判断)。
    usedExampleIds: [],
  };

}

// =========================
// buildCoreOnlyAnswerFromRequirements (STEP185)
// =========================
//
// Knowledge Gap Detectionが「全Requirementがcovered」と判定した
// 場合に、Requirementごとの最有力な根拠(matchedKnowledgeIds/
// matchedMemoryIdsの先頭、classifyRequirement()が既にスコア降順で
// 格納している)だけを採用し、単純に連結する。buildCoreOnlyAnswer()と
// 同じく、LLMによる言い換え・要約は一切行わない。
export function buildCoreOnlyAnswerFromRequirements(
  requirements: ResearchRequirement[],
  context: CoreContext
): CoreOnlyAnswer {

  const usedKnowledgeIds = new Set<string>();
  const usedMemoryIds = new Set<string>();
  const answerParts: string[] = [];
  const evidence: ResearchEvidenceItem[] = [];

  for (const requirement of requirements) {

    const topKnowledgeId = requirement.matchedKnowledgeIds[0];
    const topMemoryId = requirement.matchedMemoryIds[0];

    const knowledgeItem =
      topKnowledgeId
        ? context.knowledge.find((item) => item.id === topKnowledgeId)
        : undefined;

    const memoryItem =
      !knowledgeItem && topMemoryId
        ? context.memories.find((item) => item.id === topMemoryId)
        : undefined;

    if (knowledgeItem) {

      answerParts.push(knowledgeItem.content);

      usedKnowledgeIds.add(knowledgeItem.id);

      evidence.push({
        id: knowledgeItem.id,
        claim: knowledgeItem.title,
        source: knowledgeItem.source,
        confidence: "high",
      });

    } else if (memoryItem) {

      answerParts.push(memoryItem.content);

      usedMemoryIds.add(memoryItem.id);

      evidence.push({
        id: memoryItem.id,
        claim: memoryItem.content,
        source: memoryItem.source,
        confidence: memoryItem.confidence,
      });

    }

  }

  return {
    answer: answerParts.join("\n\n"),
    evidence,
    usedKnowledgeIds: Array.from(usedKnowledgeIds),
    usedMemoryIds: Array.from(usedMemoryIds),
    usedExampleIds: [],
  };

}
