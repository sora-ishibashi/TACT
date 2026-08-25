// =========================
// TACT Orchestrator — Public Entry Point (Phase 1-15)
// =========================
//
// core/tact-research/index.ts・core/tact-design/index.tsと同じ構成
// (型/公開関数の一括re-export)。Phase 3でCommanderの実行関数
// runOrchestration()を追加した。decomposer.ts/executor.ts/
// aggregator.ts/taskContext.ts/memoryCandidateBuilder.ts/
// memoryPolicy.ts/concurrencyGovernor.ts/modelRouter.ts/
// ambiguityDetector.ts(Phase15)はrunOrchestration()の内部実装であり、
// 意図的にここから再exportしない(呼び出し元は常にrunOrchestration()
// という単一の入口だけを使う、絶対条件11)。memoryCandidate.ts
// (MemoryCandidate等)・memoryWriter.ts(MemoryWriteOutcome)は
// OrchestrationResult.memoryWritesの要素型として呼び出し元が参照する
// 必要があるため、型だけを公開する。ConcurrencyGovernorは
// OrchestrationResultの公開shapeに一切現れない(絶対条件: Governorが
// 判断した内容はTask実行結果そのものへ影響を与えるだけで、専用の
// 観測用フィールドをOrchestrationResultへ追加することはPhase 6の
// スコープ外)ため、型・関数のいずれも公開しない。
//
// Phase 11: episode.ts(Episode型・buildEpisode())を追加。
// runOrchestration()の内部実装ではなく、その入力(OrchestrationRequest)
// と出力(OrchestrationResult)を呼び出し元が事後的に束ねるための
// 独立したユーティリティのため、commander.tsからは呼び出さない
// (絶対条件: Commanderの構造を変更しない)。DB永続化は一切行わない
// (Phase 11では調査に基づき骨格のみ実装、詳細はPhase 11完了報告参照)。
//
// Phase 15: OrchestrationResult.clarification(ClarificationRequest型、
// types.tsで定義・export済み)を追加。ambiguityDetector.tsが「実行前に
// 停止すべき」と判定した場合のみ設定され、Task失敗とは明確に区別
// する(tasks=[]のまま、failed/cancelledなTaskExecutionSummaryは
// 一切生成しない)。
//
// 依存方向: core/tact-core・core/tact-intent・core/tact-bootstrap・
// core/tact-research(型のみ)・core/agent・core/llmに依存する。
// core/workflow・core/agents・core/planner・core/conversation
// (Legacy Workflow Engine)は一切importしない。

export * from "./types";
export * from "./task";
export type { MemoryCandidate, MemoryCandidateType, MemoryCandidateEvidence } from "./memoryCandidate";
export type { MemoryWriteOutcome } from "./memoryWriter";
export type { Episode, BuildEpisodeOptions } from "./episode";
export { buildEpisode } from "./episode";
// Phase 21: AnswerConfidence型のみを公開する(TaskExecutionSummary.
// answerConfidenceの型として呼び出し元が参照できるようにするため、
// ClarificationRequest型と同じ扱い)。deriveAnswerConfidence()自体は
// detectAmbiguity()と同じくexecutor.ts内部の実装であり、意図的に
// 再exportしない(絶対条件11、呼び出し元は常にrunOrchestration()
// またはTaskExecutionSummaryの値だけを見る)。
export type { AnswerConfidence } from "./confidence";
// Phase 27: buildEpisode()(Phase11)と同じ位置づけで公開する
// ——runOrchestration()の内部実装(detectAmbiguity()・
// deriveAnswerConfidence()のように実行過程で自動的に呼ばれるもの)
// ではなく、OrchestrationResult.tasksを受け取った呼び出し元が
// 事後的に利用するための独立したユーティリティ。Evaluation Signalを
// 「使う場所」(将来のReflection Layer)がまだ存在しないため
// (Phase25/26で確認済み)、Commander/Executorからは呼び出さない。
export type { LearningSignal, EvaluateTaskExecutionOptions } from "./evaluation";
export { evaluateTaskExecution } from "./evaluation";
export { runOrchestration } from "./commander";
