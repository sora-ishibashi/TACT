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
// REF-P1d: pinned referent候補のimmutable snapshot型を、tact-referentの
// pure domain moduleからそのまま再利用する(型のみimport、新しい並行
// 語彙を作らない)。依存方向はDesign Freeze §23で確定した一方向
// (tact-work → tact-referent)のまま——tact-referent側はcore/tact-work
// を一切importしない。
import type { CandidateSnapshotEntry } from "../tact-referent/clarification";

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

// WORK-P1: provider-independent semantics for a delegated Work. These values
// describe what TACT is responsible for accomplishing; provider action names
// remain confined to the integration execution boundary.
export type WorkRequestType = "inspect" | "prepare" | "act" | "monitor" | "unknown";

export type WorkCapabilityRequirement =
  | "organizational_context.read"
  | "communication.read"
  | "communication.write";

// =========================
// CAP-P1b: Canonical Task/Run Capability (semantic, provider-neutral)
// =========================
//
// WorkCapabilityRequirement(直上)はWork.requiredCapabilitiesという
// DB CHECK制約付き列(supabase/migrations/
// 20260921000000_add_gmail_work_semantics.sql)へ実際に永続化できる
// 値に限定された語彙であり、そのDB制約を経由しないResearch
// Capability("research.perform")を含められない。WorkTask/Runが
// 「このTask/Runは意味論的に何の能力を必要としたか」を保持するには
// この3値だけでは不足するため、CAP-P1(core/tact-work/capability.ts)の
// CanonicalCapabilityと同じ値集合をここで独立して宣言する。
//
// cross-module importで循環参照を作らない、という既存パターン
// (core/tact-orchestrator/task.tsのTaskIntegrationRiskClassSnapshot
// コメント参照: 「値だけを独立に再宣言する」)をそのまま踏襲する
// ——core/tact-work/capability.tsは型のみこのファイルをimportして
// おり(WorkCapabilityRequirement等)、その逆方向(このファイルが
// capability.tsをimportする)は行わない。capability.ts側の
// CanonicalCapability型はこの型のaliasとして定義し、値集合の
// 単一の真実の情報源(source of truth)はこちらに置く。
// TIME-P1c capability audit (Section 5): "calendar.availability.read" is
// added the same way "research.perform" was — as a classification-only
// value on this superset type, never on WorkCapabilityRequirement (whose
// DB CHECK constraint, supabase/migrations/20260921000000_add_gmail_work_semantics.sql,
// is untouched by this addition; no migration was needed for this specific
// change). It represents a genuinely distinct semantic capability (reading
// calendar availability data), not a fit for the existing three
// organizational_context.read/communication.read/communication.write
// values. No execution binding (core/tact-orchestrator/capabilityPlan.ts)
// exists for it yet — this is audit-only groundwork, not production wiring
// (TIME-P1c Section 13: wiring requires a verified provider adapter, which
// this phase does not have — see candidateSchedule.ts's header).
export type CanonicalTaskCapability = WorkCapabilityRequirement | "research.perform" | "calendar.availability.read";

export type WorkCompletionCondition =
  | "subject_identified"
  | "organizational_context_checked"
  | "communication_checked"
  | "reply_prepared"
  | "approval_granted"
  | "communication_sent"
  | "result_synthesized"
  | "result_delivered";

export interface WorkEvidenceReference {
  category: "conversation" | "organizational" | "communication";
  sourceType: "slack" | "notion" | "gmail";
  sourceRef: string;
  operation?: "search" | "read_page" | "search_messages";
}

export interface ResolvedWorkIntent {
  subject: string;
  objective: string;
  title: string;
  requestType: WorkRequestType;
  completionConditions: WorkCompletionCondition[];
  requiredCapabilities: WorkCapabilityRequirement[];
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

  subject?: string | null;

  requestType?: WorkRequestType | null;

  completionConditions?: WorkCompletionCondition[] | null;

  requiredCapabilities?: WorkCapabilityRequirement[] | null;

  evidenceRefs?: WorkEvidenceReference[] | null;

