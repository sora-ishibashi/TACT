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

// SOR-45: sourceType(webhook/poll/manual_report/sdk_callback/runtime_dispatch)
// とは別の軸。sourceTypeは「どういうtransportでこのeventが届いたか」を
// 表すのに対し、observationModeは「TACTの観測が、実際のprovider側action
// に対してどういう時間的/因果的関係にあるか」を表す——同じsourceTypeでも
// observationModeが異なりうる(例: 将来webhookでも準リアルタイムに
// instrumentedな観測を行う経路がありえる)ため、意図的に独立させる。
//   - "inline": TACT自身がaction dispatchの経路上にあり、実行と同期的に
//     観測する(現時点でこのmodeを使うadapterは無い、将来のruntime
//     dispatch経路向けの契約枠)。
//   - "instrumented": TACTのコードが実際のprovider呼び出しを明示的に
//     wrapして観測する(例: core/tact-execution/adapters/notion/
//     observeNotionMcpExecution.tsのexecuteWithNotionMcpObservation()。
//     ただし現在の実装はexecuteTool()完了後にのみcaptureする——
//     wrap=instrumentedであることと、preExecutionVisible(下記)が
//     trueであることは独立した事実である)。
//   - "reconciled": provider側で既に完結したactionを、TACTが事後的に
//     (webhook通知・poll等で)発見・記録する(例: Slack webhook経由の
//     normalizeSlackExecutionEvent.ts、現状core/tact-bot側の本番配線は
//     未接続だがadapter自体はこのmodeで正しい)。
// 既存行(この契約導入以前にcaptureされた行)の真のmodeは推測できない
// ため、column自体をnullableとし、null="この契約導入前、または
// 呼び出し元が未分類"を意味する(絶対条件、Unknownな値を推測で埋めない)。
export type ExecutionObservationMode = "inline" | "instrumented" | "reconciled";

export const EXECUTION_OBSERVATION_MODES: readonly ExecutionObservationMode[] = [
  "inline",
  "instrumented",
  "reconciled",
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

  // SOR-45: このrowが記録された時点でのCanonicalExecution契約のバージョン。
  // captureExecution()が常に1を書き込む(呼び出し元から指定不可、
  // 「このstore層が保証する契約の版数」であり、adapter固有の
  // adapterVersionとは意味が異なる)。将来v2が必要になった場合も、
  // 既存v1行は変更せずschemaVersion=1のまま残す(destructive migration
  // 禁止)。
  schemaVersion: number;

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

  // SOR-45: 上記ExecutionObservationMode参照。既存契約導入前の行は null。
  observationMode: ExecutionObservationMode | null;

  // SOR-45: このExecution行が、provider側actionの実際の完了より前に
  // 作成された(=事前に可視だった)かどうか。現時点では、この値を
  // trueにするadapterは一つも無い(instrumentedなNotion MCP経路も
  // executeTool()完了後にのみcaptureする、observeNotionMcpExecution.ts
  // 参照)——将来、真にinlineなruntime dispatch経路が実装された際に
  // trueを設定する契約枠として追加する。observationModeから機械的に
  // 導出できる値ではない(instrumentedでも今日はfalseになりうる)ため、
  // 独立したfieldとして持つ。
  preExecutionVisible: boolean;

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

  // SOR-45: 省略時はnull(未分類)。schemaVersionはここに含めない——
  // captureExecution()がstore層の契約として常に自分で1を書き込む
  // (adapterが指定できる値ではない)。
  observationMode?: ExecutionObservationMode | null;

  // SOR-45: 省略時はfalse(現在の全adapterの実態と一致、上記コメント
  // 参照)。
  preExecutionVisible?: boolean;

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
