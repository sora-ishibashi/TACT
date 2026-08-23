// =========================
// TACT Orchestrator — Task Abstraction (Phase 2)
// =========================
//
// 中核方針: 「AgentがTaskを持つのではなく、Taskに対してAgentを割り当てる」。
// Legacy Workflow(core/workflow/*)はAgent(core/agents/*、9種の固定
// Agent定義)を中心にWorkflowのstepを組み立てる構造だが、
// Orchestratorでは逆に、まずTask(やるべきことの単位)を中心に置き、
// 各Taskへ「どのAgent的役割で・どのProvider/Modelで・どのCapabilityで
// 実行するか」を後から割り当てる。これにより、Task分解の結果に応じて
// 動的にAgent数・種類を変えられる(固定9 Agentへ縛られない)。
//
// 既存の名前衝突についての事実確認(コード変更はしない、報告のみ):
//   - core/orchestrator.ts・core/planner.ts・core/executor.ts・
//     types/task.ts・types/workflow.ts・types/agent.ts・types/result.ts
//     という一群のファイルが既に存在するが、grep調査の結果
//     (app/・components/・core/のいずれからも一切importされていない)、
//     どこからも参照されない未使用の初期プロトタイプだと判明した
//     (types/task.tsのTaskStatusは"waiting"|"planning"|"running"|
//     "completed"で、本ファイルのTaskStatusとは値も別)。
//     CLAUDE.mdの既存方針により、これらを「バグ」として削除・修正
//     はしない。名前の衝突を避けるため、Orchestrator関連の新規実装は
//     既存の`core/tact-*`命名規則を踏襲した`core/tact-orchestrator/`
//     配下に置く(core/orchestrator.tsは一切変更しない)。

import type { Provider } from "../agent/types";
import type { LLMUsage, LLMCost } from "../llm/types";
import type { MemoryReference, ToolExecutionSummary } from "./types";

// =========================
// Task
// =========================

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {

  id: string;

  description: string;

  parentTaskId?: string;

  status: TaskStatus;

  // このTaskが完了する前に完了していなければならない、他Taskのid。
  // Phase 5(並列実行)で依存関係グラフを構築する材料になる
  // (STEP絶対条件10: critical path最小化が目的であり、Agent数の
  // 最大化ではない)。
  dependencies?: string[];

  // Taskごとに必要な最小限のContext(STEP絶対条件6: 全Agentに全
  // Conversation/全Memoryを渡さない)。Phase 1-2時点では構造だけを
  // 持ち、実際のMemory retrieval絞り込みロジックは実装しない。
  context?: unknown;

  // どのCapability(core/tact-core/capabilities/registry.tsに
  // registerCapability済みの名前、例: "research"/"design")で
  // このTaskを実行するか。省略時はOrchestrator内蔵のChat Handler的な
  // 単発LLM実行(core/tact-intent/chatHandler.tsと同じ位置づけ)を
  // 想定する。既存のCapability Registryをそのまま再利用し、
  // Orchestrator独自の新しいCapability分岐機構は作らない。
  assignedCapability?: string;

  assignedModel?: string;

  assignedProvider?: Provider;

}

// =========================
// Task Execution Summary
// =========================
//
// core/tact-orchestrator/types.tsのOrchestrationResult.tasksに載る、
// 1Task分の実行結果の要約。Taskそのもの(計画時点の情報)とは別に、
// 「実際に何が起きたか」を保持する(Task型に実行結果フィールドを
// 混在させない。core/context/types.tsのExecutionRecordが「実行前の
// 計画」と「実行後の記録」を1つの型に混在させ肥大化した反省を踏まえた
// 意図的な分離)。
export interface TaskExecutionSummary {

  taskId: string;

  status: TaskStatus;

  provider?: Provider;

  model?: string;

  capability?: string;

  usage?: LLMUsage;

  cost?: LLMCost;

  memoryUsed?: MemoryReference[];

  toolsUsed?: ToolExecutionSummary[];

  durationMs?: number;

  // STEP絶対条件13: 1 Agentが失敗しても、独立した他Agentまで失敗
  // 扱いにしない。errorはこのTask単体の失敗理由であり、他Taskの
  // TaskExecutionSummaryには影響しない。
  error?: string;

  // Phase 3で判明した不足フィールド: Phase 1-2設計時点では
  // TaskExecutionSummaryに「実際に生成された内容」を持たせていな
  // かったが、Aggregator(複数Taskの結果を1つのOrchestrationResult.answer
  // へ統合する責務)が各Taskの出力そのものを読めないと集約できない
  // ことが実装時に判明したため追加した。失敗/未実行(cancelled)の
  // 場合はundefinedのまま。
  output?: string;

  // Phase 5で判明した不足フィールド: Memory Candidate Builder
  // (memoryCandidateBuilder.ts)が「このResearch結果はCoreに既に
  // あった情報の再掲か、Web検索で得た新しい情報か」を区別する必要が
  // あるが、TaskExecutionSummaryにはResearchMetadata.executionMode
  // (core/tact-research/types.ts、"core-only"|"web-research")が
  // 反映されていなかった。research以外のTask、またはresult取得前は
  // undefinedのまま。
  researchExecutionMode?: "core-only" | "web-research";

  // 同じくPhase 5で追加。Research結果に紐づくEvidence件数
  // (ResearchResult.evidence.length)。根拠が無いAgent発言をMemoryへ
  // 昇格させない(絶対条件9)ための判定材料として使う。research以外の
  // Taskではundefinedのまま。
  evidenceCount?: number;

}