  // A durable conversation response was recorded. Channel adapters may still
  // own their physical transport, but this is the canonical TACT delivery
  // boundary used for Work completion.
  resultDeliveredAt?: string | null;

  // TIME-P1a: 「このWorkはこの時刻までに完了することが期待されている」
  // という事実の表現。スケジューラのtrigger条件ではない——deadlineが
  // 過ぎても、このfield自体もcompletion.tsも何も自動的には行わない
  // (絶対条件Section6: overdue failure policyを発明しない)。
  // core/tact-work/temporal.tsのisDeadlineExceeded(now, deadline)で
  // read-onlyに判定できる。
  deadline?: string | null;

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

// RUNS-P1b(Retryable Task Lifecycle): "waiting_for_retry"は、直近のRunが
// retryable(core/tact-integration/types.tsのIntegrationExecutionError.
// retryable、RUNS-P1でtact_runs.external_refへ永続化済み)に失敗した
// ことを表す、非terminalな状態。"failed"は既存のまま「terminal・
// 回復不能」という意味を一切変えない——一度"failed"になったTaskを
// 後から"waiting_for_retry"や他のstatusへ戻す経路は、このcommitでは
// 一切実装しない(絶対条件、Section1: failed remains terminal and
// monotonic)。"waiting_for_retry"は「自動的にretryされる」ことを
// 意味しない——scheduler/timer/cronはこのphaseでは一切追加しない
// (WHENの判断はTIME-P1へ委譲、RUNS-P1bはWHETHER(retryが意味論的に
// 許されるか)だけを扱う)。
// EVENT-P1a: "waiting_for_event"は、EventWait.status="pending"な行が
// 存在することのlifecycle projectionである(このfile末尾のExternalEvent
// /EventWaitセクション参照)。"waiting_for_retry"と同様、非terminalで
// あり、自動的にresumeされることを意味しない——matching/claim/resumeの
// いずれもEVENT-P1a時点では一切実装しない(EVENT-P1b/c以降のscope)。
export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_for_retry"
  | "waiting_for_event"
  | "completed"
  | "failed"
  | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "waiting_for_retry",
  "waiting_for_event",
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

  // 実行binding(WHAT/HOWのHOW側): このTaskをどのCapability Registry
  // dispatch key/Provider操作で実行するか(例:
  // "integration.gmail.search_messages")。CAP-P1a/CAP-P1b以前から
  // 存在する既存フィールドで、意味・値は一切変更しない
  // (core/tact-orchestrator/decomposer.tsが決定論的に設定する)。
  assignedCapability?: string | null;

  // CAP-P1b: 意味論的Capability(WHAT側): assignedCapability
  // (dispatch key)から、core/tact-work/capability.tsの
  // resolveTaskCapabilities()によって決定論的に導出される、
  // provider名を含まないCanonical Capability。DBへは永続化されない
  // (assigned_capability列のみが真実の情報源であり、この値は
  // toWorkTask()がDB row → domain変換の都度、副作用なく再計算する
  // read-onlyな派生値)。未知のdispatch key・assignedCapability
  //未設定の場合はnull(fail closed、推測で埋めない)。
  canonicalCapabilities?: readonly CanonicalTaskCapability[] | null;

  // TIME-P1a: 「この時刻より前には再開しない」というgating condition。
  // 「この時刻ちょうどに自動実行する」という意味ではない——単に
  // isWaitUntilSatisfied(now, waitUntil)で読み取れるgateの状態を
  // 持つだけであり、実際にいつ再開するかを決めるscheduler/timerは
  // このphaseでは一切実装しない。未設定(null)は「gateなし」を意味する
  // (絶対条件: 過去のwaitUntilを"gate already open"として安全側に
  // 扱う)。
  waitUntil?: string | null;

