// =========================
// TACT Canonical Execution — Attention Persistence & Read Boundary (SOR-52)
// =========================
//
// core/tact-execution/permission/配下の、tact_execution_attentions専用
// DBアクセス層。supabase/migrations/20261027000000_create_tact_execution_attentions.sql
// を対象とする。SOR-50/51と同じ理由(書き込みは常にPermission
// Evaluator直後の観測boundary、生きたuser browser sessionを前提
// できないtrust boundary)でservice role clientを使う——
// core/database/supabaseServiceRole.tsのallowlistへこのfileも追加する。
//
// 絶対条件(Executionをsource of truthとして保つ、migration冒頭コメント
// 参照): actor/agent/provider/action/execution status/work_idはこの
// tableへ複製しない。read boundary(listExecutionAttentions/
// getExecutionAttention)がexecution_id/permission_decision_id経由で
// 都度読む——特にwork_idはSOR-53後に変わり得るため、Attention行自体を
// 更新せずに「最新のwork_idを含むview」を返せる(SOR-52指示section7)。

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import { toCanonicalExecution, type ExecutionRow } from "../store";
import type {
  CanonicalExecution,
  ExecutionActorKind,
  ExecutionActionCategory,
  ExecutionProvider,
  ExecutionStatus,
} from "../types";
import { toPermissionDecision, type PermissionDecisionRow } from "./store";
import type { ExecutionAttentionCandidate, AttentionReason } from "./attention";
import type { PermissionDecision, PermissionDecisionStatus } from "./types";

const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";

export type AttentionStatus = "open" | "acknowledged" | "resolved";

export const ATTENTION_STATUSES: readonly AttentionStatus[] = ["open", "acknowledged", "resolved"];

export interface ExecutionAttention {

  id: string;

  userId: string;

  executionId: string;

  permissionDecisionId: string;

  reason: AttentionReason;

  status: AttentionStatus;

  createdAt: string;

  updatedAt: string;

  // SOR-48(Attention Lifecycle、加算的field、20261101000000migration)。
  // acknowledged_by/resolved_byはv1-minimalのUIでは表示しない
  // (複数reviewer概念が無いため、user_idと同一人物にしかなり得ない)
  // ——それでもaudit証跡として保存する(Human Owner指示section4)。
  acknowledgedAt: string | null;

  acknowledgedBy: string | null;

  resolvedAt: string | null;

  resolvedBy: string | null;

}

export interface AttentionRow {

  id: string;

  user_id: string;

  execution_id: string;

  permission_decision_id: string;

  reason: AttentionReason;

  status: AttentionStatus;

  created_at: string;

  updated_at: string;

  acknowledged_at: string | null;

  acknowledged_by: string | null;

  resolved_at: string | null;

  resolved_by: string | null;

}

const ATTENTION_COLUMNS =
  "id, user_id, execution_id, permission_decision_id, reason, status, created_at, updated_at, acknowledged_at, acknowledged_by, resolved_at, resolved_by";

export function toExecutionAttention(row: AttentionRow): ExecutionAttention {

  return {
    id: row.id,
    userId: row.user_id,
    executionId: row.execution_id,
    permissionDecisionId: row.permission_decision_id,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };

}

export type PersistExecutionAttentionOutcome =
  | { status: "persisted"; attention: ExecutionAttention }
  // 絶対条件(Idempotency、SOR-52指示section5): 同一execution_idへの
  // 再挿入は、新しい行を作らず既存行をそのまま返す(1 Execution =
  // 高々1 Attention)。
  | { status: "already_exists"; attention: ExecutionAttention }
  | { status: "invalid"; reason: string }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface PersistExecutionAttentionDeps {

  getClient: typeof getServiceRoleClient;

}

const defaultPersistDeps: PersistExecutionAttentionDeps = {
  getClient: getServiceRoleClient,
};

