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
// 依存方向についての補足: このファイルはcore/llm/types.ts(LLMCost)・
// core/tact-orchestrator/types.ts(CapabilityInvocationResult、
// Phase Aで新設)を型のみimportする。core/tact-orchestrator側から
// このモジュールへの
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

import type { LLMCost } from "../llm/types";
import type { CapabilityInvocationResult } from "../tact-orchestrator/types";
// Fast Port P4a: AuditEvent.detailsのために、既存のJsonValue定義
// (core/tact-work/approvalIntegrity.ts、ARCH-P1aで確立済み)を
// そのまま再利用する(同一module内なので新しい定義を複製しない
// ——cross-module境界(core/tact-work ↔ core/tact-integration)を
// 越える再宣言パターンとは異なる、同一module内の通常のimport)。
// approvalIntegrity.ts自身はこのfileを一切importしていないため、
// 循環依存にはならない。
import type { JsonValue } from "./approvalIntegrity";

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

  // Architecture Migration Phase C1: capability(既にstring、Capability
  // Registryの登録名を自由文字列で持つ)と対称に、providerも自由
  // 文字列へ拡張した(以前はLLM専用のProvider型("openai"|"gemini"|
  // "claude")に限定されていた)。Runは元々LLMベースのCapability
  // attemptだけでなく、Integration Gateway(core/tact-integration/)
  // 経由のexternal Tool実行attempt(例: "composio")も表す汎用概念で
  // あり、LLM Provider限定の型では表現できなかった。既存のLLM
  // Provider値("openai"等)はstringのsubsetとしてそのまま有効
  // (後方互換、型を緩めただけで意味・既存値は一切変更していない)。
  provider?: string | null;

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

  // Fast Port P3b(Human Interaction Foundation拡張、HumanLayer ACP
  // AllowedResponderIDs pattern)。core/tact-work/types.tsの
  // Clarification.allowedResponderIdsと同じ設計・同じ既定値意味論を
  // 持つ: undefined/null/空配列 = canonical owner-only(既定、Work
  // ownership経由のgetApproval()が既に構造的に強制する)。non-empty
  // 配列 = 明示allowlist(tactUserIdのみを格納する想定、外部Provider
  // idを直接書き込まない)。P3b時点でこれを実際に設定するproducerは
  // 存在しないため、Clarificationの同fieldと同じくfoundationのみ
  // (型・checkApproverAllowed()のロジックは実装するが、未populateの
  // 間は常にno-op)。
  allowedApproverIds?: string[] | null;

  status: ApprovalStatus;

  reason: string;

  payload: Record<string, unknown>;

  requestedAt: string;

  respondedAt?: string | null;

  response?: string | null;

  expiresAt?: string | null;

  createdAt: string;

  // =========================
  // Approval Integrity (Architecture Migration ARCH-P1a)
  // =========================
  //
  // supabase/migrations/20260909000000_add_tact_approvals_integrity_fields.sql
  // で追加したnullable列にそのまま対応する。ARCH-P1a時点では
  // core/tact-work/approval.tsのrequestApproval()がこれらを一切
  // 書き込まないため、既存の全Approvalはundefined/nullのまま
  // (capture wiringはARCH-P1bのscope)。型・行mappingだけを先行して
  // 用意する目的で追加する——執行時verification(ARCH-P1c)は
  // まだ存在しない。
  //
  // subjectVersion/subject/subjectHashの正式な形は
  // core/tact-work/approvalIntegrity.tsのApprovalSubject/
  // APPROVAL_SUBJECT_VERSIONを参照。subjectVersionは検索用に
  // 非正規化された値であり、真のsource of truthは常にsubject内部の
  // 同名フィールド(approvalIntegrity.ts参照)。

  subjectVersion?: number | null;

  subject?: Record<string, unknown> | null;

  subjectHash?: string | null;

  subjectCapturedAt?: string | null;

}

