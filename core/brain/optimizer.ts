import {
  BrainPattern
} from "./pattern";


// ==========================
// Brain Recommendation
// ==========================

export interface BrainRecommendation {

  agents: string[];

  mode:
    | "quick"
    | "think"
    | "deep";

  reason: string;

}



// ==========================
// Workflow Optimization
// ==========================

export function optimizeWorkflow(

  userInput: string,

  patterns: BrainPattern[]

): BrainRecommendation | null {


  // 過去データなし

  if (
    patterns.length === 0
  ) {

    return null;

  }



  // 最も評価が高いPattern

  const bestPattern =
    patterns[0];



  return {

    agents:
      bestPattern.agents,


    mode:
      bestPattern.averageScore >= 85
        ? "deep"
        : "think",


    reason:
      `
過去の成功パターンを分析。

使用Agent:
${bestPattern.agents.join(", ")}

平均品質:
${bestPattern.averageScore}

実行回数:
${bestPattern.count}

成功率:
${Math.round(
  bestPattern.successRate * 100
)}%

今回の依頼:
${userInput}

`,

  };

}