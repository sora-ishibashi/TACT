import { createClient } from "@supabase/supabase-js";
import type {
  Work,
  WorkStatus,
  WorkTask,
  WorkTaskTableSchema,
  TaskStatus,
  TaskDependency,
  Run,
  RunStatus,
  Approval,
  ApprovalStatus,
  ActorKind,
  Clarification,
  ClarificationStatus,
  ClarificationReasonCode,
  ExternalEvent,
  ExternalEventStatus,
  EventWait,
  EventWaitStatus,
  AuditEvent,
  AuditEventCategory,
  AuditEventType,
} from "./types";
// REF-P1d: DBのjsonb列(unknown)をCandidateSnapshotEntry[]へ安全に
// 検証・変換する、tact-referentのpure runtime validator。
import { parseCandidateSnapshot, type CandidateSnapshotEntry } from "../tact-referent/clarification";
import type { JsonValue } from "./approvalIntegrity";
import type { TemporalRequirementMetadata } from "./temporalRequirements";
// TIME-P1c: candidate slot snapshot persistence, same merge-safe pattern as
// updateWorkTemporalRequirementMetadata below.
import type { CandidateSlotSnapshotMetadata } from "./candidateSchedule";
// CAP-P1b: DB rowが持つ既存のexecution binding(assigned_capability/
// capability、いずれもCapability Registry dispatch key)から、
// provider名を含まないCanonical Capabilityを決定論的に導出する
// pure関数。toWorkTask()/toRun()はいずれもこのfile内の既存の
// pure変換関数であり、resolveTaskCapabilities()を呼んでも新しい
// 副作用・新しいDB呼び出しは一切発生しない。
import { resolveTaskCapabilities } from "./capability";

// =========================
// TACT Work Store (Architecture Migration Phase B1)
// =========================
//
// core/tact-work/*の唯一のDBアクセス層。supabase/migrations/
// 20260905000000_create_tact_work_tables.sql(いずれもStage1 RLS、
// auth.uid()=user_idまたはWork経由のEXISTS句ベース)を対象とする。
//
// 重要(core/tact-conversation/store.tsと全く同じ理由・同じPattern):
// core/database/supabase.tsの共有クライアントはanonキーのみで生成
// されておりSupabaseセッションを引き継がないため、検証済みの
// access_tokenをAuthorizationヘッダーとして持つ、リクエストごとの
// クライアントを構築する。
//
// 絶対条件(RLSをAPIの代わりとして扱わない、既存方針そのまま):
// RLS前提のクライアントを使う場合でも、各関数は明示的に`.eq(...)`を
// 伴うクエリを組み立てる。RLSは最後の防御層として維持し、所有者
// 判定の主たるロジックはこのファイル(アプリケーション層)に置く。
//
// Task/Run/Approval/Task Dependencyはuser_id列を重複保持しない
// (ARCH-R2 Section15、tact_conversation_messages/
// tact_execution_recordsが親のuser_idのみを持つ既存パターンと同じ)。
// そのため、これらの子Entityへの操作は必ず「親Work(workId)を
// 先にuser_idで検証してから」行う——親検証と実際のDB呼び出しを
// 分離するため、各関数は`deps: { getWork }`という最小限のDI seamを
// 持つ(既定値は本ファイルの実getWork()。テスト側は偽のgetWork()を
// 注入して「他userのWorkを指定した場合、子Entityへは一切到達しない」
// ことを実Supabase無しで検証できる、core/tact-bot/connector/
// conversationConnector.tsのDIパターンと同じ考え方)。
//
// Service role keyはこのfileへ一切importしない(core/database/
// supabaseServiceRole.tsのコメント通り、利用箇所はcore/tact-bot/配下
// の3fileのみに限定されている。Work Storeは常にユーザー本人の
// access_token、または将来のTrusted Bot Execution Boundary経由で
// 解決済みのtactUserIdを使う——後者もaccess_token自体はBoundary側が
// 用意するため、この汎用StoreがCredentialを直接扱うことはない)。

function createRequestScopedClient(accessToken: string) {

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    }
  );

}

// =========================
// DB row 型
// =========================

export interface WorkRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  created_by_actor_kind: ActorKind;
  created_by_actor_id: string;
  title: string | null;
  objective: string | null;
  subject: string | null;
  request_type: Work["requestType"] | null;
  completion_conditions: Work["completionConditions"] | null;
  required_capabilities: Work["requiredCapabilities"] | null;
  evidence_refs: Work["evidenceRefs"] | null;
  result_delivered_at: string | null;
  status: WorkStatus;
  primary_conversation_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  cost_summary: Work["costSummary"] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  // TIME-P1a(supabase/migrations/20261010000000_add_temporal_state_fields.sql)。
  // optionalにする理由: ARCH-P1aのsubject_version等と全く同じ
  // (既存tests/tact/work/mapping.test.tsのWorkRowリテラルがこの列を
  // 含まずに構築されているため、requiredにすると無関係なregressionを
  // 起こす)。
  deadline?: string | null;
}

export interface WorkTaskRow {
  id: string;
  work_id: string;
  parent_task_id: string | null;
  description: string;
  status: TaskStatus;
  assigned_capability: string | null;
  table_schema: WorkTaskTableSchema | null;
  created_at: string;
  updated_at: string;
  // TIME-P1a(supabase/migrations/20261010000000_add_temporal_state_fields.sql)。
  // optional(WorkRow.deadlineと同じ理由、既存WorkTaskRowリテラルへの
  // 無関係なregressionを避けるため)。
  wait_until?: string | null;
  next_retry_at?: string | null;
}

export interface TaskDependencyRow {
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
}

export interface RunRow {
  id: string;
  work_id: string;
  task_id: string;
  attempt: number;
  capability: string;
  provider: Run["provider"] | null;
  model: string | null;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  cost: Run["cost"] | null;
  external_ref: Record<string, unknown> | null;
  result: Run["result"] | null;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  work_id: string;
  task_id: string | null;
  requested_by_actor_kind: ActorKind;
  requested_by_actor_id: string;
  requested_from_actor_kind: ActorKind;
  requested_from_actor_id: string;
  // Fast Port P3b。既存rowはすべてNULL(20260911000000migration)。
  allowed_approver_ids?: string[] | null;
  status: ApprovalStatus;
  reason: string;
  payload: Record<string, unknown>;
  requested_at: string;
  responded_at: string | null;
  response: string | null;
  expires_at: string | null;
  created_at: string;
  // Architecture Migration ARCH-P1a。既存rowはすべてNULL(ARCH-P1bの
  // capture wiringが無いため)。optionalにする理由: 既存の
  // tests/tact/work/mapping.test.tsのApprovalRowリテラルがこれらの
  // 列を含まずに構築されているため、requiredにすると無関係な
  // regressionを起こす(このPhaseの変更範囲外のtestを不必要に書き
  // 換えない)。
  subject_version?: number | null;
  subject_json?: Record<string, unknown> | null;
  subject_hash?: string | null;
  subject_captured_at?: string | null;
}