// =========================
// Clarification (Fast Port P3a: Human Interaction Foundation)
// =========================
//
// docs/architecture/p2-p5-final-architecture.md Section9-14で確定した
// 方針をそのまま実装する: ApprovalをgenericなHumanInteraction entityへ
// 統合しない(ARCH-P1で本番実証済みのApproval table/status/integrityは
// 一切変更しない)。Clarificationは、Approvalと並列に扱える、別の
// canonical entityとして独立に追加する——「HumanInteraction base +
// Approval特殊化」ではなく「別entity、共通のfield命名規約(kind+id
// actor pair、requestedAt/respondedAt等)を共有するだけ」という設計
// (Approval/Clarification共通interfaceは強制しない、無理な抽象化を
// 増やさない)。
//
// Prior Art(ADAPT_AND_BORROW、source codeはコピーせずpatternだけ移植):
//   - HumanLayer ACP: async human call / AllowedResponderIDs /
//     correlation / wait-resolve分離
//   - AXME: human task abstractionとしてのClarification(独立
//     interaction type)、intent/state分離、response correlation
//   - BoundFlow: gate resolution ≠ engine resume(resolved gateは
//     「再開可能になった」だけであり、実際の再開は別の呼び出し)
//
// 絶対条件(Fast Port P3a指示): approved/rejectedという語彙は不要
// (Authorization判断ではなく、安全な実行に必要な情報が不足している
// だけ)。Clarification resolved ≠ execution resumed——resolveされた
// 後、Task/Workは「再開可能」になるだけで、実際の再開は次のOrchestration
// /Execution Turnが行う(このモジュール自身は一切Providerを呼ばない、
// 絶対条件14)。

export type ClarificationStatus = "pending" | "answered" | "cancelled" | "expired";

export const CLARIFICATION_STATUSES: readonly ClarificationStatus[] = [
  "pending",
  "answered",
  "cancelled",
  "expired",
];

// stable machine-readable reason(将来のARCH-P4 Audit Eventでもそのまま
// 使える形を意識する、core/tact-integration/policy.tsのPolicyReasonCode
// と同じ設計方針)。絶対条件(Fast Port P3a指示Step4): 現在producerが
// 無いreasonCodeを大量に先取り登録しない——P3a時点の唯一の実用途
// (P2bのpolicyDecision==="require_input"経路)に対応する1値のみ登録する。
export type ClarificationReasonCode = "missing_required_input";

export const CLARIFICATION_REASON_CODES: readonly ClarificationReasonCode[] = [
  "missing_required_input",
];

export interface Clarification {

  id: string;

  workId: string;

  taskId?: string | null;

  // 質問を発した主体(通常はCapability自身、Approvalのrequested
  // ByActorと同じ表現規約——AI/Capability中心ではなく、ActorReference
  // という共通語彙をそのまま再利用する)。
  requestedByActorKind: ActorKind;

  requestedByActorId: string;

  // HumanLayer ACPのAllowedResponderIDs pattern(ADAPT_AND_BORROW)。
  // undefined/null = canonical owner-only(既定。Work.user_idが暗黙の
  // 唯一のresponder候補——既存のWork-ownership check、
  // getClarification()のWorkOwnershipDepsが既にこれを構造的に強制
  // する)。non-empty配列 = 明示allowlist(tactUserIdのみを格納する
  // 想定。絶対条件10: 外部Provider由来のraw actor id(Slack user id等)
  // をこの配列へ直接書き込まない——Bot/Adapter層が既に解決済みの
  // canonical tactUserIdだけを渡す)。
  allowedResponderIds?: string[] | null;

  status: ClarificationStatus;

  reasonCode: ClarificationReasonCode;

  // human-readable質問文。P3a時点ではfree-text stringのみ
  // (structured selection等はP3c以降、絶対条件Step12: JSON-anyのような
  // 広すぎるpayloadを今回持ち込まない)。
  question: string;

  // human-provided回答(free-text string)。LLMが生成・判定した値では
  // ない——resolveClarification()の呼び出し元(Bot/Web等)が人間から
  // 受け取った生のtextをそのまま渡す(絶対条件9)。
  response?: string | null;

  // 実際に応答したactor(Approvalには無い、Clarification固有の
  // 追加trace——「誰が承認したか」を記録しないApprovalの現行schemaを
  // 変更する代わりに、新規entityであるClarificationでは最初から
  // 記録する設計とした)。
  respondedByActorKind?: ActorKind | null;

  respondedByActorId?: string | null;

  requestedAt: string;

  respondedAt?: string | null;

  expiresAt?: string | null;

  createdAt: string;

}

// =========================
// AuditEvent (Fast Port P4a: Append-Only Audit Event Foundation)
// =========================
//
// docs/architecture/p2-p5-final-architecture.md Section15-20で確定した
// 設計をそのまま実装する。TACTには既にWork/Task/Run/Approval/
// Clarificationという「現在状態を持つ」canonical entityがある——
// このfileはそれとは独立した「何が・いつ・誰によって起きたか」を残す
// append-only canonical evidenceを追加する(絶対条件3、Step5):
//
//   tact_runs.status = 'failed'        … current canonical state
//   AuditEvent{eventType:'run.failed'} … 「failed eventが発生した」
//                                          というfactの記録
//
// このtableからcurrent stateを再構築するEvent Sourcingは行わない
// (TACTはEvent Sourced systemではない)。Auditは補助的canonical
// evidenceであり、Authorization Layerでもない(絶対条件1)。
//
// Prior Art(ADAPT_AND_BORROW、source codeはコピーしない):
//   - BoundFlow: audit_events table(tenant/workflow/request/
//     event_type/actor/occurred_at/details jsonb)、current-state
//     tableとは別のevent stream
//   - AXME: monotonic sequence(seq)によるdeterministic ordering、
//     lifecycle event representation
//
// P4a時点でこのtableへ実際にemitするproduction pathは存在しない
// (event emission wiringはP4bのscope、絶対条件14)。

