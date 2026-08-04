import { Workflow } from "./types";
import * as AgentsModule from "../agents";
import { createContext } from "../context";
import { runAgent } from "./runAgent";
import { handlePlanner } from "./handlePlanner";
import { handleReviewer } from "./handleReviewer";
import { WorkflowEvent } from "../context/types";
import { checkEvidence } from "../evidence/checkEvidence";
import { optimizeExecution} from "../optimizer/optimizer";
import { getExecutionHistory} from "../brain/history";
import { analyzePatterns} from "../brain/pattern";
import { optimizeWorkflow} from "../brain/optimizer";
import { analyzeExecution } from "../brain";
import {saveBrainMemory} from "../brain/memory";

const { agents } = AgentsModule;


export function createWorkflow(workflow: Workflow) {

  console.log(
    "Workflow created:",
    workflow.name
  );

  return workflow;

}



export async function runWorkflow(
  workflow: Workflow,
  userInput: string,
  mode: "quick" | "think" | "deep" = "think",
  onEvent?: (event: WorkflowEvent) => void
) {


  const context =
    createContext(
      userInput,
      mode
    );

// ==========================
// Brain Optimizer
// ==========================

const history =
  getExecutionHistory();


const patterns =
  analyzePatterns(
    history
  );


const brainRecommendation =
  optimizeWorkflow(
    userInput,
    patterns
  );


if(
  brainRecommendation
){

  console.log(
    "Brain Recommendation"
  );

  console.log(
    brainRecommendation
  );

}

  const executionStartTime =
    Date.now();



  console.log(
    "Running workflow:",
    workflow.name,
    `(${mode})`
  );



  let dynamicPlan = [
    ...workflow.steps,
  ];


  let plannerExecuted = false;


  let currentStep = 0;


  let reviewCount = 0;


  const MAX_REVIEW = 3;



  while (
    currentStep < dynamicPlan.length
  ) {


    const step =
      dynamicPlan[currentStep];



    const agent =
      agents.find(
        a => a.id === step.agent
      );



    if (!agent) {

      throw new Error(
        `Agent '${step.agent}' not found.`
      );

    }



    console.log(
      `${agent.name} -> ${step.task}`
    );



    // ==========================
    // Agent開始
    // ==========================


    context.agentStatus[agent.id] =
      "running";



    const startEvent: WorkflowEvent = {

      type: "start",

      agent: agent.id,

      timestamp: Date.now(),

    };



    context.events.push(
      startEvent
    );


    onEvent?.(
      startEvent
    );



    context.logs.push({

      agent: agent.id,

      message: "Started",

      timestamp: Date.now(),

    });



    let parsed;



    try {


      parsed =
        await runAgent(
          agent,
          step,
          context
        );



      context.agentStatus[agent.id] =
        "completed";



      const completeEvent: WorkflowEvent = {

        type: "complete",

        agent: agent.id,

        timestamp: Date.now(),

      };



      context.events.push(
        completeEvent
      );


      onEvent?.(
        completeEvent
      );



      context.logs.push({

        agent: agent.id,

        message: "Completed",

        timestamp: Date.now(),

      });



    } catch(error) {


      context.agentStatus[agent.id] =
        "failed";



      const failedEvent: WorkflowEvent = {

        type: "failed",

        agent: agent.id,

        timestamp: Date.now(),

      };



      context.events.push(
        failedEvent
      );


      onEvent?.(
        failedEvent
      );



      context.logs.push({

        agent: agent.id,

        message: "Failed",

        timestamp: Date.now(),

      });



      throw error;


    }




    // ==========================
    // Planner
    // ==========================


    const plannerResult =
      handlePlanner(
        agent.id,
        parsed,
        plannerExecuted,
        currentStep
      );



    if (
      plannerResult.shouldContinue
    ) {


      plannerExecuted =
        plannerResult.plannerExecuted;



      dynamicPlan =
        plannerResult.dynamicPlan!;



      currentStep =
        plannerResult.currentStep;



      continue;

    }





    // ==========================
    // Evidence Check
    // ==========================


    const evidenceIssues =
      checkEvidence(
        context.evidence
      );



    if (
      evidenceIssues.length > 0
    ) {

      console.log(
        "Evidence Issues"
      );


      console.table(
        evidenceIssues
      );

    }





    // ==========================
    // Reviewer
    // ==========================


    if (
      agent.id === "reviewer"
    ) {


      const reviewerResult =
        handleReviewer(
          parsed,
          context,
          dynamicPlan,
          reviewCount,
          MAX_REVIEW
        );



      reviewCount =
        reviewerResult.reviewCount;



      if (
        reviewerResult.shouldBreak
      ) {

        break;

      }



      if (
        reviewerResult.shouldContinue
      ) {


        currentStep =
          reviewerResult.currentStep!;


        continue;


      }


    }



    currentStep++;


  }





  // ==========================
  // Final Output
  // ==========================


  context.finalOutput =
    context.outputs.writer ??
    context.outputs[
      dynamicPlan[
        dynamicPlan.length - 1
      ].agent
    ] ??
    null;






// ==========================
// Self Improvement Record
// ==========================

const reviewer =
  context.outputs.reviewer as any;

context.executionRecord = {

  id:
    crypto.randomUUID(),

  userInput,

  mode,

  agents:
    Object.keys(
      context.outputs
    ),

  outputs:
    context.outputs,

  quality:
    reviewer
      ? {
          score:
            reviewer.score ?? 0,

          issues:
            reviewer.issues ?? [],

          improvements:
            reviewer.improvements ?? [],
        }
      : undefined,

  duration:
    Date.now() -
    executionStartTime,

  success:
    true,

  failedAgents:
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
      ),

  reviewerAgent:
    reviewer
      ? "reviewer"
      : undefined,

  createdAt:
    Date.now(),

};

// ==========================
// Brain Analysis
// ==========================

const brainResult =
  analyzeExecution(context);

// ==========================
// Optimizer
// ==========================

const optimizerResult =
  optimizeExecution({
    ...context,
    executionRecord: {
      ...context.executionRecord!,
      quality: {
        score: brainResult.score,
        issues: brainResult.issues,
        improvements: brainResult.improvements,
      },
    },
  });

console.log("Optimizer Result");
console.log(optimizerResult);

// ==========================
// Brain Memory保存
// ==========================

if (
  optimizerResult.appliedRules.length > 0
) {

  saveBrainMemory(
    optimizerResult.appliedRules
  );

}


return context;
}