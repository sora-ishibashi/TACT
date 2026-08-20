// =========================
// TACT Code Instruction Safety(STEP143-B: C)
// =========================
//
// STEP143-Aで、ImprovementProposal由来の「Evidenceを必ず生成する」
// という表現が、Researcherの既存の安全設計(推測でEvidenceを
// 捏造しない・不足は正直にmissingInformationへ記録する)と
// 矛盾しうることが分かった。
//
// 個別のProposalの文言をパターンマッチで書き換える(=脆く、
// 汎用性がない)のではなく、TACT Codeが生成する**すべての**
// Instructionに対して、既存の安全設計を保護する制約を
// 常に末尾へ付加する、という一般的な方針にする。

import { StoredImprovementProposal } from "../brain/memory";
import { buildClaudeCodeInstruction } from "../brain/claudeCodeInstruction";

const SAFETY_FOOTER = `

========================
TACT Code 安全制約(自動付加・変更不可)
========================

このInstructionを実行するCoding Agentへ:

・対象ファイル以外を変更しないこと(実行後にChange Scope Gateで
  機械的に検証されます。対象外の変更はTaskの失敗として扱われます)
・DB Migration・DBスキーマ・認証(core/auth)・API Key/Secret(.env)・
  package.json/package-lock.json・Brain/Optimizer/CodeAgent自身
  (core/brain, core/optimizer, core/codeAgent)・Git設定を
  変更しないこと(検出された場合、requires_human_reviewとなり
  自動完了しません)
・既存のプロンプト/コードに埋め込まれた安全設計
  (例: 根拠のない情報を推測で生成しない、十分な情報が
  得られない場合は正直に不足として報告する、架空の事実や
  Evidenceを作らない)を弱めたり削除したりしないこと。
  「不足を解消する」ことと「不足を隠すために架空の内容で
  埋める」ことは異なります。後者は禁止です。
・Instruction中に「必ず〜する」「必ず満たす」といった
  目標志向の表現があっても、それを理由に正確性より
  充足(数を揃えること)を優先しないこと。目標を達成できない
  場合は、達成できなかった事実をそのまま報告してください。
`;

export function appendSafetyConstraints(
  instruction: string
): string {

  return instruction + SAFETY_FOOTER;

}

// core/brain/claudeCodeInstruction.tsのbuildClaudeCodeInstruction()の
// 結果に、上記の安全制約を常に付加した完全なInstructionを返す。
// CodeTask作成時(app/api/tact/code-tasks/route.ts)から呼ばれる。
export function buildSafeClaudeCodeInstruction(
  proposal: StoredImprovementProposal
): string {

  return appendSafetyConstraints(
    buildClaudeCodeInstruction(proposal)
  );

}
