import { WorkflowContext } from "./types";

export function createContext(
  userInput: string,
  mode: "quick" | "think" | "deep" = "think"
): WorkflowContext {

  return {

    // =========================
    // User
    // =========================

    userInput,

    mode,

    // =========================
    // Agent Outputs
    // =========================

    outputs: {},

    stepOutputs: {},

    // 最終成果物
    finalOutput: null,

    // =========================
    // Reviewer Memory
    // =========================

    memory: {},

    // =========================
    // Shared Evidence
    // =========================

    evidence: [],

    // =========================
    // Workflow State
    // =========================

    agentStatus: {},

    reviewHistory: [],

    logs: [],

    events: [],

  };

}