  // TIME-P1a: RUNS-P1bのTask.status="waiting_for_retry"と対になる、
  // 「retryのためのRunを新たにclaimしてよい最短時刻」。
  // core/tact-work/taskRunReconciliation.tsのevaluateTaskRetryEligibility()
  // が、既存の非時間的条件(Task状態・active Run有無・直近failureの
  // retryability)と組み合わせて判定する材料の1つにすぎない——この値
  // 単体はいかなるprovider実行もauthorizeしない(絶対条件Section19)。
  // 未設定(null)は「時間による制約なし、他の条件さえ揃えば手動trigger
  // 可」という既定(Section12の明示的preferred default)。
  nextRetryAt?: string | null;

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

  // CAP-P1b: 意味論的Capability(WHAT側)。上のcapability(dispatch key、
  // 例: "integration.gmail.search_messages")から
  // resolveTaskCapabilities()で決定論的に導出される、provider名を
  // 含まないCanonical Capability。DBへは永続化されない、toRun()が
  // DB row → domain変換の都度再計算するread-onlyな派生値
  // (WorkTask.canonicalCapabilitiesと同じ設計)。「なぜこのRunが
  // 実行されたか」をRun単体から辿れるようにする(Run → Task経由の
  // 追加JOINを必要としない)。未知のdispatch keyの場合はnull。
  canonicalCapabilities?: readonly CanonicalTaskCapability[] | null;

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

  // =========================
  // Referent Clarification (REF-P1d: Pinned Clarification +
  // TOCTOU-Safe Candidate Selection)
  // =========================
  //
  // supabase/migrations/20260922000000_add_referent_clarification_snapshot.sql
  // で追加したnullable列にそのまま対応する。両方ともnull/undefinedの
  // 場合、このClarificationは既存(Fast Port P3a)の自由記述回答のまま
  // 振る舞う——candidateSnapshot/candidateSnapshotHashの有無が、
  // referent-selection Clarificationかどうかを区別する唯一の判別子
  // (新しいuniversal Clarification frameworkを導入しない、REF-P1d
  // 絶対条件)。作成後は一切mutateされない(immutable、TOCTOU防御)。

  candidateSnapshot?: readonly CandidateSnapshotEntry[] | null;

  candidateSnapshotHash?: string | null;

}

// =========================
// ExternalEvent / EventWait (EVENT-P1a: Canonical Event + Wait Model)
// =========================
//
// docs/architecture/tact-runs-boundary.md §8・
// docs/architecture/p2-p5-final-architecture.md §9/§28で確立した設計
// 原則(Approval/Clarificationは共通base typeを持たない独立entity、
// "resolved ≠ resumed"、RunStatusに"waiting"を追加しない)をそのまま
// 継承する第4の独立したwaiting mechanismとして追加する。
//
// EVENT-P1a時点で「しない」こと(絶対条件、Architecture Auditの
// スコープ通り):
//   - webhook route / provider固有のingestion実装
//   - matching実行(deterministic matchはEVENT-P1cのscope、ここでは
//     「何と何を比較すれば良いか」という型の形だけを確定させる)
//   - wait claim / automatic resume
//   - Runへの新しい状態("waiting")の追加(RunStatusは無変更)
//
// Task.status="waiting_for_event"とEventWait.status="pending"の関係
// (Architecture Decision、Section1):
//   Task.statusはlifecycle上のprojection(「今このTaskは何をしている
//   最中か」を一目で判定できる値)であり、EventWaitがcanonicalな
//   waiting-condition record(「何を・どう識別して・いつまで待つか」)
//   のsource of truthである。この関係は、Approval/ClarificationにおいてWork.status
//   がprojectionでApproval/Clarification tableがsource of truthである
//   のと対称的な設計(ただしEVENT-P1では既存のWork.statusを再利用せず、
//   Task.statusに新しい値を追加する——Approval/Clarificationは複数Task
//   にまたがりうるWork全体のwaitを表現する一方、EventWaitは常に単一の
//   Task/Workに1:1で属する、Section4「The wait belongs to one canonical
//   Task and Work」)。

export type ExternalEventStatus =
  | "received"
  | "matched"
  | "unmatched"
  | "expired"
  | "invalid";

export const EXTERNAL_EVENT_STATUSES: readonly ExternalEventStatus[] = [
  "received",
  "matched",
  "unmatched",
  "expired",
  "invalid",
];