// Fast Port P3a: Human Interaction Foundation。tact_approvalsとは
// 別tableとして持つ(絶対条件: Approval table流用禁止、generic
// HumanInteraction tableをこの時点で作るのも避ける——現在の実
// producerはClarificationだけであり、汎用抽象化を先取りしない)。
export interface ClarificationRow {
  id: string;
  work_id: string;
  task_id: string | null;
  requested_by_actor_kind: ActorKind;
  requested_by_actor_id: string;
  allowed_responder_ids: string[] | null;
  status: ClarificationStatus;
  reason_code: ClarificationReasonCode;
  question: string;
  response: string | null;
  responded_by_actor_kind: ActorKind | null;
  responded_by_actor_id: string | null;
  requested_at: string;
  responded_at: string | null;
  expires_at: string | null;
  created_at: string;
  // REF-P1d(supabase/migrations/20260922000000_add_referent_clarification_snapshot.sql)。
  // jsonb列はunknownとして受け取り、toClarification()内でruntime検証する
  // (DB層を信用しない、既存のparseStoredApprovalSubject()と同じ
  // 設計判断)。
  candidate_snapshot: unknown | null;
  candidate_snapshot_hash: string | null;
}

// EVENT-P1a: Canonical ExternalEvent + EventWait Model。
// supabase/migrations/20261015000000_create_tact_event_model.sqlの
// 2 tableにそのまま対応する。
export interface ExternalEventRow {
  id: string;
  user_id: string;
  source: string;
  event_type: string;
  external_event_id: string;
  subject_ref: string;
  occurred_at: string | null;
  received_at: string;
  normalized_payload: Record<string, unknown>;
  status: ExternalEventStatus;
  created_at: string;
}

export interface EventWaitRow {
  id: string;
  user_id: string;
  work_id: string;
  task_id: string;
  expected_source: string;
  expected_event_type: string;
  subject_ref: string;
  status: EventWaitStatus;
  created_at: string;
  expires_at: string | null;
  claimed_by_event_id: string | null;
}

// Fast Port P4a: Append-Only Audit Event Foundation。current-state
// tableとは独立したevent log(絶対条件3)。
export interface AuditEventRow {
  id: string;
  work_id: string;
  task_id: string | null;
  run_id: string | null;
  approval_id: string | null;
  clarification_id: string | null;
  category: AuditEventCategory;
  event_type: AuditEventType;
  actor_kind: ActorKind | null;
  actor_id: string | null;
  reason_code: string | null;
  details: JsonValue | null;
  sequence: number;
  occurred_at: string;
  created_at: string;
}

// =========================
// DB row → domain 変換 (snake_case → camelCase、pure関数)
// =========================

export function toWork(row: WorkRow): Work {

  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    createdByActorKind: row.created_by_actor_kind,
    createdByActorId: row.created_by_actor_id,
    title: row.title,
    objective: row.objective,
    subject: row.subject,
    requestType: row.request_type,
    completionConditions: row.completion_conditions,
    requiredCapabilities: row.required_capabilities,
    evidenceRefs: row.evidence_refs,
    resultDeliveredAt: row.result_delivered_at,
    status: row.status,
    primaryConversationId: row.primary_conversation_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    cancelledAt: row.cancelled_at,
    costSummary: row.cost_summary,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // TIME-P1a。rowに列自体が無い(SELECT対象外・移行前の古いfake row等)
    // 場合はundefinedのまま、列はあるがNULLの場合はnullをそのまま伝播する
    // (ARCH-P1aのsubjectVersion等と同じ既存の扱い方)。
    deadline: row.deadline,
  };

}

