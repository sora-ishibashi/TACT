// =========================
// TACT Conversation — Public Entry Point (Phase 65)
// =========================
//
// core/tact-conversation/配下の型・永続化関数を一括で参照できるように
// する入口(core/tact-core/index.tsのbarrel export patternをそのまま
// 踏襲)。
//
// 依存方向の確認(Phase61〜65の絶対条件): このファイル、および
// core/tact-conversation/配下のどのファイルも、core/workflow・
// core/agents・core/conversation(Legacy/Frozen)を一切importしていない。
// API Route・UI Component・Orchestrator・Research/Chat/Core Capabilityへの
// 接続はPhase66以降で行う(Phase65時点では未接続)。

export * from "./types";
export {
  createConversation,
  getConversation,
  listConversations,
  getConversationMessages,
  appendConversationMessage,
  appendConversationMessageWithAttachments,
  recordClarificationQuestion,
  recordClarificationAnswer,
  getPendingClarification,
  clearPendingClarification,
  recordExecution,
  saveConversation,
  isClarificationQuestionMessage,
  linkConversationArtifact,
} from "./store";
export {
  runConversationOrchestration,
  planConversationTurn,
  mapOrchestrationTasksToExecutionStatus,
  deriveExecutionCapability,
  buildClarificationResendInput,
  findPrecedingUserInput,
} from "./orchestration";
export type {
  ConversationTurnResult,
  ConversationOrchestrationPlan,
} from "./orchestration";
// Phase75: Artifact Mutation判定・本文構築の純粋関数群(DB/Orchestrator
// 呼び出しなし)。core/tact-conversation/orchestration.tsへの実結線は
// migration承認後(artifactMutation.ts冒頭コメント参照)。
export {
  detectArtifactMutationIntent,
  deriveArtifactTitle,
  buildArtifactSectionContent,
  appendArtifactContent,
  buildArtifactMutationConfirmation,
} from "./artifactMutation";
