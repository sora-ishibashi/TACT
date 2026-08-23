// =========================
// TACT Orchestrator — Public Entry Point (Phase 1-6)
// =========================
//
// core/tact-research/index.ts・core/tact-design/index.tsと同じ構成
// (型/公開関数の一括re-export)。Phase 3でCommanderの実行関数
// runOrchestration()を追加した。decomposer.ts/executor.ts/
// aggregator.ts/taskContext.ts/memoryCandidateBuilder.ts/
// memoryPolicy.ts/concurrencyGovernor.ts(Phase 6)はrunOrchestration()
// の内部実装であり、意図的にここから再exportしない(呼び出し元は常に
// runOrchestration()という単一の入口だけを使う、絶対条件11)。
// memoryCandidate.ts(MemoryCandidate等)・memoryWriter.ts
// (MemoryWriteOutcome)はOrchestrationResult.memoryWritesの要素型として
// 呼び出し元が参照する必要があるため、型だけを公開する。
// ConcurrencyGovernorはOrchestrationResultの公開shapeに一切現れない
// (絶対条件: Governorが判断した内容はTask実行結果そのものへ影響を
// 与えるだけで、専用の観測用フィールドをOrchestrationResultへ追加する
// ことはPhase 6のスコープ外)ため、型・関数のいずれも公開しない。
//
// 依存方向: core/tact-core・core/tact-intent・core/tact-bootstrap・
// core/tact-research(型のみ)・core/agent・core/llmに依存する。
// core/workflow・core/agents・core/planner・core/conversation
// (Legacy Workflow Engine)は一切importしない。

export * from "./types";
export * from "./task";
export type { MemoryCandidate, MemoryCandidateType, MemoryCandidateEvidence } from "./memoryCandidate";
export type { MemoryWriteOutcome } from "./memoryWriter";
export { runOrchestration } from "./commander";
