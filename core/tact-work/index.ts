// =========================
// TACT Work — Public Entry Point (Architecture Migration Phase B1)
// =========================
//
// 依存方向の確認: このファイル、およびcore/tact-work/配下のどの
// ファイルも、core/tact-orchestrator/commander.ts・core/tact-conversation・
// core/tact-bot・Legacy Workflow Engine(core/workflow・core/agents・
// core/planner・core/conversation)を一切importしていない。
// core/tact-orchestrator/types.ts(CapabilityInvocationResult)のみを
// 型として参照する(Phase Aで確立した「共通語彙の消費者」パターン、
// store.tsのコメント参照)。
//
// Phase B1時点では、このモジュールをimportして実際にWork/Task/Run/
// Approvalを読み書きする呼び出し元はまだ存在しない(Foundationのみ)。

export * from "./types";
export * from "./store";