export function toWorkTask(row: WorkTaskRow): WorkTask {

  return {
    id: row.id,
    workId: row.work_id,
    parentTaskId: row.parent_task_id,
    description: row.description,
    status: row.status,
    assignedCapability: row.assigned_capability,
    // CAP-P1b: assigned_capability(既存のexecution binding/dispatch
    // key)から、read-onlyなCanonical Capabilityをその都度導出する。
    // 新しい列は一切追加しない(resolveTaskCapabilities()が未知の
    // dispatch keyに対してundefinedを返した場合はnullへ正規化する
    // ——既存のnull/undefinedの扱いと揃える)。
    canonicalCapabilities: resolveTaskCapabilities(row.assigned_capability) ?? null,
    // TIME-P1a。WorkRow.deadlineと同じ理由でoptionalなrow列をそのまま
    // 伝播する。
    waitUntil: row.wait_until,
    nextRetryAt: row.next_retry_at,
    tableSchema: row.table_schema,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

}

export function toTaskDependency(row: TaskDependencyRow): TaskDependency {

  return {
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    createdAt: row.created_at,
  };

}

export function toRun(row: RunRow): Run {

  return {
    id: row.id,
    workId: row.work_id,
    taskId: row.task_id,
    attempt: row.attempt,
    capability: row.capability,
    // CAP-P1b: WorkTask.canonicalCapabilitiesと同じ理由・同じ設計
    // (read-only、DBへ永続化しない派生値)。RunはTask経由でJOINしなくても
    // 単体でCanonical Capabilityを保持する。
    canonicalCapabilities: resolveTaskCapabilities(row.capability) ?? null,
    provider: row.provider,
    model: row.model,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    cost: row.cost,
    externalRef: row.external_ref,
    result: row.result,
    createdAt: row.created_at,
  };

}

export function toApproval(row: ApprovalRow): Approval {

  return {
    id: row.id,
    workId: row.work_id,
    taskId: row.task_id,
    requestedByActorKind: row.requested_by_actor_kind,
    requestedByActorId: row.requested_by_actor_id,
    requestedFromActorKind: row.requested_from_actor_kind,
    requestedFromActorId: row.requested_from_actor_id,
    allowedApproverIds: row.allowed_approver_ids,
    status: row.status,
    reason: row.reason,
    payload: row.payload,
    requestedAt: row.requested_at,
    respondedAt: row.responded_at,
    response: row.response,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    // Architecture Migration ARCH-P1a。rowに列自体が無い(SELECT対象
    // 外・古いfake row等)場合はundefinedのまま、列はあるがNULLの場合は
    // nullをそのまま伝播する(既存フィールドと同じnull/undefinedの
    // 扱い方を踏襲、余計な正規化をしない)。
    subjectVersion: row.subject_version,
    subject: row.subject_json,
    subjectHash: row.subject_hash,
    subjectCapturedAt: row.subject_captured_at,
  };

}

export function toClarification(row: ClarificationRow): Clarification {

  return {
    id: row.id,
    workId: row.work_id,
    taskId: row.task_id,
    requestedByActorKind: row.requested_by_actor_kind,
    requestedByActorId: row.requested_by_actor_id,
    allowedResponderIds: row.allowed_responder_ids,
    status: row.status,
    reasonCode: row.reason_code,
    question: row.question,
    response: row.response,
    respondedByActorKind: row.responded_by_actor_kind,
    respondedByActorId: row.responded_by_actor_id,
    requestedAt: row.requested_at,
    respondedAt: row.responded_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    // REF-P1d: rowに列自体が無い(古いSELECT/fake row)場合はundefinedの
    // まま、列はあるがNULL/不正な形の場合はparseCandidateSnapshot()が
    // undefinedを返す——いずれの場合も既存の自由記述Clarification挙動
    // へ安全にfall backする(ApprovalRowのsubject_json等と同じ、既存
    // フィールドのnull/undefined扱いを踏襲)。
    candidateSnapshot: parseCandidateSnapshot(row.candidate_snapshot),
    candidateSnapshotHash: row.candidate_snapshot_hash,
  };

}

export function toExternalEvent(row: ExternalEventRow): ExternalEvent {

  return {
    id: row.id,
    userId: row.user_id,
    source: row.source,
    eventType: row.event_type,
    externalEventId: row.external_event_id,
    subjectRef: row.subject_ref,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    normalizedPayload: row.normalized_payload,
    status: row.status,
    createdAt: row.created_at,
  };

}

export function toEventWait(row: EventWaitRow): EventWait {

  return {
    id: row.id,
    userId: row.user_id,
    workId: row.work_id,
    taskId: row.task_id,
    expectedSource: row.expected_source,
    expectedEventType: row.expected_event_type,
    subjectRef: row.subject_ref,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    claimedByEventId: row.claimed_by_event_id,
  };

}

export function toAuditEvent(row: AuditEventRow): AuditEvent {

  return {
    id: row.id,
    workId: row.work_id,
    taskId: row.task_id,
    runId: row.run_id,
    approvalId: row.approval_id,
    clarificationId: row.clarification_id,
    category: row.category,
    eventType: row.event_type,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    reasonCode: row.reason_code,
    details: row.details,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };

}

// TIME-P1a: deadlineをSELECT対象へ追加(追加しないとtoWork()が常に
// undefinedしか受け取れない)。
const WORK_COLUMNS =
  "id, user_id, organization_id, created_by_actor_kind, created_by_actor_id, title, objective, subject, request_type, completion_conditions, required_capabilities, evidence_refs, result_delivered_at, status, primary_conversation_id, started_at, completed_at, failed_at, cancelled_at, cost_summary, metadata, created_at, updated_at, deadline";

// TIME-P1a: wait_until/next_retry_atをSELECT対象へ追加(同じ理由)。
const TASK_COLUMNS =
  "id, work_id, parent_task_id, description, status, assigned_capability, table_schema, created_at, updated_at, wait_until, next_retry_at";

const DEPENDENCY_COLUMNS = "task_id, depends_on_task_id, created_at";

const RUN_COLUMNS =
  "id, work_id, task_id, attempt, capability, provider, model, status, started_at, completed_at, error, cost, external_ref, result, created_at";

const APPROVAL_COLUMNS =
  "id, work_id, task_id, requested_by_actor_kind, requested_by_actor_id, requested_from_actor_kind, requested_from_actor_id, allowed_approver_ids, status, reason, payload, requested_at, responded_at, response, expires_at, created_at, subject_version, subject_json, subject_hash, subject_captured_at";

const CLARIFICATION_COLUMNS =
  "id, work_id, task_id, requested_by_actor_kind, requested_by_actor_id, allowed_responder_ids, status, reason_code, question, response, responded_by_actor_kind, responded_by_actor_id, requested_at, responded_at, expires_at, created_at, candidate_snapshot, candidate_snapshot_hash";

// EVENT-P1a
const EXTERNAL_EVENT_COLUMNS =
  "id, user_id, source, event_type, external_event_id, subject_ref, occurred_at, received_at, normalized_payload, status, created_at";

const EVENT_WAIT_COLUMNS =
  "id, user_id, work_id, task_id, expected_source, expected_event_type, subject_ref, status, created_at, expires_at, claimed_by_event_id";

const AUDIT_EVENT_COLUMNS =
  "id, work_id, task_id, run_id, approval_id, clarification_id, category, event_type, actor_kind, actor_id, reason_code, details, sequence, occurred_at, created_at";

// =========================
// 純粋なvalidation guard(DBアクセスなし、Store layerでの
// duplicate/self dependency・duplicate attempt防止。DB側の
// PRIMARY KEY/UNIQUE index/CHECK制約(migration参照)による防止と
// 二重に働く、defense-in-depth)
// =========================

export function isSelfDependency(taskId: string, dependsOnTaskId: string): boolean {

  return taskId === dependsOnTaskId;

}

export function isDuplicateDependency(
  existing: TaskDependency[],
  candidate: { taskId: string; dependsOnTaskId: string }
): boolean {

  return existing.some(
    (dep) =>
      dep.taskId === candidate.taskId &&
      dep.dependsOnTaskId === candidate.dependsOnTaskId
  );

}

export function isDuplicateAttempt(existing: Run[], attempt: number): boolean {

  return existing.some((run) => run.attempt === attempt);

}

// =========================
// Work-ownership DI seam
// =========================
//
// 子Entity(Task/Run/Approval/Task Dependency)を操作する各関数は、
// この型のdepsを最後の引数として受け取る(既定値は本ファイルの実
// getWork())。テストは偽のgetWork()を注入し、実Supabaseに接続せず
// 「他userのWorkを指定した場合、子Entityの読み書きに一切到達しない」
// ことを検証できる。

export interface WorkOwnershipDeps {
  getWork: (
    workId: string,
    userId: string,
    accessToken: string
  ) => Promise<Work | undefined>;
}

// =========================
// Work
// =========================

export interface CreateWorkParams {
  userId: string;
  createdByActorKind: ActorKind;
  createdByActorId: string;
  organizationId?: string | null;
  title?: string | null;
  objective?: string | null;
  subject?: string | null;
  requestType?: Work["requestType"] | null;
  completionConditions?: Work["completionConditions"] | null;
  requiredCapabilities?: Work["requiredCapabilities"] | null;
  evidenceRefs?: Work["evidenceRefs"] | null;
  primaryConversationId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function createWork(
  params: CreateWorkParams,
  accessToken: string
): Promise<Work> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_works")
    .insert({
      user_id: params.userId,
      organization_id: params.organizationId ?? null,
      created_by_actor_kind: params.createdByActorKind,
      created_by_actor_id: params.createdByActorId,
      title: params.title ?? null,
      objective: params.objective ?? null,
      subject: params.subject ?? null,
      request_type: params.requestType ?? null,
      completion_conditions: params.completionConditions ?? null,
      required_capabilities: params.requiredCapabilities ?? null,
      evidence_refs: params.evidenceRefs ?? null,
      primary_conversation_id: params.primaryConversationId ?? null,
      metadata: params.metadata ?? null,
    })
    .select(WORK_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toWork(data as WorkRow);

}

// 所有者不一致・存在しない場合のいずれもundefinedを返す
// (core/tact-conversation/store.tsのgetConversation()と同じ規約)。
export async function getWork(
  workId: string,
  userId: string,
  accessToken: string
): Promise<Work | undefined> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_works")
    .select(WORK_COLUMNS)
    .eq("id", workId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return undefined;
  }

  return toWork(data as WorkRow);

}

// status遷移に伴い、対応するタイムスタンプ列を1回だけ設定する
// (絶対条件: 既に設定済みの値は上書きしない。同じstatusへ複数回
// 遷移してもstartedAt等の意味——「最初にその状態になった時刻」——が
// 崩れないようにする)。
function timestampColumnForStatus(status: WorkStatus): string | null {

  switch (status) {
    case "running":
      return "started_at";
    case "completed":
      return "completed_at";
    case "failed":
      return "failed_at";
    case "cancelled":
      return "cancelled_at";
    default:
      return null;
  }

}

// Evidence is stored as small canonical references only. The Context Pack and
// provider payloads remain in-memory and are deliberately never copied here.
export async function updateWorkEvidenceRefs(
  workId: string,
  userId: string,
  accessToken: string,
  evidenceRefs: NonNullable<Work["evidenceRefs"]>
): Promise<void> {

  const client = createRequestScopedClient(accessToken);

  const { error } = await client
    .from("tact_works")
    .update({ evidence_refs: evidenceRefs, updated_at: new Date().toISOString() })
    .eq("id", workId)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }

}

