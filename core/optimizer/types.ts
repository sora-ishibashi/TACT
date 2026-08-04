import {
  BrainRule
} from "../brain/types";


// ==========================
// Optimizer Result
// ==========================

export interface OptimizerResult {

  // 適用する改善ルール

  appliedRules:
    BrainRule[];


  // Agentごとの調整

  agentAdjustments:
    Record<
      string,
      string[]
    >;


  // Prompt追加情報

  promptUpdates:
    string[];


  createdAt:
    number;

}