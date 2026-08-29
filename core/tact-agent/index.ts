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

// Phase104: Claude Code → Codex Handoffの実接続。
export {
  classifyAgentContinuation,
  evaluateHandoffTrigger,
} from "./handoffTrigger";
export type {
  AgentContinuationStatus,
  AgentExecutionOutcome,
  HandoffTriggerDecision,
} from "./handoffTrigger";

export { runClaudeToCodexHandoff } from "./claudeToCodexHandoff";
export type {
  ClaudeToCodexHandoffInput,
  ClaudeToCodexHandoffResult,
} from "./claudeToCodexHandoff";

export {
  resumeLatestHandoffForTask,
  buildAgentResumeInstruction,
  buildCodexResumeInstruction,
} from "./codexResume";

// Phase111: Agent選択層 / 汎用Handoff / Orchestrator入口。
export { selectCodingAgent } from "./agentSelection";
export type {
  SelectCodingAgentInput,
  SelectCodingAgentResult,
} from "./agentSelection";

export { runAgentHandoff } from "./agentHandoffRunner";
export type {
  RunAgentHandoffInput,
  RunAgentHandoffResult,
} from "./agentHandoffRunner";

export { runCodingTask } from "./codingTaskRunner";
export type {
  RunCodingTaskInput,
  RunCodingTaskResult,
  RunCodingTaskAttempt,
  RunCodingTaskStatus,
  RunCodingTaskDeps,
  CodingTaskExecutionLogEvent,
} from "./codingTaskRunner";

// Phase113: Report Builder(実行結果からMarkdown報告を機械的に生成)。
export {
  buildCodingTaskReportSummary,
  buildCodingTaskReportMarkdown,
  extractCodexRuntimeInfo,
} from "./codingTaskReport";
export type {
  CodingTaskReportInput,
  CodingTaskReportSummary,
  AgentRuntimeInfo,
  ExtractedCodexRuntimeInfo,
} from "./codingTaskReport";

// Phase116: Verification Pipeline(tsc/eslint/npm test/npm run buildを
// 実際に実行し、既存VerificationStatus型へ実測結果を格納する)。
export { runVerification } from "./verificationRunner";
export type { VerificationMode, RunVerificationOptions } from "./verificationRunner";
