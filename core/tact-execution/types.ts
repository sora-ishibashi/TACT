// =========================
// TACT Canonical Execution — Domain Types (SOR-50)
// =========================
//
// Repository Reality調査で確認した既存概念との区別(重要):
//   core/tact-work/types.ts の Run/AuditEvent はいずれも
//   work_id/(Runはtask_idも)NOT NULLで、TACT自身がTask/Capabilityを
//   実行した記録である。core/tact-execution はこれらとは独立した、
//   TACT外部(AI Agent / SaaS / Connector等)で発生した実行を
//   work_id未確定のまま観測・記録するための新domainである。
//   両者を混同しない(supabase/migrations/
//   20261020000000_create_tact_canonical_executions.sql冒頭コメント
//   参照)。
//
// core/tact-work.ActorKind(user/bot/system/ai)とは独立した、この
// domain専用のActor語彙(human/ai_agent/service/connector/system)を
// 定義する——既存ActorKindの4値をSOR-50の要求(5分類)に合わせて
// 無断拡張しない、というCLAUDE.md A章の原則に従う。

import type { JsonValue } from "../tact-work/approvalIntegrity";

export type ExecutionActorKind = "human" | "ai_agent" | "service" | "connector" | "system";

export const EXECUTION_ACTOR_KINDS: readonly ExecutionActorKind[] = [
  "human",
  "ai_agent",
  "service",
  "connector",
  "system",
];

// supabase/migrations/20261020000000...sqlのprovider CHECK制約と同じ
// 値集合。新providerの追加は、このunionへの追加 + 対応するCHECK制約の
// 追加migration(既存tact_connections.serviceと同じ1行追加パターン)
// のみで行う(上位Runs domainのロジックコードは書き換えない)。
export type ExecutionProvider =
  | "openai"
  | "anthropic"
  | "mcp"
  | "slack"
  | "gmail"
  | "google_calendar"
  | "notion"
  | "microsoft365"
  | "salesforce"
  | "custom";

export const EXECUTION_PROVIDERS: readonly ExecutionProvider[] = [
  "openai",
  "anthropic",
  "mcp",
  "slack",
  "gmail",
  "google_calendar",
  "notion",
  "microsoft365",
  "salesforce",
  "custom",
];

export type ExecutionSourceType = "webhook" | "poll" | "manual_report" | "sdk_callback" | "runtime_dispatch";

export const EXECUTION_SOURCE_TYPES: readonly ExecutionSourceType[] = [
  "webhook",
  "poll",
  "manual_report",
  "sdk_callback",
  "runtime_dispatch",
];

export type ExecutionActionCategory =
  | "read"
  | "create"
  | "update"
  | "send"
  | "delete"
  | "share"
  | "execute"
  | "approve"
  | "unknown";

export const EXECUTION_ACTION_CATEGORIES: readonly ExecutionActionCategory[] = [
  "read",
  "create",
  "update",
  "send",
  "delete",
  "share",
  "execute",
  "approve",
  "unknown",
];

export type ExecutionStatus = "observed" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "observed",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
];

// SOR-51 M-0(Notion Permission Registry): "approval_required"はdenied
// でもallowedでもない、独立した3番目の非終端状態(人間承認が必要と
// registered permissionが定義している)。deniedへ丸めない(絶対条件、
// core/tact-execution/permission/types.tsのPermissionDecisionStatus
// コメント参照)。
export type ExecutionPermissionStatus = "pending" | "allowed" | "denied" | "unknown" | "approval_required";

export const EXECUTION_PERMISSION_STATUSES: readonly ExecutionPermissionStatus[] = [
  "pending",
  "allowed",
  "denied",
  "unknown",
  "approval_required",
];

// SOR-52: Work Correlationの要約状態。"pending"はまだ相関を試みていない
// (tact_execution_work_correlationsに1件も履歴が無い)ことを表す不在の
// 状態であり、実際に試行された結果ではない(SOR-51のExecutionPermission
// Statusと同じ設計)。
export type ExecutionCorrelationStatus = "pending" | "matched" | "ambiguous" | "unresolved";

export const EXECUTION_CORRELATION_STATUSES: readonly ExecutionCorrelationStatus[] = [
  "pending",
  "matched",
  "ambiguous",
  "unresolved",
];

export interface ExecutionActorReference {

  kind: ExecutionActorKind;

  id: string | null;

}

// =========================
// CanonicalExecution (persisted domain type)
// =========================

export interface CanonicalExecution {

  id: string;

  // ---- Identity ----

  userId: string;

  organizationId: string | null;

  workspaceId: string | null;

  workId: string | null;

  // SOR-52: work_id単体では表現できない状態("試みたが決められなかった"
  // 等)を表す要約列。source of truth(履歴)は
  // core/tact-execution/correlation/store.tsのtact_execution_work_
  // correlations。
  correlationStatus: ExecutionCorrelationStatus;

  connectionId: string | null;

  // ---- Actor ----

  actorKind: ExecutionActorKind;

  actorId: string | null;

  agentId: string | null;

  onBehalfOfActorKind: ExecutionActorKind | null;

  onBehalfOfActorId: string | null;

  // ---- Source / Provenance ----

  provider: ExecutionProvider;

  sourceType: ExecutionSourceType;

  externalEventId: string;

  adapterVersion: string;

  sourceMetadata: JsonValue | null;

  rawPayloadRef: string | null;

  // ---- Action ----

  actionCategory: ExecutionActionCategory;

  operation: string;

  resourceType: string | null;

  resourceIdentifier: string | null;

  targetProvider: ExecutionProvider | null;

  // ---- Status ----

  status: ExecutionStatus;

  errorCode: string | null;

  errorMessage: string | null;

  // ---- Permission Context ----

  permissionStatus: ExecutionPermissionStatus;

  permissionReasonCode: string | null;

  permissionEvaluatedAt: string | null;

  // ---- Time ----

  providerOccurredAt: string | null;

  observedAt: string;

  persistedAt: string;

  updatedAt: string;

}

// =========================
// CaptureExecutionInput (Adapter → Validation → Persistenceの境界を
// 越える、検証済み入力DTO)
// =========================
//
// core/tact-work/store.tsの既存規約(絶対条件: 任意のpatch objectで
// 無関係なfieldまで動かせてしまう経路を作らない)にならい、汎用patch
// objectではなく、captureExecution()専用の単一目的入力型として
// 定義する。

export interface CaptureExecutionInput {

  userId: string;

  organizationId?: string | null;

  workspaceId?: string | null;

  workId?: string | null;

  connectionId?: string | null;

  actorKind: ExecutionActorKind;

  actorId?: string | null;

  agentId?: string | null;

  onBehalfOfActorKind?: ExecutionActorKind | null;

  onBehalfOfActorId?: string | null;

  provider: ExecutionProvider;

  sourceType: ExecutionSourceType;

  externalEventId: string;

  adapterVersion: string;

  sourceMetadata?: JsonValue | null;

  rawPayloadRef?: string | null;

  actionCategory: ExecutionActionCategory;

  operation: string;

  resourceType?: string | null;

  resourceIdentifier?: string | null;

  targetProvider?: ExecutionProvider | null;

  status?: ExecutionStatus;

  errorCode?: string | null;

  errorMessage?: string | null;

  permissionStatus?: ExecutionPermissionStatus;

  providerOccurredAt?: string | null;

  // 省略時はAdapter呼び出し時点(now())を使う(store.ts側で補う)。
  observedAt?: string;

}

export type { JsonValue };
