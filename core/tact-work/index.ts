// =========================
// TACT Work — Public Entry Point
// (Architecture Migration Phase B1: Schema/Types/Store,
//  Phase B2: Work Intake / Work Execution Boundary)
// =========================
//
// 依存方向: core/tact-work/はcore/tact-orchestrator(commander.ts経由
// のrunOrchestration()、およびPhase A/B2で追加したOrchestrationHooks/
// CapabilityInvocationResult等の型)へ依存する(execution.ts)。
// core/tact-orchestrator側からcore/tact-workへの参照は一切無い
// (一方向依存、Phase Aで確立した「共通語彙の消費者」パターンの
// 延長)。core/tact-conversation・core/tact-bot・Legacy Workflow
// Engine(core/workflow・core/agents・core/planner・core/conversation)
// へは一切依存しない——Conversation側がcore/tact-workをimportして
// 利用する(逆方向)。
//
// Phase B2時点でこのモジュールを実際に利用するのは
// core/tact-conversation/orchestration.ts(runNormalTurn()/
// runClarificationAnswerTurn())のみ。

export * from "./types";
export * from "./store";
export * from "./intake";
export * from "./execution";
export * from "./delegatedIntent";
export * from "./delegatedCompletion";
export * from "./gmailReplyProposal";
export * from "./approval";
export * from "./approvalIntegrity";
// Fast Port P3a: Human Interaction Foundation(Clarification)。
// core/tact-work/approval.tsと同じ二層構造(store.tsの生CRUD +
// このExecution Boundary)を持つため、同じbarrelから公開する。
export * from "./clarification";
// Fast Port P4a: Append-Only Audit Event Foundation。同じbarrel
// export pattern。
export * from "./audit";
// Fast Port P6a: Task Resume Foundation。同じbarrel export pattern。
export * from "./resume";
// REF-P1f: Gmail Referent Candidate Generation。同じbarrel export
// pattern(core/tact-integration/core/tact-referent間の変換層)。
export * from "./gmailReferentCandidates";
// APPROVAL-P2: Canonical Execution Preview。同じbarrel export
// pattern。gmailExecutionPreview.ts/slackExecutionPreview.tsの
// Provider固有builder関数はここでは意図的にexportしない
// (executionPreview.tsの内部実装のみ——barrelを通じて呼び出し元へ
// 直接晒さない)。呼び出し元は常にbuildExecutionPreview()/
// buildExecutionPreviewFromApprovalPayload()というservice非依存の
// 入口だけを使う。
export * from "./executionPreview";
export * from "./temporal";
export * from "./temporalRequirements";