// =========================
// TIME-P1a — Temporal field setters
// =========================
//
// 絶対条件(Section16): 「任意のpatch objectで無関係なfieldまで
// 動かせてしまう」経路を作らない——1 field専用の、明示的な関数だけを
// 用意する(updateWorkStatus()等、既存のこのfileの設計方針と同じ)。
// nullを渡すことで明示的にclearできる(絶対条件Section17: clearは
// 常にこの専用関数を通した明示的な操作であり、他の操作の副作用として
// 起きない)。
export type SetTemporalFieldOutcome =
  | { status: "set" }
  | { status: "not_found" }
  | { status: "invalid_timestamp" };

// 絶対条件(TIME-P1a Section10「Do not persist ambiguous local time
// strings. Internal canonical time should be absolute.」): 末尾に
// "Z"または明示的なUTC offset(+HH:MM/-HH:MM)を持たない文字列
// (例: "2026-10-10 12:00:00"、タイムゾーン無しのlocal-lookingな文字列)
// を拒否する。JSのnew Date()はタイムゾーン無し文字列を実行環境依存の
// local timeとして解釈してしまうことがあり、そのまま許容すると
// 「どの時刻を指しているか」がサーバー環境に依存してしまう
// (絶対条件: 曖昧な時刻を永続化しない)。
const HAS_EXPLICIT_TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;

// 絶対条件(Section11「malformed timestamp rejected」): Date.parse()
// できない値、およびtimezoneが曖昧な値は、この時点で安全に拒否する
// (DBへの書き込み自体を防ぐ、core/tact-work/temporal.tsの
// isDeadlineExceeded()等がread側でfail safeするのとは別に、write側でも
// 不正な値を持ち込ませない)。
function isValidTimestampOrNull(value: string | null): boolean {

  if (value === null) {
    return true;
  }

  return HAS_EXPLICIT_TIMEZONE_PATTERN.test(value) && !Number.isNaN(new Date(value).getTime());

}

// Work.deadline: 「このWorkはこの時刻までに完了することが期待されて
// いる」という事実を設定するだけ——絶対条件Section6: これを設定した
// こと自体がWork statusやcompletion判定に一切影響しない(completion.ts
// はこのfieldを一切参照しない)。
export async function setWorkDeadline(
  workId: string,
  userId: string,
  accessToken: string,
  deadline: string | null,
  deps: WorkOwnershipDeps = { getWork }
): Promise<SetTemporalFieldOutcome> {

  if (!isValidTimestampOrNull(deadline)) {
    return { status: "invalid_timestamp" };
  }

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { status: "not_found" };
  }

  const client = createRequestScopedClient(accessToken);

  const { error } = await client
    .from("tact_works")
    .update({ deadline, updated_at: new Date().toISOString() })
    .eq("id", workId)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }

  return { status: "set" };

}

// This is intentionally called only after the answer has been durably added
// to the canonical Conversation. It is idempotent so retries cannot rewrite
// the original delivery timestamp.
export async function markWorkResultDelivered(
  workId: string,
  userId: string,
  accessToken: string
): Promise<void> {

  const client = createRequestScopedClient(accessToken);

  const { error } = await client
    .from("tact_works")
    .update({ result_delivered_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", workId)
    .eq("user_id", userId)
    .is("result_delivered_at", null);

  if (error) {
    throw error;
  }

}

export async function updateWorkStatus(
  workId: string,
  userId: string,
  accessToken: string,
  status: WorkStatus
): Promise<void> {

  const client = createRequestScopedClient(accessToken);

  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  const timestampColumn = timestampColumnForStatus(status);

  if (timestampColumn) {

    // 既存値がNULLの行だけタイムスタンプを設定する(is()でNULL比較、
    // 既にstartedAt等が入っている行は対象外になりUPDATE自体が
    // 効かないが、statusは別のUPDATE文で常に反映させたいため、
    // 2段階に分ける)。
    const { error: timestampError } = await client
      .from("tact_works")
      .update({ [timestampColumn]: new Date().toISOString() })
      .eq("id", workId)
      .eq("user_id", userId)
      .is(timestampColumn, null);

    if (timestampError) {
      throw timestampError;
    }

  }

  const { error } = await client
    .from("tact_works")
    .update(update)
    .eq("id", workId)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }

}

// =========================
// Task
// =========================

// This deliberately exposes no arbitrary metadata patch API. It reads the
// latest owned Work, merges only the temporal key, and uses updated_at as an
// optimistic-concurrency guard so a concurrent writer is never overwritten.
export async function updateWorkTemporalRequirementMetadata(
  workId: string,
  userId: string,
  accessToken: string,
  temporalRequirement: TemporalRequirementMetadata,
  deps: WorkOwnershipDeps = { getWork }
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const work = await deps.getWork(workId, userId, accessToken);
    if (!work) return false;

    const client = createRequestScopedClient(accessToken);
    const { data, error } = await client
      .from("tact_works")
      .update({
        metadata: { ...(work.metadata ?? {}), temporalRequirement },
        updated_at: new Date().toISOString(),
      })
      .eq("id", workId)
      .eq("user_id", userId)
      .eq("updated_at", work.updatedAt)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (data) return true;
  }

  return false;
}

// TIME-P1c (Section 19/23): pins a generated candidate-slot snapshot into
// Work.metadata so a later "2番で" reference resolves against exactly the
// candidates originally shown, not a silently recomputed set. Same
// merge-safe/optimistic-concurrency shape as
// updateWorkTemporalRequirementMetadata above — no arbitrary metadata patch
// API, only this one named key, and no unrelated metadata is ever dropped.
export async function updateWorkCandidateSnapshotMetadata(
  workId: string,
  userId: string,
  accessToken: string,
  snapshot: CandidateSlotSnapshotMetadata,
  deps: WorkOwnershipDeps = { getWork }
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const work = await deps.getWork(workId, userId, accessToken);
    if (!work) return false;

    const client = createRequestScopedClient(accessToken);
    const { data, error } = await client
      .from("tact_works")
      .update({
        metadata: { ...(work.metadata ?? {}), calendarCandidateSnapshot: snapshot },
        updated_at: new Date().toISOString(),
      })
      .eq("id", workId)
      .eq("user_id", userId)
      .eq("updated_at", work.updatedAt)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (data) return true;
  }

  return false;
}

export interface CreateWorkTaskParams {
  description: string;
  parentTaskId?: string | null;
  assignedCapability?: string | null;
  tableSchema?: WorkTaskTableSchema | null;
}