// candidate(pure domain object、attention.ts参照) + このAttentionの
// 根拠となったPermissionDecisionのidを受け取り、永続化する。
// deriveExecutionAttentionCandidate()がnullを返した(allowed/unknown)
// 場合、この関数は呼ばれない——呼び出し元(observe.ts)がその判定を行う。
export async function persistExecutionAttention(
  candidate: ExecutionAttentionCandidate,
  permissionDecisionId: string,
  deps: PersistExecutionAttentionDeps = defaultPersistDeps
): Promise<PersistExecutionAttentionOutcome> {

  if (!permissionDecisionId) {
    return { status: "invalid", reason: "permissionDecisionId is required" };
  }

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const { data, error } = await client
    .from("tact_execution_attentions")
    .insert({
      user_id: candidate.userId,
      execution_id: candidate.executionId,
      permission_decision_id: permissionDecisionId,
      reason: candidate.reason,
    })
    .select(ATTENTION_COLUMNS)
    .single();

  if (!error && data) {
    return { status: "persisted", attention: toExecutionAttention(data as AttentionRow) };
  }

  if (error && (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_CODE) {

    const existing = await client
      .from("tact_execution_attentions")
      .select(ATTENTION_COLUMNS)
      .eq("execution_id", candidate.executionId)
      .maybeSingle();

    if (existing.data) {
      return { status: "already_exists", attention: toExecutionAttention(existing.data as AttentionRow) };
    }

    return {
      status: "error",
      message: existing.error?.message ?? "duplicate claim, but existing attention could not be read",
    };

  }

  return { status: "error", message: error?.message ?? "insert failed" };

}

// =========================
// Lifecycle Transition (SOR-48)
// =========================
//
// 絶対条件(Human Owner指示、Concurrency-safe transitions): read→plan→
// writeの2段階にしない。単一のconditional UPDATE文自体をCAS
// (compare-and-swap)条件として使う——WHERE句にtenant所有権
// (user_id)とallowed source status(遷移元として許容されるstatus)を
// 同時に指定することで、PostgresのUPDATE文自身が「読んだ時点のstatus」
// と「実際に書き込む時点のstatus」の間のrace窓を作らない(同一行への
// 並行UPDATEはrow-level lockで自然に直列化され、後勝ちのUPDATEは
// 先勝ちが確定した後のstatusに対してWHERE句を再評価する——新しい
// locking機構やworkflow基盤を一切追加しない、既存のSQL UPDATE意味論
// だけで安全性を得る)。
//
// affected row数が0件だった場合(所有権不一致/存在しない/既に
// 遷移先を満たさないstatusだった、のいずれか)、単純にnot_foundや
// errorとして扱わず、同じ行をuser_id込みで再読み込みし
// 「今の実際の状態」を返す(絶対条件、Human Owner指示「re-read the
// current owned row and return the correct no-op result」)——これに
// より、繰り返しのacknowledge/resolveは常に安全なidempotent no-op
// になり、resolvedへの到達後は二度と後退しない。

export type AttentionAction = "acknowledge" | "resolve";

// 各actionが許容する遷移元status(絶対条件: acknowledgeはopenからのみ、
// resolveはopen/acknowledgedのどちらからでもよい——直接open→resolvedを
// 認める、Phase3設計どおり)。UPDATE文のWHERE句(`.in("status", ...)`)
// へそのまま渡す。
const ATTENTION_ACTION_ALLOWED_FROM_STATUSES: Record<AttentionAction, readonly AttentionStatus[]> = {
  acknowledge: ["open"],
  resolve: ["open", "acknowledged"],
};

export type TransitionExecutionAttentionOutcome =
  // 実際にstatusが変わった(許容されるsource statusから遷移した)。
  | { status: "transitioned"; attention: ExecutionAttention }
  // 絶対条件(Idempotency): 既に遷移先条件を満たしている(繰り返しの
  // acknowledge/resolve、またはresolved後のacknowledge試行=後退禁止)
  // ——行は変更されないが、エラーでもない。呼び出し元は現在の状態を
  // そのまま使ってよい。
  | { status: "no_op"; attention: ExecutionAttention }
  // 存在しない、または他tenantのAttention(存在有無を区別せず漏らさない、
  // 既存規約)。
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface TransitionExecutionAttentionDeps {

  getClient: typeof getServiceRoleClient;

}

const defaultTransitionDeps: TransitionExecutionAttentionDeps = {
  getClient: getServiceRoleClient,
};

export async function transitionExecutionAttention(
  attentionId: string,
  userId: string,
  action: AttentionAction,
  deps: TransitionExecutionAttentionDeps = defaultTransitionDeps
): Promise<TransitionExecutionAttentionOutcome> {

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const nowIso = new Date().toISOString();
  const allowedFromStatuses = ATTENTION_ACTION_ALLOWED_FROM_STATUSES[action];

  const updatePayload =
    action === "acknowledge"
      ? { status: "acknowledged" as const, acknowledged_at: nowIso, acknowledged_by: userId }
      : { status: "resolved" as const, resolved_at: nowIso, resolved_by: userId };

  // 単一statement CAS(上記コメント参照): id + user_id(tenant所有権、
  // 絶対条件「tenant ownership must remain in every update predicate」)
  // + allowed source status、のすべてを同時にWHERE句へ含める。
  const { data: updatedRow, error: updateError } = await client
    .from("tact_execution_attentions")
    .update(updatePayload)
    .eq("id", attentionId)
    .eq("user_id", userId)
    .in("status", allowedFromStatuses)
    .select(ATTENTION_COLUMNS)
    .maybeSingle();

  if (updateError) {
    return { status: "error", message: updateError.message };
  }

  if (updatedRow) {
    return { status: "transitioned", attention: toExecutionAttention(updatedRow as AttentionRow) };
  }

  // affected 0件: not_found(存在しない/他tenant)か、既に遷移先条件を
  // 満たすno-opか、を区別するために同じ行を再読み込みする(絶対条件、
  // 上記コメント参照)。この再読み込み自体もuser_idで絞り込む——
  // 他tenantの行の存在を漏らさない。
  const { data: currentRow, error: readError } = await client
    .from("tact_execution_attentions")
    .select(ATTENTION_COLUMNS)
    .eq("id", attentionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    return { status: "error", message: readError.message };
  }

  if (!currentRow) {
    return { status: "not_found" };
  }

  return { status: "no_op", attention: toExecutionAttention(currentRow as AttentionRow) };

}

// =========================
// Read Boundary (SOR-52 section10, SOR-54が使う入口)
// =========================
//
// UI-specific formattingはしない(生のtyped fieldのみを返す、SOR-52
// 指示section10)。actor/agent/provider/action/execution status/work_id
// はexecution_id経由でtact_canonical_executionsを都度読む(source of
// truth、上記コメント参照)。permission評価の詳細はpermission_decision_id
// 経由でtact_execution_permission_decisionsを都度読む。

export interface AttentionPermissionEvaluationView {

  status: PermissionDecisionStatus;

  reasonCode: string;

  policyId: string | null;

  evaluatorVersion: string;

  evaluatedAt: string;

}

export interface AttentionItemView {

  attentionId: string;

  executionId: string;

  reason: AttentionReason;

  status: AttentionStatus;

  createdAt: string;

  updatedAt: string;

  permissionEvaluation: AttentionPermissionEvaluationView;

  // 「principal」(SOR-52指示section10)。
  actor: { kind: ExecutionActorKind; id: string | null };

  agentId: string | null;

  // 観測元(provider)と実際の対象system(targetProvider、SOR-52指示の
  // 「target system」)の両方を返す——SOR-51のtargetProvider fix
  // (provider="mcp"/targetProvider="notion"のようなケース)と同じ
  // 区別をread boundaryでも保つ。
  provider: ExecutionProvider;

  targetProvider: ExecutionProvider | null;

  // SOR-44 residual fix Part 1: providerが実体を表せない場合
  // (現状provider="custom"のGitHub)のUI表示name override判定に使う
  // 既存evidence。新しいsemanticsは持たない、既存execution.adapterVersion
  // のそのままの伝播。
  adapterVersion: string;

  action: {
    actionCategory: ExecutionActionCategory;
    operation: string;
    resourceType: string | null;
    resourceIdentifier: string | null;
  };

  executionStatus: ExecutionStatus;

  // SOR-52指示section7: Work correlation(SOR-53)が後から確定させた
  // 最新のworkIdをそのまま返す——Attention行自体はworkIdを持たない
  // ため、常に最新値になる(re-fetchするだけで自動的に反映される)。
  workId: string | null;

  // SOR-18(加算的field): workIdが確定している場合のWork titleを
  // 読み時に都度join(tenant-safe、下記fetchRelatedRecords()参照)。
  // Work自体が読めない(削除済み・所有権不一致等)場合はnull
  // (No-Fabrication、workIdはそのまま残すがtitleだけ空にする)。
  workTitle: string | null;

  // SOR-48(Attention Lifecycle、加算的field)。
  acknowledgedAt: string | null;

  resolvedAt: string | null;

}

function assembleAttentionItemView(
  row: AttentionRow,
  execution: CanonicalExecution,
  decision: PermissionDecision,
  workTitle: string | null
): AttentionItemView {

  return {
    attentionId: row.id,
    executionId: row.execution_id,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissionEvaluation: {
      status: decision.status,
      reasonCode: decision.reasonCode,
      policyId: decision.policyId,
      evaluatorVersion: decision.evaluatorVersion,
      evaluatedAt: decision.evaluatedAt,
    },
    actor: { kind: execution.actorKind, id: execution.actorId },
    agentId: execution.agentId,
    provider: execution.provider,
    targetProvider: execution.targetProvider,
    adapterVersion: execution.adapterVersion,
    action: {
      actionCategory: execution.actionCategory,
      operation: execution.operation,
      resourceType: execution.resourceType,
      resourceIdentifier: execution.resourceIdentifier,
    },
    executionStatus: execution.status,
    workId: execution.workId,
    workTitle,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
  };

}

// executionIds/decisionIdsをbatchで引き、application層でAttention行と
// 組み合わせる(PostgRESTのrelational embeddingには依存しない——
// このrepositoryの他のstore.tsもこの「単純query + application層で
// 組み立て」規約を踏襲しているため、そのまま合わせる)。
//
// 絶対条件(SOR-18、Human Owner指示「Tenant-safe Work title
// enrichment」): workIdはtact_canonical_executionsから読んだ値だが、
// 「Executionのwork_idが正しい(=自分のtenantのWorkを指している)」
// ことを、このWork lookup自身では信用しない——executionsは既に
// `.eq("user_id", userId)`で絞り込み済みだが、Work titleのquery自体に
// も独立して同じ`.eq("user_id", userId)`を課す(defense in depth、
// 破損データ/将来の想定外の参照が他tenantのWork titleを漏らさない
// ようにする)。所有権が一致しないWorkはmapに現れず、呼び出し元は
// workTitle=nullとして扱う(No-Fabrication、workId自体は変えない)。
async function fetchRelatedRecords(
  client: NonNullable<ReturnType<typeof getServiceRoleClient>>,
  userId: string,
  rows: AttentionRow[]
): Promise<{
  executions: Map<string, CanonicalExecution>;
  decisions: Map<string, PermissionDecision>;
  workTitles: Map<string, string | null>;
}> {

  const executionIds = [...new Set(rows.map((r) => r.execution_id))];
  const decisionIds = [...new Set(rows.map((r) => r.permission_decision_id))];

  const [executionsResult, decisionsResult] = await Promise.all([
    executionIds.length > 0
      ? client.from("tact_canonical_executions").select("*").in("id", executionIds).eq("user_id", userId)
      : Promise.resolve({ data: [] as unknown[] }),
    decisionIds.length > 0
      ? client.from("tact_execution_permission_decisions").select("*").in("id", decisionIds)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const executions = new Map<string, CanonicalExecution>();
  for (const row of (executionsResult.data ?? []) as ExecutionRow[]) {
    executions.set(row.id, toCanonicalExecution(row));
  }

  const decisions = new Map<string, PermissionDecision>();
  for (const row of (decisionsResult.data ?? []) as PermissionDecisionRow[]) {
    decisions.set(row.id, toPermissionDecision(row));
  }

  const workIds = [...new Set([...executions.values()].map((e) => e.workId).filter((id): id is string => id !== null))];

  const workTitles = new Map<string, string | null>();

  if (workIds.length > 0) {

    // tenant-safe: id集合だけでなく、明示的なuser_id絞り込みも同時に課す
    // (上記コメント、絶対条件)。
    const { data: workRows } = await client
      .from("tact_works")
      .select("id, title")
      .in("id", workIds)
      .eq("user_id", userId);

    for (const workRow of (workRows ?? []) as Array<{ id: string; title: string | null }>) {
      workTitles.set(workRow.id, workRow.title);
    }

  }

  return { executions, decisions, workTitles };

}

export interface ListExecutionAttentionsOptions {

  // 未指定は全status(SOR-52指示section11「必要ならopenのみfilter可能」)。
  // statusesが指定された場合はこちらを無視する(下記)。
  status?: AttentionStatus;

  // SOR-18(Human Owner指示「Active Inbox read semantics」): 複数status
  // をまとめて指定する(例: active = ["open", "acknowledged"])。
  // statusとstatusesが両方指定された場合はstatusesを優先する
  // ——呼び出し元(API route)はどちらか一方だけを渡す前提。
  statuses?: readonly AttentionStatus[];

  // 既定値はDEFAULT_LIST_LIMIT(下記)。newest firstで、この件数を上限に返す。
  limit?: number;

}

export interface ReadExecutionAttentionsDeps {

  getClient: typeof getServiceRoleClient;

}

const defaultReadDeps: ReadExecutionAttentionsDeps = {
  getClient: getServiceRoleClient,
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

// SOR-52指示section10のlistAttentionItems()相当。tenant境界は明示的な
// `.eq("user_id", userId)`で行う(RLSをAPIの代わりとして扱わない、
// 既存規約)。
export async function listExecutionAttentions(
  userId: string,
  options: ListExecutionAttentionsOptions = {},
  deps: ReadExecutionAttentionsDeps = defaultReadDeps
): Promise<AttentionItemView[]> {

  const client = deps.getClient();

  if (!client) {
    return [];
  }

  const limit = Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);

  let query = client
    .from("tact_execution_attentions")
    .select(ATTENTION_COLUMNS)
    .eq("user_id", userId)
    // SOR-52指示section11: デフォルトはnewest first。
    .order("created_at", { ascending: false })
    .limit(limit);

  if (options.statuses && options.statuses.length > 0) {
    query = query.in("status", options.statuses);
  } else if (options.status) {
    query = query.eq("status", options.status);
  }

  const { data } = await query;
  const rows = (data ?? []) as AttentionRow[];

  if (rows.length === 0) {
    return [];
  }

  const { executions, decisions, workTitles } = await fetchRelatedRecords(client, userId, rows);

  const items: AttentionItemView[] = [];

  for (const row of rows) {

    const execution = executions.get(row.execution_id);
    const decision = decisions.get(row.permission_decision_id);

    // 絶対条件(No-Fabrication): 対応するExecution/Decisionが読めない
    // (他tenant・削除済み等)行は、推測で埋めずに一覧から除外する。
    if (!execution || !decision) {
      continue;
    }

    const workTitle = execution.workId ? workTitles.get(execution.workId) ?? null : null;

    items.push(assembleAttentionItemView(row, execution, decision, workTitle));

  }

  return items;

}

// SOR-52指示section10のgetAttentionItem()相当。
export async function getExecutionAttention(
  attentionId: string,
  userId: string,
  deps: ReadExecutionAttentionsDeps = defaultReadDeps
): Promise<AttentionItemView | undefined> {

  const client = deps.getClient();

  if (!client) {
    return undefined;
  }

  const { data } = await client
    .from("tact_execution_attentions")
    .select(ATTENTION_COLUMNS)
    .eq("id", attentionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) {
    return undefined;
  }

  const row = data as AttentionRow;
  const { executions, decisions, workTitles } = await fetchRelatedRecords(client, userId, [row]);

  const execution = executions.get(row.execution_id);
  const decision = decisions.get(row.permission_decision_id);

  if (!execution || !decision) {
    return undefined;
  }

  const workTitle = execution.workId ? workTitles.get(execution.workId) ?? null : null;

  return assembleAttentionItemView(row, execution, decision, workTitle);

}
