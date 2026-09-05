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
} from "./types";

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
  status: ApprovalStatus;
  reason: string;
  payload: Record<string, unknown>;
  requested_at: string;
  responded_at: string | null;
  response: string | null;
  expires_at: string | null;
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
    status: row.status,
    reason: row.reason,
    payload: row.payload,
    requestedAt: row.requested_at,
    respondedAt: row.responded_at,
    response: row.response,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };

}

const WORK_COLUMNS =
  "id, user_id, organization_id, created_by_actor_kind, created_by_actor_id, title, objective, status, primary_conversation_id, started_at, completed_at, failed_at, cancelled_at, cost_summary, metadata, created_at, updated_at";

const TASK_COLUMNS =
  "id, work_id, parent_task_id, description, status, assigned_capability, table_schema, created_at, updated_at";

const DEPENDENCY_COLUMNS = "task_id, depends_on_task_id, created_at";

const RUN_COLUMNS =
  "id, work_id, task_id, attempt, capability, provider, model, status, started_at, completed_at, error, cost, external_ref, result, created_at";

const APPROVAL_COLUMNS =
  "id, work_id, task_id, requested_by_actor_kind, requested_by_actor_id, requested_from_actor_kind, requested_from_actor_id, status, reason, payload, requested_at, responded_at, response, expires_at, created_at";

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

  const { error } = await client
    .from("tact_tasks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("work_id", workId);

  if (error) {
    throw error;
  }

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

  const { error } = await client
    .from("tact_runs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      result: params.result ?? null,
      cost: params.cost ?? null,
      external_ref: params.externalRef ?? null,
    })
    .eq("id", runId)
    .eq("work_id", workId);

  if (error) {
    throw error;
  }

}

export interface FailRunParams {
  error: string;
  cost?: Run["cost"] | null;
  externalRef?: Run["externalRef"] | null;
}

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

  const { error } = await client
    .from("tact_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error: params.error,
      cost: params.cost ?? null,
      external_ref: params.externalRef ?? null,
    })
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
  reason: string;
  payload: Record<string, unknown>;
  expiresAt?: string | null;
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
      reason: params.reason,
      payload: params.payload,
      expires_at: params.expiresAt ?? null,
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
