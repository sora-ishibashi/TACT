import {
  WorkflowContext
} from "../context/types";

import {
  BrainAnalysis,
  BrainRule
} from "./types";


export function analyzeExecution(
  context: WorkflowContext
): BrainAnalysis {


  const issues: string[] = [];

  const improvements: BrainRule[] = [];

  const nextRules: BrainRule[] = [];



  // ==========================
  // Reviewer結果確認
  // ==========================

  const reviewer =
    context.outputs.reviewer;


  if (reviewer) {


    if (
      reviewer.issues &&
      Array.isArray(reviewer.issues)
    ) {

      issues.push(
        ...reviewer.issues
      );

    }



    if (
      reviewer.improvements &&
      Array.isArray(reviewer.improvements)
    ) {


      for (
        const item of reviewer.improvements
      ) {


        improvements.push({

          rule:
            typeof item === "string"
              ? item
              : item.rule ?? "Unknown",


          reason:
            "Reviewer改善要求を反映",


          createdAt:
            Date.now(),

        });


      }

    }

  }



  // ==========================
  // Evidence品質確認
  // ==========================

  if (
    context.evidence.length === 0
  ) {


    issues.push(
      "Evidenceが不足"
    );


    improvements.push({

      rule:
        "Researcherの検索品質を改善",


      reason:
        "Evidence不足を防ぐため",


      createdAt:
        Date.now(),

    });


    nextRules.push({

      rule:
        "Researcherは一次情報を優先する",


      reason:
        "Evidence信頼性向上のため",


      createdAt:
        Date.now(),

    });

  }



  // ==========================
  // Agent失敗確認
  // ==========================

  const failedAgents =
    Object.entries(
      context.agentStatus
    )
    .filter(
      ([, status]) =>
        status === "failed"
    )
    .map(
      ([agent]) =>
        agent
    );



  if (
    failedAgents.length > 0
  ) {


    issues.push(
      `Failed Agents: ${failedAgents.join(",")}`
    );


    const rule: BrainRule = {

      rule:
        "失敗したAgentの処理を確認する",


      reason:
        "Workflow安定性向上のため",


      createdAt:
        Date.now(),

    };


    improvements.push(rule);

    nextRules.push(rule);

  }



  // ==========================
  // Score
  // ==========================

  const score =
    Math.max(
      0,
      100 -
      issues.length * 10
    );



  return {

    score,

    issues,

    improvements,

    nextRules,

  };

}