export async function createTask(
  workId: string,
  userId: string,
  accessToken: string,
  params: CreateWorkTaskParams,
  deps: WorkOwnershipDeps = { getWork }
): Promise<WorkTask | undefined> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return undefined;
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_tasks")
    .insert({
      work_id: workId,
      parent_task_id: params.parentTaskId ?? null,
      description: params.description,
      assigned_capability: params.assignedCapability ?? null,
      table_schema: params.tableSchema ?? null,
    })
    .select(TASK_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toWorkTask(data as WorkTaskRow);

}

// Work所有者でない場合は空配列を返す(「存在しない」と「所有者
// 不一致」を区別しない既存規約)。
export async function listTasksForWork(
  workId: string,
  userId: string,
  accessToken: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<WorkTask[]> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return [];
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_tasks")
    .select(TASK_COLUMNS)
    .eq("work_id", workId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => toWorkTask(row as WorkTaskRow));

}

// Architecture Migration Phase B2: Work Execution Boundary
// (core/tact-work/execution.ts)が、実Execution(core/tact-orchestrator/
// executor.tsのOrchestrationHooks.onTaskFinished)に合わせてWorkTask.
// statusを更新するために追加した。supabase/migrations/
// 20260906000000_add_tact_tasks_update_policy.sqlでtact_tasksへ
// updateポリシーを追加済み。
// TIME-P1a FIX1(Step3、最小の中央集約点): next_retry_atは
// "waiting_for_retry"であることの間だけ意味を持つ(setTaskNextRetryAt()
// 自身がこの前提を強制済み)。したがって不変条件として、Task.statusが
// "waiting_for_retry"以外へ遷移する瞬間(waiting_for_retry→running
// というretry claim成功時も、completed/failed/cancelledという
// terminal化も含む)、next_retry_atは常にnullへ戻してよい——このfile
// 内でTask.statusを変更する経路は常にこの1関数だけを通るため、ここに
// 1箇所だけ書けば、呼び出し元ごとに個別のclear処理を散らばらせずに
// 済む(絶対条件Step3「Do not scatter cleanup across unrelated
// code」)。waitUntilはこの不変条件の対象外(絶対条件Step3
// 「Do not touch waitUntil cleanup」)。
export async function updateTaskStatus(
  workId: string,
  userId: string,
  accessToken: string,
  taskId: string,
  status: TaskStatus,
  deps: WorkOwnershipDeps = { getWork }
): Promise<void> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return;
  }

  const client = createRequestScopedClient(accessToken);

  const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() };

  if (status !== "waiting_for_retry") {
    update.next_retry_at = null;
  }

  const { error } = await client
    .from("tact_tasks")
    .update(update)
    .eq("id", taskId)
    .eq("work_id", workId);

  if (error) {
    throw error;
  }

}

// TIME-P1a: WorkTask.waitUntil。「この時刻より前には再開しない」という
// gating condition。updateTaskStatus()と対称的な、1 field専用の
// 明示的な関数(絶対条件Section16)。Task statusとは独立しており、
// どのstatusのTaskに対しても設定できる(絶対条件: waitUntilは
// nextRetryAtと違い、特定のstatusにひも付く既存の永続semanticsが
// まだ無いため、より汎用的な「いつでも設定できるgate」のまま留める
// ——将来の呼び出し元がstatus前提を必要とする場合はそちら側で判断する)。
export async function setTaskWaitUntil(
  workId: string,
  userId: string,
  accessToken: string,
  taskId: string,
  waitUntil: string | null,
  deps: WorkOwnershipDeps = { getWork }
): Promise<SetTemporalFieldOutcome> {

  if (!isValidTimestampOrNull(waitUntil)) {
    return { status: "invalid_timestamp" };
  }

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { status: "not_found" };
  }

  const client = createRequestScopedClient(accessToken);

  const { error } = await client
    .from("tact_tasks")
    .update({ wait_until: waitUntil, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("work_id", workId);

  if (error) {
    throw error;
  }

  return { status: "set" };

}

export interface SetTaskNextRetryAtDeps extends WorkOwnershipDeps {
  listTasksForWork: typeof listTasksForWork;
}

const defaultSetTaskNextRetryAtDeps: SetTaskNextRetryAtDeps = { getWork, listTasksForWork };

export type SetTaskNextRetryAtOutcome =
  | SetTemporalFieldOutcome
  | { status: "task_not_found" }
  | { status: "task_not_waiting_for_retry"; taskStatus: TaskStatus };

// TIME-P1a(絶対条件Section11「nextRetryAtはwaiting_for_retryに対して
// のみ意味を持つ」): updateTaskStatus()と違い、この関数は書き込み前に
// Task.statusを再確認し、"waiting_for_retry"以外への設定を拒否する
// (fail closed——nextRetryAtが「retryのための時間的な制約」以外の
// 意味を持ってしまうことを防ぐ)。null(clear)は、Task.statusに
// 関わらず常に許可する——RUNS-P1bのretry開始(waiting_for_retry →
// running)やTask終了時にnextRetryAtをclearする場合、その時点で既に
// statusはwaiting_for_retryではなくなっているため。
export async function setTaskNextRetryAt(
  workId: string,
  userId: string,
  accessToken: string,
  taskId: string,
  nextRetryAt: string | null,
  deps: SetTaskNextRetryAtDeps = defaultSetTaskNextRetryAtDeps
): Promise<SetTaskNextRetryAtOutcome> {

  if (!isValidTimestampOrNull(nextRetryAt)) {
    return { status: "invalid_timestamp" };
  }

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { status: "not_found" };
  }

  if (nextRetryAt !== null) {

    const tasks = await deps.listTasksForWork(workId, userId, accessToken);
    const task = tasks.find((candidate) => candidate.id === taskId);

    if (!task) {
      return { status: "task_not_found" };
    }

    if (task.status !== "waiting_for_retry") {
      return { status: "task_not_waiting_for_retry", taskStatus: task.status };
    }

  }

  const client = createRequestScopedClient(accessToken);

  const { error } = await client
    .from("tact_tasks")
    .update({ next_retry_at: nextRetryAt, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("work_id", workId);

  if (error) {
    throw error;
  }

  return { status: "set" };

}

// =========================
// Task Dependency
// =========================

export async function createTaskDependency(
  workId: string,
  userId: string,
  accessToken: string,
  taskId: string,
  dependsOnTaskId: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<TaskDependency | undefined> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return undefined;
  }

  if (isSelfDependency(taskId, dependsOnTaskId)) {
    throw new Error(
      `A task cannot depend on itself (taskId=${taskId}).`
    );
  }

  const existing = await listTaskDependencies(
    workId,
    userId,
    accessToken,
    taskId,
    deps
  );

  if (isDuplicateDependency(existing, { taskId, dependsOnTaskId })) {
    throw new Error(
      `Dependency already exists (taskId=${taskId}, dependsOnTaskId=${dependsOnTaskId}).`
    );
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_task_dependencies")
    .insert({
      task_id: taskId,
      depends_on_task_id: dependsOnTaskId,
    })
    .select(DEPENDENCY_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toTaskDependency(data as TaskDependencyRow);

}

// 指定したtaskIdの依存先一覧を返す(Work所有者確認込み)。
export async function listTaskDependencies(
  workId: string,
  userId: string,
  accessToken: string,
  taskId: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<TaskDependency[]> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return [];
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_task_dependencies")
    .select(DEPENDENCY_COLUMNS)
    .eq("task_id", taskId);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => toTaskDependency(row as TaskDependencyRow));

}

// =========================
// Run
// =========================

export interface CreateRunParams {
  attempt: number;
  capability: string;
  provider?: Run["provider"] | null;
  model?: string | null;
}

export async function createRun(
  workId: string,
  userId: string,
  accessToken: string,
  taskId: string,
  params: CreateRunParams,
  deps: WorkOwnershipDeps = { getWork }
): Promise<Run | undefined> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return undefined;
  }

  const existing = await listRunsForTask(
    workId,
    userId,
    accessToken,
    taskId,
    deps
  );

  if (isDuplicateAttempt(existing, params.attempt)) {
    throw new Error(
      `Run attempt already exists (taskId=${taskId}, attempt=${params.attempt}).`
    );
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_runs")
    .insert({
      work_id: workId,
      task_id: taskId,
      attempt: params.attempt,
      capability: params.capability,
      provider: params.provider ?? null,
      model: params.model ?? null,
    })
    .select(RUN_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toRun(data as RunRow);

}

export interface CompleteRunParams {
  result?: Run["result"] | null;
  cost?: Run["cost"] | null;
  externalRef?: Run["externalRef"] | null;
}

// RUNS-P1b(Section11、terminal Run immutability): completeRun()/
// failRun()は元々`.eq("id", runId).eq("work_id", workId)`だけを
// WHERE条件とするUPDATEであり、Runの現在statusを一切確認しないまま
// 無条件に上書きしていた——既にterminal("completed"/"failed")な
// Runへ、後から誤って(または並行呼び出しで)completeRun()/failRun()が
// 再度呼ばれた場合、terminal Run historyが書き換わってしまう
// (絶対条件: running → completed / running → failed という一方向の
// 遷移以外を許さない)。
//
// 最小の安全策(絶対条件: 新しいqueue/lease/atomic CAS machineryは
// 追加しない、既存パターンをそのまま踏襲): WHERE句へ
// `.eq("status", "running")`を追加し、`.select("id")`で実際に更新された
// 行を確認する。既にterminalなRun(WHERE句が0行にしか一致しない)への
// 呼び出しはUPDATE自体が0行に終わり、この関数はcreateRun()の既存の
// 「Run attempt already exists」throwと同じ形式で、安全に例外を投げる
// (silent no-opにしない——呼び出し元がこの結果を誤って「成功した」と
// 解釈しないようにするため)。
//
// 既知の関連コメント(このcommitで解消する既存debt、core/tact-
// integration/execution.tsのexecuteRuntimeIntegrationRead()、Fast Port
// P5d Step18/39): 「同一Runに対してほぼ同時に2つのTrigger execution が
// このentrypointへ到達した場合、両方がrun.status==="running"を観測して
// どちらもprovider実行へ進む可能性が構造的に残る」と明記されていた
// 残存リスクを、この2関数のDB層guardが閉じる(read-then-actではなく、
// UPDATE自体のWHERE句による正しいcompare-and-set)。
export async function completeRun(
  workId: string,
  userId: string,
  accessToken: string,
  runId: string,
  params: CompleteRunParams = {},
  deps: WorkOwnershipDeps = { getWork }
): Promise<void> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return;
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_runs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      result: params.result ?? null,
      cost: params.cost ?? null,
      external_ref: params.externalRef ?? null,
    })
    .eq("id", runId)
    .eq("work_id", workId)
    .eq("status", "running")
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(
      `Run is not running (already terminal or not found), refusing to overwrite (runId=${runId}).`
    );
  }

}