// ExternalEvent = 「TACTの外部から届いた、正規化済みの1件の出来事」。
// EVENT-P1a時点ではproducerが存在しない(webhook route未実装、
// Section17絶対条件)ため、このfileはCanonical Model・Store層のみを
// 定義する。
//
// tact_worksのようなtop-level user-owned entityとして設計する
// (Approval/Clarificationのように親Work経由のEXISTS句でownershipを
// 判定しない)。理由(Section9、Event-Before-Wait Durability):
// ExternalEventは対応するEventWait(ひいてはWork/Task)がまだ存在しない
// 時点でも永続化できなければならない——そのため、Work/Taskへの
// NOT NULL FKを持たず、userIdを直接列として持つ。
export interface ExternalEvent {

  id: string;

  userId: string;

  // Provider識別子。Run.provider(Architecture Migration Phase C1で
  // LLM専用unionからstringへ拡張済み)と同じ設計方針——将来のProvider
  // 追加のたびに型定義を変更する必要がないよう、closed unionにしない。
  source: string;

  // Provider定義のevent種別(例: "message.received",
  // "approval.decision")。sourceと同じ理由でstring。
  eventType: string;

  // Providerが払い出した、そのevent配信自体のID(dedupeの主要な材料の
  // 1つ、Section3)。
  externalEventId: string;

  // Deterministic matching(Section6)の対象となる、canonicalな相関
  // 識別子(例: Slack thread ID、Gmail message/thread ID、Notion page
  // ID)。EVENT-P1aは値の形をprovider横断で強制しない(provider固有の
  // 正規化はEVENT-P1bのIngestion層の責務)。
  subjectRef: string;

  // Providerが報告した実際の発生時刻。提供されない場合はnull
  // (絶対条件: 受信時刻で代用して推測しない)。
  occurredAt?: string | null;

  receivedAt: string;

  // 最小限のJSONのみ(絶対条件2: 生のprovider payloadをそのまま保持
  // しない、provider credential/authorizationデータを含めない)。
  // Approval.payloadと同じ"Record<string, unknown>"を再利用する
  // (新しいpayload語彙を増やさない)。
  normalizedPayload: Record<string, unknown>;

  status: ExternalEventStatus;

  createdAt: string;

}

export type EventWaitStatus = "pending" | "claimed" | "expired" | "cancelled";

export const EVENT_WAIT_STATUSES: readonly EventWaitStatus[] = [
  "pending",
  "claimed",
  "expired",
  "cancelled",
];

// EventWait = 「あるTaskが、どのExternalEventを待っているか」という
// canonical waiting-condition record。Approval/Clarificationと同じく、
// 親Work経由でownershipを判定できる子entityだが(Section5)、将来の
// 直接lookup(user/source/eventType/subjectRef、Section6)を素朴な
// EXISTS結合無しで行えるよう、userIdを非正規化して直接持つ
// (ARCH-R2 Section5がtact_runs.work_idをtask_id経由でも辿れるのに
// 意図的に非正規化しているのと同じ理由)。Store層はこのuserIdを
// 呼び出し元から無条件に信用せず、常に検証済みのWork ownership
// (WorkOwnershipDeps.getWork())から複製する——client供給値と
// 親Workのuser_idが乖離することは構造的に起こらない。
export interface EventWait {

  id: string;

  userId: string;

  workId: string;

  // ApprovalCase/Clarificationのtask_idはoptional(Work全体に対する
  // waitでありうる)だが、EventWaitは常に単一のTaskに1:1で属する
  // (Section4「The wait belongs to one canonical Task and Work」)。
  taskId: string;

  expectedSource: string;

  expectedEventType: string;

  // Section6のdeterministic matching contract:
  //   event.userId == wait.userId
  //   && event.source == wait.expectedSource
  //   && event.eventType == wait.expectedEventType
  //   && event.subjectRef == wait.subjectRef
  // ここにfuzzy/LLMによる比較の余地は無い(絶対条件、content-based
  // matching禁止)。
  subjectRef: string;

