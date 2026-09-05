// =========================
// TACT Work — Canonical Domain Types (Architecture Migration Phase B1)
// =========================
//
// ARCH-R2(Canonical Work Model Design)で確定した設計をそのまま型化
// する。Phase B1はFoundationのみであり、この型を使う実行経路
// (Work Router/advanceWork()等)はまだ存在しない
// (core/tact-orchestrator/commander.tsのrunOrchestration()は一切
// 参照しない)。
//
// 依存方向についての補足: このファイルはcore/agent/types.ts
// (Provider)・core/llm/types.ts(LLMCost)・core/tact-orchestrator/
// types.ts(CapabilityInvocationResult、Phase Aで新設)を型のみ
// import する。core/tact-orchestrator側からこのモジュールへの
// import は無い(新しい一方向の依存であり、循環参照にはならない。
// Phase AでCapability Adapterがcore/tact-orchestrator/types.tsを
// 型のみimportしたのと同じ「共通語彙を再利用する消費者」パターン)。
//
// core/tact-orchestrator/task.ts の既存Task(runtime memoryのみ)との
// 関係: このファイルのWorkTask/Runは、その永続化版として設計されて
// いるが、既存Taskを破壊的に変更しない(Phase B1絶対条件)。将来
// 統合できる形を優先しつつ、今回は独立した型として定義する
// (assignedProvider/assignedModelを持たない・TaskExecutionSummaryの
// 実行結果フィールドはRunへ再配置、というARCH-R2の設計をそのまま
// 反映)。

import type { Provider } from "../agent/types";
import type { LLMCost } from "../llm/types";
import type { CapabilityInvocationResult } from "../tact-orchestrator/types";

// =========================
// Actor Reference (ARCH-R2 Section9)
// =========================
//
// 独立したtact_actorsテーブルは作らない(Actorごとに大量の行を
// 生成する必要が無いため)。型付き参照だけをWork/Approvalへ埋め込む。
// kind="user"のidは常にauth.users.id(server側で解決済みの値。
// BOT-P2.5で確立した「外部Channel userの主張を直接信用しない」
// 絶対条件をそのまま継承する——このモジュール自体は解決ロジックを
// 持たず、呼び出し元が既に解決済みの値を渡すことを前提にする)。

export type ActorKind = "user" | "bot" | "system" | "ai";

// supabase/migrations/20260905000000_create_tact_work_tables.sqlの
// CHECK制約と同じ4値を実行時に列挙する(型だけでなく、値の集合として
// も参照・検証できるようにするため。テスト
// (tests/tact/work/types.test.ts)がこの配列とmigrationのCHECK制約が
// 一致していることを保証する)。
export const ACTOR_KINDS: readonly ActorKind[] = ["user", "bot", "system", "ai"];

export interface ActorReference {

  kind: ActorKind;

  id: string;

}

// =========================
// Work
// =========================
//
// Work = 「TACTが完了まで責任を持つ仕事」。Conversationとは完全に
// 独立したEntity(Work.id ≠ Conversation.id、ARCH-R2最重要原則)。

export type WorkStatus =
  | "created"
  | "planning"
  | "running"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export const WORK_STATUSES: readonly WorkStatus[] = [
  "created",
  "planning",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
];

// Run.costの集約キャッシュ(Source of TruthはRun.cost、ARCH-R2
// Section16)。Phase B1ではどのコードも書き込まない(型のみ先行定義)。
export interface WorkCostSummary {

  totalEstimatedUSD?: number;

  totalTokens?: number;

}

export interface Work {

  id: string;

  userId: string;

  // 予約フィールド。Organization機能は未実装(tact_core_knowledge等と
  // 同じ「列だけ確保しておく」既存パターン)。
  organizationId?: string | null;

  createdByActorKind: ActorKind;

  createdByActorId: string;

  title?: string | null;

  objective?: string | null;

  status: WorkStatus;

  primaryConversationId?: string | null;

  startedAt?: string | null;

  completedAt?: string | null;

  failedAt?: string | null;

  cancelledAt?: string | null;

  costSummary?: WorkCostSummary | null;

  metadata?: Record<string, unknown> | null;

  createdAt: string;

  updatedAt: string;

}

// =========================
// WorkTask
// =========================
//
// core/tact-orchestrator/task.tsのTask(runtime memoryのみ)の永続化版。
// 意図的に別名にする(既存Taskとの無用な衝突を避け、将来の統合可否を
// 型レベルで急がない、Phase B1絶対条件)。
//
// assignedProvider/assignedModelは持たない——実際に使用された
// Provider/ModelはRunの責務(ARCH-R2 Section4、Retryごとに変わり
// うる実行時の事実であり、計画時点の属性ではないため)。

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];

export interface WorkTaskTableSchema {

  columns: string[];

  requestedRowCount?: number;

}

export interface WorkTask {

  id: string;

  workId: string;

  parentTaskId?: string | null;

  description: string;

  status: TaskStatus;

  assignedCapability?: string | null;

  tableSchema?: WorkTaskTableSchema | null;

  createdAt: string;

  updatedAt: string;

}

// =========================
// Task Dependency
// =========================
//
// core/tact-orchestrator/task.tsのTask.dependencies(string[])を、
// 配列FKではなく正規化されたrelationとして表現する。

export interface TaskDependency {

  taskId: string;

  dependsOnTaskId: string;

  createdAt: string;

}

// =========================
// Run
// =========================
//
// Run = 「あるTaskを、あるCapability/Provider/Model構成で一度実行
// したattempt」。Task 1 → N Run(Retryごとに新しいRun)。

export type RunStatus = "running" | "completed" | "failed";

export const RUN_STATUSES: readonly RunStatus[] = [
  "running",
  "completed",
  "failed",
];

export interface Run {

  id: string;

  workId: string;

  taskId: string;

  attempt: number;

  capability: string;

  provider?: Provider | null;

  model?: string | null;

  status: RunStatus;

  startedAt: string;

  completedAt?: string | null;

  error?: string | null;

  // core/llm/types.tsの既存LLMCost({tokens, estimatedUSD})をそのまま
  // 再利用する(新しいcost概念を増やさない、ARCH-R2 Section16)。
  // 計測できないCapability(Search/API等)ではundefinedのまま
  // (0として記録しない)。
  cost?: LLMCost | null;

  // Provider固有ID(将来のn8n execution id等)。WorkやWorkTaskへは
  // 一切持たせず、Runにのみ保持する(ARCH-R2 Section14)。
  externalRef?: Record<string, unknown> | null;

  // Phase A(core/tact-orchestrator/types.ts)で確立した
  // CapabilityInvocationResultの語彙をそのまま再利用する
  // (新しいResult概念を増やさない)。
  result?: CapabilityInvocationResult | null;

  createdAt: string;

}

// =========================
// Approval
// =========================
//
// Approval = 「あるWork/Task/Actionを続行するための人間判断」。
// Phase B1ではApproval workflow自体(判断ロジック・resume)は実装
// しない——DB・型・Storeのみ。

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired";

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "expired",
];

export interface Approval {

  id: string;

  workId: string;

  taskId?: string | null;

  requestedByActorKind: ActorKind;

  requestedByActorId: string;

  requestedFromActorKind: ActorKind;

  requestedFromActorId: string;

  status: ApprovalStatus;

  reason: string;

  payload: Record<string, unknown>;

  requestedAt: string;

  respondedAt?: string | null;

  response?: string | null;

  expiresAt?: string | null;

  createdAt: string;

}