export interface FailRunParams {
  error: string;
  cost?: Run["cost"] | null;
  externalRef?: Run["externalRef"] | null;
}

// RUNS-P1b(Section11): completeRun()と同じ理由・同じ形の
// terminal immutability guard(上のcompleteRun()のコメント参照)。
export async function failRun(
  workId: string,
  userId: string,
  accessToken: string,
  runId: string,
  params: FailRunParams,
  deps: WorkOwnershipDeps = { getWork }
): Promise<void> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return;
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error: params.error,
      cost: params.cost ?? null,
      external_ref: params.externalRef ?? null,
    })
    .eq("id", runId)
    .eq("work_id", workId)
    .eq("status", "running")
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(
      `Run is not running (already terminal or not found), refusing to overwrite (runId=${runId}).`
    );
  }

}

// =========================
// attachRunExternalRef (Fast Port P5c)
// =========================
//
// completeRun()/failRun()はRun statusの確定と同時にしかexternalRefを
// 設定できない。P5cのRuntime handoff(Trigger.dev startExecution()成功
// 直後、providerがまだ実行されていない時点)ではRunをまだcompleted/
// failedにできないため、externalRefだけを単独で更新する最小APIを
// 追加する(Step10、絶対条件: Run statusは一切変更しない、新しいDB
// columnは追加しない——既存external_ref列をそのまま使う)。
export async function attachRunExternalRef(
  workId: string,
  userId: string,
  accessToken: string,
  runId: string,
  externalRef: Run["externalRef"],
  deps: WorkOwnershipDeps = { getWork }
): Promise<void> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return;
  }

  const client = createRequestScopedClient(accessToken);

  const { error } = await client
    .from("tact_runs")
    .update({ external_ref: externalRef ?? null })
    .eq("id", runId)
    .eq("work_id", workId);

  if (error) {
    throw error;
  }

}

export async function listRunsForTask(
  workId: string,
  userId: string,
  accessToken: string,
  taskId: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<Run[]> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return [];
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_runs")
    .select(RUN_COLUMNS)
    .eq("work_id", workId)
    .eq("task_id", taskId)
    .order("attempt", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => toRun(row as RunRow));

}

// =========================
// Approval
// =========================

export interface CreateApprovalParams {
  taskId?: string | null;
  requestedByActorKind: ActorKind;
  requestedByActorId: string;
  requestedFromActorKind: ActorKind;
  requestedFromActorId: string;
  // Fast Port P3b。省略時(既存の全呼び出し元)はNULLのまま挿入される
  // (=canonical owner-only、既定挙動、後方互換)。
  allowedApproverIds?: string[] | null;
  reason: string;
  payload: Record<string, unknown>;
  expiresAt?: string | null;
  // Architecture Migration ARCH-P1b。省略時(Integration以外の将来
  // Capability、またはsubject capture自体が未対応の呼び出し元)は
  // 4列ともNULLのまま挿入される(ARCH-P1a時点の既存rowと同じ形)。
  subjectVersion?: number | null;
  subjectJson?: Record<string, unknown> | null;
  subjectHash?: string | null;
  subjectCapturedAt?: string | null;
}

