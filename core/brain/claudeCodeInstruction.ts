// =========================
// buildClaudeCodeInstruction (最速実装モード STEP6)
// =========================
//
// 「TACT Codeの第一段階」: TACTがClaude Codeを自動実行することは
// 今回一切行わない。ImprovementProposal(core/brain/analyzer.tsが
// 生成、core/brain/memory.tsがtact_memoryへ保存)を、人間が確認して
// そのままClaude Codeへ渡せる、構造化されたMarkdown指示文へ変換する
// 純粋関数だけを提供する。
//
// フォーマットは、このリポジトリで実際に運用されているSTEP指示書
// (本会話のSTEP117〜141)のスタイルを踏襲する
// (対象ファイル/現在の問題/再現条件/原因仮説/変更方針/変更禁止事項/
// テスト方法/完了条件)。

import { StoredImprovementProposal } from "./memory";

// affectedAgent文字列("planner"等)から、実際に変更対象になりやすい
// ファイルパスへの素朴なマッピング。既存のディレクトリ構成
// (core/agents/*.ts)をそのまま使うだけで、新しい命名規則は作らない。
const AGENT_FILE_HINTS: Record<string, string[]> = {
  planner: ["core/agents/planner.ts", "core/workflow/handlePlanner.ts"],
  researcher: ["core/agents/researcher.ts"],
  analyst: ["core/agents/analyst.ts"],
  designer: ["core/agents/designer.ts"],
  engineer: ["core/agents/engineer.ts"],
  stakeholder: ["core/agents/stakeholder.ts"],
  reviewer: ["core/agents/reviewer.ts"],
  writer: ["core/agents/writer.ts"],
};

// STEP142: TACT Code(core/codeAgent/)がCodeTask.targetFilesを
// 組み立てる際にも同じ推定ロジックを再利用するため、exportする
// (ロジック自体は変更しない)。
export function guessTargetFiles(affectedAgent?: string | null): string[] {

  if (!affectedAgent) return [];

  const agents = affectedAgent.split(",").map((a) => a.trim());

  const files = new Set<string>();

  for (const agent of agents) {

    const hints = AGENT_FILE_HINTS[agent];

    if (hints) {
      hints.forEach((f) => files.add(f));
    }

  }

  return Array.from(files);

}

export function buildClaudeCodeInstruction(
  proposal: StoredImprovementProposal
): string {

  const targetFiles = guessTargetFiles(proposal.targetAgent);

  return `# TACT Code 改善提案(自動生成・要人間確認)

生成日時: ${proposal.createdAtIso}
Proposal ID: ${proposal.id}
Confidence: ${proposal.confidence}

## 対象ファイル(推定・要確認)

${
  targetFiles.length > 0
    ? targetFiles.map((f) => `- ${f}`).join("\n")
    : "- (自動推定できませんでした。affectedAgent: " +
      `${proposal.targetAgent ?? "unknown"} から人間が判断してください)`
}

## 現在の問題

${proposal.problem}

## 再現条件

${proposal.evidence}

## 原因仮説

${proposal.causeHypothesis}

## 変更方針

${proposal.suggestion}

## 変更禁止事項

- この指示だけを根拠に、上記「対象ファイル」以外を変更しない
- 原因仮説は自動生成されたものであり未検証。人間の確認なしに
  大規模な変更を行わない
- Workflow構造・Agent責務そのものの変更が必要な場合は、着手前に
  停止して報告する(CLAUDE.mdの既存方針を踏襲)

## テスト方法

- 変更後、\`npx tsc --noEmit\` で新規エラーが無いことを確認する
- 可能であれば、本Proposalの根拠となったAgent構成・Taskを用いて
  実行し、score/issuesが改善しているかを確認する

## 完了条件

${proposal.expectedEffect}

---
このInstructionは自己改善ループ(TACT Brain → Optimizer →
ImprovementProposal)によって自動生成されました。TACT自身がこの
内容でClaude Codeを実行することはありません。人間が内容を確認した
上で、必要であれば手動でClaude Codeへ渡してください。
`;

}
