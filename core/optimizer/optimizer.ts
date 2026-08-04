import {
  WorkflowContext
} from "../context/types";

import {
  OptimizerResult
} from "./types";

import {
  BrainRule
} from "../brain/types";



export function optimizeExecution(
  context: WorkflowContext
): OptimizerResult {


  const appliedRules:
    BrainRule[] = [];



  const agentAdjustments:
    Record<string,string[]> = {};



  const promptUpdates:
    string[] = [];



  const quality =
    context.executionRecord
      ?.quality;



  if (
    quality &&
    quality.improvements.length > 0
  ) {

    appliedRules.push(
      ...quality.improvements
    );

  }



  // ==========================
  // Agent別改善
  // ==========================


  for (
    const rule of appliedRules
  ) {


    if (
      rule.targetAgent
    ) {


      if (
        !agentAdjustments[
          rule.targetAgent
        ]
      ) {

        agentAdjustments[
          rule.targetAgent
        ] = [];

      }


      agentAdjustments[
        rule.targetAgent
      ].push(
        rule.rule
      );

    }



    promptUpdates.push(
      rule.rule
    );

  }



  return {

    appliedRules,


    agentAdjustments,


    promptUpdates,


    createdAt:
      Date.now(),

  };

}