export async function createApproval(
  workId: string,
  userId: string,
  accessToken: string,
  params: CreateApprovalParams,
  deps: WorkOwnershipDeps = { getWork }
): Promise<Approval | undefined> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return undefined;
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_approvals")
    .insert({
      work_id: workId,
      task_id: params.taskId ?? null,
      requested_by_actor_kind: params.requestedByActorKind,
      requested_by_actor_id: params.requestedByActorId,
      requested_from_actor_kind: params.requestedFromActorKind,
      requested_from_actor_id: params.requestedFromActorId,
      allowed_approver_ids: params.allowedApproverIds ?? null,
      reason: params.reason,
      payload: params.payload,
      expires_at: params.expiresAt ?? null,
      // Architecture Migration ARCH-P1b。paramsに含まれない場合は
      // undefined ?? nullでNULLのまま挿入される(ARCH-P1a時点の既存
      // rowと同じ形、backward compatible)。
      subject_version: params.subjectVersion ?? null,
      subject_json: params.subjectJson ?? null,
      subject_hash: params.subjectHash ?? null,
      subject_captured_at: params.subjectCapturedAt ?? null,
    })
    .select(APPROVAL_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toApproval(data as ApprovalRow);

}

export async function getApproval(
  workId: string,
  userId: string,
  accessToken: string,
  approvalId: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<Approval | undefined> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return undefined;
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_approvals")
    .select(APPROVAL_COLUMNS)
    .eq("id", approvalId)
    .eq("work_id", workId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return undefined;
  }

  return toApproval(data as ApprovalRow);

}

// respondedAtが未設定な終端status(approved/rejected/cancelled/
// expired)への遷移時のみ、respondedAtを設定する(絶対条件: 既に
// 応答済みの記録を上書きしない)。pendingへ戻すことはこの関数では
// 想定しない(Approval workflow自体はPhase B1のscope外)。
const APPROVAL_TERMINAL_STATUSES: ReadonlySet<ApprovalStatus> = new Set([
  "approved",
  "rejected",
  "cancelled",
  "expired",
]);

export async function updateApprovalStatus(
  workId: string,
  userId: string,
  accessToken: string,
  approvalId: string,
  status: ApprovalStatus,
  response?: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<void> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return;
  }

  const client = createRequestScopedClient(accessToken);

  const update: Record<string, unknown> = { status };

  if (APPROVAL_TERMINAL_STATUSES.has(status)) {
    update.responded_at = new Date().toISOString();
    update.response = response ?? null;
  }

  const { error } = await client
    .from("tact_approvals")
    .update(update)
    .eq("id", approvalId)
    .eq("work_id", workId);

  if (error) {
    throw error;
  }

}

export async function listApprovalsForWork(
  workId: string,
  userId: string,
  accessToken: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<Approval[]> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return [];
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_approvals")
    .select(APPROVAL_COLUMNS)
    .eq("work_id", workId)
    .order("requested_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => toApproval(row as ApprovalRow));

}

// =========================
// Clarification (Fast Port P3a: Human Interaction Foundation)
// =========================
//
// tact_approvalsのCRUD群(createApproval/getApproval/
// updateApprovalStatus/listApprovalsForWork)と全く同じ構造・
// 同じWorkOwnershipDeps DI seam・同じRLS前提を踏襲する。このfile自体
// はraw row-level CRUDのみを持ち、Work.status遷移(waiting_for_input
// への遷移)・allowed responder検証は、より上位の
// core/tact-work/clarification.tsが担う(requestApproval()/
// approveApproval()がstore.tsのcreateApproval()/updateApprovalStatus()
// を呼ぶのと同じ二層構造)。

export interface CreateClarificationParams {
  taskId?: string | null;
  requestedByActorKind: ActorKind;
  requestedByActorId: string;
  allowedResponderIds?: string[] | null;
  reasonCode: ClarificationReasonCode;
  question: string;
  expiresAt?: string | null;
  // REF-P1d: 作成時にのみ設定する。updateClarificationStatus()は
  // この2 fieldを一切書き込まない(絶対条件: candidate_snapshotは
  // 作成後にmutateされない、immutability)。
  candidateSnapshot?: readonly CandidateSnapshotEntry[] | null;
  candidateSnapshotHash?: string | null;
}

export async function createClarification(
  workId: string,
  userId: string,
  accessToken: string,
  params: CreateClarificationParams,
  deps: WorkOwnershipDeps = { getWork }
): Promise<Clarification | undefined> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return undefined;
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_clarifications")
    .insert({
      work_id: workId,
      task_id: params.taskId ?? null,
      requested_by_actor_kind: params.requestedByActorKind,
      requested_by_actor_id: params.requestedByActorId,
      allowed_responder_ids: params.allowedResponderIds ?? null,
      reason_code: params.reasonCode,
      question: params.question,
      expires_at: params.expiresAt ?? null,
      candidate_snapshot: params.candidateSnapshot ?? null,
      candidate_snapshot_hash: params.candidateSnapshotHash ?? null,
    })
    .select(CLARIFICATION_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toClarification(data as ClarificationRow);

}

export async function getClarification(
  workId: string,
  userId: string,
  accessToken: string,
  clarificationId: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<Clarification | undefined> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return undefined;
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_clarifications")
    .select(CLARIFICATION_COLUMNS)
    .eq("id", clarificationId)
    .eq("work_id", workId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return undefined;
  }

  return toClarification(data as ClarificationRow);

}

// respondedAtが未設定な終端status(answered/cancelled/expired)への
// 遷移時のみ、respondedAtを設定する(tact_approvalsのupdateApprovalStatus()
// と全く同じ規約: 既に応答済みの記録を上書きしない)。
const CLARIFICATION_TERMINAL_STATUSES: ReadonlySet<ClarificationStatus> = new Set([
  "answered",
  "cancelled",
  "expired",
]);

export interface UpdateClarificationStatusParams {
  response?: string | null;
  respondedByActorKind?: ActorKind | null;
  respondedByActorId?: string | null;
}

export async function updateClarificationStatus(
  workId: string,
  userId: string,
  accessToken: string,
  clarificationId: string,
  status: ClarificationStatus,
  params: UpdateClarificationStatusParams = {},
  deps: WorkOwnershipDeps = { getWork }
): Promise<void> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return;
  }

  const client = createRequestScopedClient(accessToken);

  const update: Record<string, unknown> = { status };

  if (CLARIFICATION_TERMINAL_STATUSES.has(status)) {
    update.responded_at = new Date().toISOString();
    update.response = params.response ?? null;
    update.responded_by_actor_kind = params.respondedByActorKind ?? null;
    update.responded_by_actor_id = params.respondedByActorId ?? null;
  }

  const { error } = await client
    .from("tact_clarifications")
    .update(update)
    .eq("id", clarificationId)
    .eq("work_id", workId);

  if (error) {
    throw error;
  }

}

