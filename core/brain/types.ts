// =========================
// Brain Types
// =========================


export interface BrainRule {

  // 改善対象Agent
  targetAgent?: string;


  // 改善内容
  rule: string;


  // 改善理由
  reason: string;


  // 優先度
  priority?:
    | "low"
    | "medium"
    | "high";


  // 作成日時
  createdAt: number;

}


export interface BrainAnalysis {

  score: number;


  issues: string[];


  improvements: BrainRule[];


  nextRules: BrainRule[];


  // 最速実装モード STEP5: 構造化された自己改善情報。
  // 既存のimprovements(BrainRule[]、Optimizer→Brain Memoryへ渡す
  // ための簡易ルール)は引き続き維持し、こちらは「TACT Code」層
  // (STEP6)がClaude Code Instructionを組み立てるための、より
  // 詳細な構造を持つ。
  proposals: ImprovementProposal[];

}


// ==========================
// ImprovementProposal (最速実装モード STEP5)
// ==========================
//
// 「TACT自身が問題を発見し、原因を仮説立て、改善案とその根拠を
// 構造化して保存する」ための最小限の型。LLMによる高度な原因分析は
// 今回実装せず、既存のBrain Analysisが持つ決定論的なルール
// (Reviewer指摘・Evidence不足・Agent失敗・Execution Historyの
// パターン)を、この構造へマッピングするだけに留める。

export interface ImprovementProposal {

  problem: string;

  causeHypothesis: string;

  evidence: string;

  affectedAgent?: string;

  affectedWorkflow?: string;

  suggestion: string;

  expectedEffect: string;

  confidence: "low" | "medium" | "high";

  createdAt: number;

}