// Fast Port P4a Step3: P2-P5 Final Architecture Synthesisで確定した
// 「1 table + category(discriminating field)」方針(BoundFlow/Glean
// の admin-config vs execution-activity という二軸を、物理テーブル
// 分割ではなくこの1列で表現する)。P4a時点でproducerが無いカテゴリ
// (例: runtime、P5 Runtime Adapterが実在するまで)を先回りして
// 登録しない。
export type AuditEventCategory =
  | "work"
  | "task"
  | "policy"
  | "human_interaction"
  | "approval"
  | "clarification"
  | "execution"
  | "provider"
  | "context";

export const AUDIT_EVENT_CATEGORIES: readonly AuditEventCategory[] = [
  "work",
  "task",
  "policy",
  "human_interaction",
  "approval",
  "clarification",
  "execution",
  "provider",
  "context",
];

// Fast Port P4a Step4: stable machine-readable値。P4a時点では誰も
// このtableへemitしないため型としてのfoundationにとどめる
// (過剰taxonomy回避——例えばruntime.dispatched/runtime.resumed等、
// P5 Runtime Adapterが実在して初めて意味を持つ値は今回登録しない)。
export type AuditEventType =
  | "work.created"
  | "task.created"
  | "policy.evaluated"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "clarification.requested"
  | "clarification.answered"
  | "run.created"
  | "run.completed"
  | "run.failed"
  | "provider.called"
  | "provider.completed"
  | "provider.failed"
  | "context.requested"
  | "context.retrieved"
  | "context.failed"
  | "context.resolution.planned"
  | "context.source.requested"
  | "context.source.completed"
  | "context.source.failed"
  | "context.pack.built";

export const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  "work.created",
  "task.created",
  "policy.evaluated",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "clarification.requested",
  "clarification.answered",
  "run.created",
  "run.completed",
  "run.failed",
  "provider.called",
  "provider.completed",
  "provider.failed",
  "context.requested",
  "context.retrieved",
  "context.failed",
  "context.resolution.planned",
  "context.source.requested",
  "context.source.completed",
  "context.source.failed",
  "context.pack.built",
];

export interface AuditEvent {

  id: string;

  workId: string;

  taskId?: string | null;

  runId?: string | null;

  approvalId?: string | null;

  clarificationId?: string | null;

  category: AuditEventCategory;

  eventType: AuditEventType;

  // Fast Port P4a Step7: ActorReferenceをflat columnsとして保存する
  // (TACT queryabilityを優先、Approval.requestedByActorKind/Idや
  // Clarification.requestedByActorKind/Idと同じ設計判断)。system
  // event等、人間actorが存在しない場合はいずれもnull。
  actorKind?: ActorKind | null;

  actorId?: string | null;

  reasonCode?: string | null;

  // Fast Port P4a Step9/10: policyDecision/riskClass/providerRef/
  // runtimeRef等は、P4a時点で実際にこれらを書き込むproducerが存在
  // しないため専用fieldを設けず、この汎用JsonValueへ収める
  // (過剰schema設計回避——P4bの実配線で判明した時点で専用fieldへ
  // 昇格するかを判断する)。絶対条件7/8: raw secret/token/provider
  // credential/Authorization headerを一切含めない
  // (core/tact-work/audit.tsのcontainsSuspiciousKey()が最小限の
  // key名guardを行う、generic redaction engineは作らない)。
  details?: JsonValue | null;

  // Fast Port P4a Step6(Option A採用): DB側のgenerated always as
  // identity列(supabase/migrations/20260912000000_create_tact_audit_events.sql
  // 参照)によるglobal monotonic sequence。Work単位でのdeterministic
  // orderingは、work_idで絞り込んだ上でこの値でソートするだけで
  // 安定して得られる(AXMEのseqと同じ「単調増加する順序保証」という
  // 目的を、per-Work sequence生成のconcurrency hazard無しで満たす)。
  sequence: number;

  occurredAt: string;

  createdAt: string;

}
