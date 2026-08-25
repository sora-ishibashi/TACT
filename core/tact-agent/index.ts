// =========================
// TACT Agent — Public Entry Point
// =========================
//
// core/tact-conversation/index.tsと同じbarrel export pattern。

export * from "./types";

export {
  registerAgent,
  getAgent,
  listAgents,
  updateAgentStatus,
  clearAgentRegistry,
  bootstrapDefaultAgents,
} from "./agentRegistry";

export { captureGitState } from "./gitState";

export {
  createDevelopmentTask,
  getCurrentAgentForTask,
} from "./taskManager";
export type { CreateDevelopmentTaskInput } from "./taskManager";

export {
  createHandoff,
  getCurrentHandoff,
  completeHandoff,
  resumeFromHandoff,
} from "./handoffManager";
export type {
  CreateHandoffInput,
  ResumeFromHandoffResult,
} from "./handoffManager";

export { getDevelopmentState } from "./developmentState";

export { createInMemoryAgentHandoffStore } from "./inMemoryStore";
export { createSupabaseAgentHandoffStore } from "./supabaseStore";