export async function listClarificationsForWork(
  workId: string,
  userId: string,
  accessToken: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<Clarification[]> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return [];
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_clarifications")
    .select(CLARIFICATION_COLUMNS)
    .eq("work_id", workId)
    .order("requested_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => toClarification(row as ClarificationRow));

}

// =========================
// ExternalEvent / EventWait (EVENT-P1a: Canonical Event + Wait Model)
// =========================
//
// EVENT-P1a指示Section14絶対条件: このfileはraw row-level CRUDのみを
// 持つ(createExternalEvent/getExternalEvent/createEventWait/
// getEventWait/listPendingEventWaits)。claimEventWait()/
// matchExternalEvent()/resumeWorkFromEvent()はEVENT-P1b/cのscopeであり、
// このcommitには一切含めない。
//
// ExternalEventはtact_worksと同じtop-level user-owned entity
// (Section9「ExternalEvent storage must NOT require an EventWait to
// exist」——Work/TaskへのFKを持たないため、WorkOwnershipDepsは使わず
// userId + accessTokenのみで動作する、createWork()/getWork()と同じ形)。

export interface CreateExternalEventParams {
  userId: string;
  source: string;
  eventType: string;
  externalEventId: string;
  subjectRef: string;
  occurredAt?: string | null;
  normalizedPayload?: Record<string, unknown>;
}

export async function createExternalEvent(
  params: CreateExternalEventParams,
  accessToken: string
): Promise<ExternalEvent> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_external_events")
    .insert({
      user_id: params.userId,
      source: params.source,
      event_type: params.eventType,
      external_event_id: params.externalEventId,
      subject_ref: params.subjectRef,
      occurred_at: params.occurredAt ?? null,
      normalized_payload: params.normalizedPayload ?? {},
    })
    .select(EXTERNAL_EVENT_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toExternalEvent(data as ExternalEventRow);

}

// 所有者不一致・存在しない場合のいずれもundefinedを返す(getWork()と
// 同じ規約)。
export async function getExternalEvent(
  userId: string,
  accessToken: string,
  externalEventId: string
): Promise<ExternalEvent | undefined> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_external_events")
    .select(EXTERNAL_EVENT_COLUMNS)
    .eq("id", externalEventId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return undefined;
  }

  return toExternalEvent(data as ExternalEventRow);

}

// EventWaitはApproval/Clarificationと同じくWork/Taskの子entityのため、
// 同じWorkOwnershipDeps DI seamを使う(userIdは呼び出し元から渡された
// 値をそのまま列へ書き込むのではなく、常にdeps.getWork()が返した
// 検証済みWorkのuserIdと同一——このparams.userIdはgetWork()自体への
// 入力としてのみ使われ、client供給値が親Workのuser_idと乖離する経路は
// 存在しない)。

export interface CreateEventWaitParams {
  taskId: string;
  expectedSource: string;
  expectedEventType: string;
  subjectRef: string;
  expiresAt?: string | null;
}

export async function createEventWait(
  workId: string,
  userId: string,
  accessToken: string,
  params: CreateEventWaitParams,
  deps: WorkOwnershipDeps = { getWork }
): Promise<EventWait | undefined> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return undefined;
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_event_waits")
    .insert({
      user_id: userId,
      work_id: workId,
      task_id: params.taskId,
      expected_source: params.expectedSource,
      expected_event_type: params.expectedEventType,
      subject_ref: params.subjectRef,
      expires_at: params.expiresAt ?? null,
    })
    .select(EVENT_WAIT_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toEventWait(data as EventWaitRow);

}

export async function getEventWait(
  workId: string,
  userId: string,
  accessToken: string,
  eventWaitId: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<EventWait | undefined> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return undefined;
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_event_waits")
    .select(EVENT_WAIT_COLUMNS)
    .eq("id", eventWaitId)
    .eq("work_id", workId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return undefined;
  }

  return toEventWait(data as EventWaitRow);

}

// EVENT-P1a時点でこの関数を呼ぶproducerは存在しない(EVENT-P1c、
// matching実行が実装されて初めて使われる)。Section6のdeterministic
// matching contractがlookupする形をそのまま反映した、read-onlyな
// listing関数として先行して用意する(claimEventWait()自体はここには
// 実装しない、Section14絶対条件)。他user・他Workの行を一切含まない
// (userIdによる直接絞り込み、Work横断で自分のuserId配下のpending wait
// を全て見る用途を想定——特定のWork一つに絞る場合は呼び出し元が
// 返り値をworkIdでfilterする)。
export async function listPendingEventWaits(
  userId: string,
  accessToken: string
): Promise<EventWait[]> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_event_waits")
    .select(EVENT_WAIT_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => toEventWait(row as EventWaitRow));

}

// =========================
// AuditEvent (Fast Port P4a: Append-Only Audit Event Foundation)
// =========================
//
// tact_approvals/tact_clarificationsのCRUD群と同じWorkOwnershipDeps
// DI seam・同じRLS前提を踏襲する。絶対条件(Step16): このfileには
// updateAuditEvent()/deleteAuditEvent()を実装しない——production
// APIはcreate/list(get)のみ(append-only)。

export interface CreateAuditEventParams {
  taskId?: string | null;
  runId?: string | null;
  approvalId?: string | null;
  clarificationId?: string | null;
  category: AuditEventCategory;
  eventType: AuditEventType;
  actorKind?: ActorKind | null;
  actorId?: string | null;
  reasonCode?: string | null;
  details?: JsonValue | null;
  // 省略時はDB defaultのnow()が使われる(実際に事実が発生した時刻を
  // callerが把握している場合のみ明示的に指定する、Approval.
  // subjectCapturedAtと同じ設計思想)。
  occurredAt?: string | null;
}

export async function createAuditEvent(
  workId: string,
  userId: string,
  accessToken: string,
  params: CreateAuditEventParams,
  deps: WorkOwnershipDeps = { getWork }
): Promise<AuditEvent | undefined> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return undefined;
  }

  const client = createRequestScopedClient(accessToken);

  const insertPayload: Record<string, unknown> = {
    work_id: workId,
    task_id: params.taskId ?? null,
    run_id: params.runId ?? null,
    approval_id: params.approvalId ?? null,
    clarification_id: params.clarificationId ?? null,
    category: params.category,
    event_type: params.eventType,
    actor_kind: params.actorKind ?? null,
    actor_id: params.actorId ?? null,
    reason_code: params.reasonCode ?? null,
    details: params.details ?? null,
  };

  // occurredAtを明示的に渡された場合のみ含める(省略時はDB
  // defaultのnow()をそのまま使う——undefinedのoccurred_atキー自体を
  // insertへ含めるとPostgRESTがNULLとして送ってしまい、
  // defaultが働かなくなるため、キー自体を条件付きで追加する)。
  if (params.occurredAt) {
    insertPayload.occurred_at = params.occurredAt;
  }

  const { data, error } = await client
    .from("tact_audit_events")
    .insert(insertPayload)
    .select(AUDIT_EVENT_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toAuditEvent(data as AuditEventRow);

}

// Fast Port P4a Step15: sequence昇順(=発生順)でdeterministicに返す。
// limitは今回追加しない(過剰API回避、Step15絶対条件)——将来event数
// 増加時に必要になった時点で追加する。
export async function listAuditEventsForWork(
  workId: string,
  userId: string,
  accessToken: string,
  deps: WorkOwnershipDeps = { getWork }
): Promise<AuditEvent[]> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return [];
  }

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_audit_events")
    .select(AUDIT_EVENT_COLUMNS)
    .eq("work_id", workId)
    .order("sequence", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => toAuditEvent(row as AuditEventRow));

}
