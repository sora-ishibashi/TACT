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

}