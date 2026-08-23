// =========================
// mockDesignEngine (STEP178)
// =========================
//
// 重要: OpenAI/Claude等の実LLM呼び出しは一切行わない。既存の
// components/design/mockDesignAgent.ts(DocumentModelを対話的に
// 編集するための別のMock、STEP43〜140)とは責務・データ構造が
// 異なるため移植・再利用しない(STEP178-A監査結果)。ここでの
// 役割は、「CoreContext(knowledge/memories/examples、特に
// examples)が実際にTACT Designへ渡り、結果生成に反映される」
// ことをコード上で証明するための、決定論的なプレースホルダである。
// core/tact-research/mockResearchEngine.ts(STEP176/177)と同じ
// 位置づけ・同じ命名規則を踏襲した。
//
// STEP178-Cの最重要ポイント: DesignはCoreContext.examplesを
// 実際に利用する。関連するExampleが見つかった場合、その
// title/reason/categoryをoutputへ反映することで、「過去の良い
// 成果物・お手本を参照しながら作った」ことが結果から読み取れる
// ようにする。

import type {
  RelevantKnowledge,
  RelevantMemories,
  RelevantExamples,
} from "./types";

export interface MockDesignOutput {

  output: string;

  usedKnowledgeIds: string[];

  usedMemoryIds: string[];

  usedExampleIds: string[];

}

export function generateMockDesignOutput(
  request: string,
  knowledge: RelevantKnowledge,
  memories: RelevantMemories,
  examples: RelevantExamples
): MockDesignOutput {

  const notes: string[] = [];

  // STEP178-C: Exampleを最重要概念として扱う。単に件数を数える
  // だけでなく、どのお手本を参照したか(title/reason)をoutputへ
  // 明示的に反映する。
  if (examples.length > 0) {

    const exampleNotes = examples.map((example) => {

      const reasonPart = example.reason
        ? `(理由: ${example.reason})`
        : "";

      return `「${example.title}」${reasonPart}`;

    });

    notes.push(
      `${examples.length}件のお手本を参照しました: ${exampleNotes.join("、")}`
    );

  } else {

    notes.push("参照可能なお手本はまだ蓄積されていません。");

  }

  if (knowledge.length > 0) {
    notes.push(`関連するKnowledgeを${knowledge.length}件参照しました。`);
  }

  if (memories.length > 0) {
    notes.push(`過去の記憶を${memories.length}件考慮しました。`);
  }

  const output =
    `「${request}」についての成果物案(STEP178時点のモック実装)。` +
    notes.join(" ");

  return {

    output,

    usedKnowledgeIds: knowledge.map((item) => item.id),

    usedMemoryIds: memories.map((item) => item.id),

    usedExampleIds: examples.map((item) => item.id),

  };

}