  status: EventWaitStatus;

  createdAt: string;

  // Task.waitUntil(TIME-P1a)と同じ「gateであり、authorizeではない」
  // 意味論——期限超過を自動検出・自動失効させるscheduler/cronはこの
  // phaseでは一切実装しない(絶対条件、Section10で明示的に
  // "not implement yet"とされたobservability/自動遷移と同じ理由)。
  expiresAt?: string | null;

  // claim成立時(EVENT-P1c)にのみ設定される、claimしたExternalEventへの
  // 参照。EVENT-P1a時点でこの列を書き込むproducerは存在しない
  // (createEventWait()は常にnullのまま挿入する)。
  claimedByEventId?: string | null;

}

// =========================
// Event/Wait Atomic Claim Outcomes (EVENT-P1c)
// =========================
//
// supabase/migrations/20261016010000_create_event_wait_claim_functions.sql
// の各Postgres function(tact_claim_matched_event_wait/
// tact_match_and_claim_external_event/tact_create_event_wait)が返す
// jsonbの形に対応するcanonical TS型。SQL側の絶対条件(Section21状態
// 遷移・Section22 typed outcomes)をそのままTS側の型として反映する。

export type EventWaitClaimOutcome =
  | { status: "wait_claimed"; eventId: string; waitId: string; taskId: string; workId: string }
  // Section7/8: マッチする候補が無いだけで、event-before-wait durability
  // によりExternalEvent.statusは"received"のまま変更しない。
  | { status: "event_unmatched" }
  // Section4: 複数のpending EventWaitが同じidentityに一致した
  // (legacy/corrupt data)。oldest/firstを選ばず、claimしない。
  | { status: "event_ambiguous"; candidateCount: number }
  | { status: "event_not_found" }
  // 既にmatched/expired/invalidなeventへの重複呼び出し
  // (Section22: 新しいclaimとしてではなくidempotent/reconcilableに
  // 扱う——呼び出し元がこのstatusをエラーとして扱わないことを期待する)。
  | { status: "event_not_receivable"; eventStatus: ExternalEventStatus }
  | { status: "wait_not_found" }
  | { status: "wait_already_claimed"; waitStatus: EventWaitStatus }
  // Section3のdeterministic matching contractが(呼び出し元の絞り込みに
  // もかかわらず)成立しなかった、fail-closedな防御分岐。
  | { status: "wait_wrong_owner" }
  // Section6: event.receivedAt >= wait.expiresAt(境界含む)。
  | { status: "wait_expired" }
  // Section14/21: Task terminal・Task.status不整合(waiting_for_event
  // ではない)のいずれか。reasonでどちらかを区別する。
  | {
      status: "wait_task_not_resumable";
      reason: "task_not_found" | "task_work_mismatch" | "task_terminal" | "task_not_waiting_for_event";
      taskStatus?: TaskStatus;
    }
  // Section14: Work terminal(またはWork自体が見つからない、fail closed)。
  | { status: "wait_work_terminal"; reason?: "work_not_found"; workStatus?: WorkStatus };

export type CreateEventWaitOutcome =
  | {
      status: "wait_created";
      waitId: string;
      taskId: string;
      workId: string;
      // Section8: wait作成と同一transaction内で行われた、既存
      // "received" ExternalEventとの照合結果。0件ならevent_unmatched、
      // 2件以上ならevent_ambiguous、ちょうど1件ならEventWaitClaimOutcome
      // (成功時はwait_claimedを含みうる)。
      reconciliation: EventWaitClaimOutcome;
    }
  | { status: "task_not_found" }
  | {
      status: "wait_task_not_resumable";
      reason: "task_terminal" | "task_not_pending";
      taskStatus?: TaskStatus;
    }
  | { status: "wait_work_terminal"; workStatus?: WorkStatus };

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
  | "work.intent.resolved"
  | "work.completion.evaluated"
  | "work.completed"
  | "work.blocked"
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
  "work.intent.resolved",
  "work.completion.evaluated",
  "work.completed",
  "work.blocked",
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
