// =========================
// TACT Canonical Execution Store (SOR-50)
// =========================
//
// core/tact-execution/配下の唯一のDBアクセス層。supabase/migrations/
// 20261020000000_create_tact_canonical_executions.sqlを対象とする。
//
// 既存store.ts(core/tact-work/store.ts・core/tact-integration/
// connection.ts)との重要な違い: これらは常にuser本人のaccess_token
// (Authorization headerを持つrequest-scoped client)を使うが、
// tact_canonical_executionsへの書き込みは常にAdapter(webhook/poll/
// manual report等)経由であり、生きたuser browser sessionを前提
// できない。これはcore/tact-bot/execution/trustedConversationTurn.ts
// が「Trusted Bot Execution Boundary」として確立した既存パターン
// (service role client + 呼び出し元がidentity resolverで解決済みの
// userIdを渡す + application層で明示的に`.eq("user_id", userId)`する)
// と同じ状況であるため、同じ設計を踏襲する(core/database/
// supabaseServiceRole.tsのallowlistへこのfileを追加する)。
//
// 絶対条件(RLSをAPIの代わりとして扱わない、既存方針そのまま):
// service role clientはRLSを常にbypassするため、全関数が明示的に
// `.eq("user_id", userId)`を伴うクエリを組み立てる。

import { getServiceRoleClient, getServiceRoleKey } from "../database/supabaseServiceRole";
import { getWork } from "../tact-work/store";
import type { Work, WorkStatus } from "../tact-work/types";
import type { JsonValue } from "../tact-work/approvalIntegrity";
import { validateCaptureExecutionInput } from "./validation";
import type {
  CanonicalExecution,
  CaptureExecutionInput,
  ExecutionActorKind,
  ExecutionActionCategory,
  ExecutionCorrelationStatus,
  ExecutionPermissionStatus,
  ExecutionProvider,
  ExecutionSourceType,
  ExecutionStatus,
} from "./types";

// PostgreSQL/PostgRESTのunique_violationエラーコード(tact_bot_processed_events
// のclaimExternalEvent()と同じ判定)。
const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";

// SOR-52 Closeout Hardening Part1(Harden correlateExecutionToWork Tenant
// Boundary): auto correlation(captureExecution時のworkId・
// correlateExecutionToWork()のいずれも)が対象にしてよいWork状態。
// completed/failed/cancelledは「既に終わったWork」であり、新しい
// Executionを自動で紐付けるべきではない(絶対条件)。manual
// reclassification(reclassifyExecutionWork())はこのguardの対象外
// ——人間が明示的に意図して行う操作であるため。
export const WORK_TERMINAL_STATUSES: readonly WorkStatus[] = ["completed", "failed", "cancelled"];

export type ResolveTargetWorkForCorrelationResult =
  | { ok: true; work: Work }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_correlatable" };

export interface ResolveTargetWorkForCorrelationDeps {

  getWork: typeof getWork;

  getServiceRoleKey: typeof getServiceRoleKey;

}

export const defaultResolveTargetWorkForCorrelationDeps: ResolveTargetWorkForCorrelationDeps = {
  getWork,
  getServiceRoleKey,
};

// captureExecution()(workId指定時)とcorrelateExecutionToWork()の両方
// から使う共有helper(絶対条件、Part1: 「candidate resolverが安全
// だから大丈夫」とはしない——低レベルprimitive自身がtenant/state
// validationを行う)。core/tact-work/store.tsのgetWork()は「存在しない」
// 「所有者不一致」のいずれもundefinedを返す既存規約(所有者不一致を
// 外部へ漏らさない、getConversation()等と同じ設計)をそのまま踏襲する
// ——このhelperもその2つをnot_foundとして統一する(絶対条件: 他tenant
// のWork存在有無を漏らさない)。
export async function resolveTargetWorkForCorrelation(
  workId: string,
  userId: string,
  deps: ResolveTargetWorkForCorrelationDeps = defaultResolveTargetWorkForCorrelationDeps
): Promise<ResolveTargetWorkForCorrelationResult> {

  const accessToken = deps.getServiceRoleKey();

  if (!accessToken) {
    return { ok: false, reason: "not_found" };
  }

  // SOR-74: getWork() throws on a malformed workId (e.g. a non-UUID string
  // fails Postgres's `uuid` column comparison) instead of returning
  // undefined. Left uncaught, that exception would propagate out of
  // captureExecution() and abort the entire capture — contradicting this
  // function's own contract (existence and ownership are indistinguishable,
  // both fail closed as not_found) and the Capture First principle that a
  // bad workId must never drop the Execution itself.
  let work;

  try {
    work = await deps.getWork(workId, userId, accessToken);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  if (!work) {
    return { ok: false, reason: "not_found" };
  }

  if (WORK_TERMINAL_STATUSES.includes(work.status)) {
    return { ok: false, reason: "not_correlatable" };
  }

  return { ok: true, work };

}

export interface ExecutionRow {

  id: string;

  user_id: string;

  organization_id: string | null;

  workspace_id: string | null;

  work_id: string | null;

  correlation_status: ExecutionCorrelationStatus;

  connection_id: string | null;

  actor_kind: ExecutionActorKind;

  actor_id: string | null;

  agent_id: string | null;

  on_behalf_of_actor_kind: ExecutionActorKind | null;

  on_behalf_of_actor_id: string | null;

  provider: ExecutionProvider;

  source_type: ExecutionSourceType;

  external_event_id: string;

  adapter_version: string;

  source_metadata: JsonValue | null;

  raw_payload_ref: string | null;

  action_category: ExecutionActionCategory;

  operation: string;

  resource_type: string | null;

  resource_identifier: string | null;

  target_provider: ExecutionProvider | null;

  status: ExecutionStatus;

  error_code: string | null;

  error_message: string | null;

  permission_status: ExecutionPermissionStatus;

  permission_reason_code: string | null;

  permission_evaluated_at: string | null;

  provider_occurred_at: string | null;

  observed_at: string;

  persisted_at: string;

  updated_at: string;

}

// 単一のstring literalとして宣言する(core/tact-work/store.tsのWORK_COLUMNS
// と同じ規約)。`+`によるconcatenationはTSの型をnarrow literal typeから
// `string`へ widenさせ、supabase-jsの`.select<Query extends string>()`
// によるcolumn型推論を壊してしまう(GenericStringErrorへ falls back
// する)ため、必ず1つの文字列literalのまま保つ。
const EXECUTION_COLUMNS =
  "id, user_id, organization_id, workspace_id, work_id, correlation_status, connection_id, actor_kind, actor_id, agent_id, on_behalf_of_actor_kind, on_behalf_of_actor_id, provider, source_type, external_event_id, adapter_version, source_metadata, raw_payload_ref, action_category, operation, resource_type, resource_identifier, target_provider, status, error_code, error_message, permission_status, permission_reason_code, permission_evaluated_at, provider_occurred_at, observed_at, persisted_at, updated_at";

export function toCanonicalExecution(row: ExecutionRow): CanonicalExecution {

  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    workId: row.work_id,
    correlationStatus: row.correlation_status,
    connectionId: row.connection_id,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    agentId: row.agent_id,
    onBehalfOfActorKind: row.on_behalf_of_actor_kind,
    onBehalfOfActorId: row.on_behalf_of_actor_id,
    provider: row.provider,
    sourceType: row.source_type,
    externalEventId: row.external_event_id,
    adapterVersion: row.adapter_version,
    sourceMetadata: row.source_metadata,
    rawPayloadRef: row.raw_payload_ref,
    actionCategory: row.action_category,
    operation: row.operation,
    resourceType: row.resource_type,
    resourceIdentifier: row.resource_identifier,
    targetProvider: row.target_provider,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    permissionStatus: row.permission_status,
    permissionReasonCode: row.permission_reason_code,
    permissionEvaluatedAt: row.permission_evaluated_at,
    providerOccurredAt: row.provider_occurred_at,
    observedAt: row.observed_at,
    persistedAt: row.persisted_at,
    updatedAt: row.updated_at,
  };

}

export type CaptureExecutionOutcome =
  | { status: "captured"; execution: CanonicalExecution }
  // 絶対条件(Idempotency): 同一(user_id, provider, external_event_id)
  // による再送は、新しい行を作らず既存行をそのまま返す。
  | { status: "duplicate"; execution: CanonicalExecution }
  | { status: "invalid"; errors: string[] }
  | { status: "unavailable" }
  | { status: "error"; message: string };

// テスト用DI seam(WorkOwnershipDepsと同じ考え方): 実Supabase接続
// 無しに、初回claim成功/unique_violation(23505)による重複検出の両方の
// 分岐を決定論的に検証できるようにする(SOR-50 Tests要件「duplicate
// event」)。既定値は実service role client。
//
// SOR-52 Closeout Hardening Part1(Capture時workId): CaptureExecutionInput.
// workIdを直接設定できる既存経路(将来のcore/tact-runtime等、capture
// 時点で既にworkIdを把握しているtrusted adapterを想定)に対しても、
// resolveTargetWorkForCorrelation()と同じtenant/state validationを
// 適用する——「trusted internal pathだから安全」という前提だけに
// 依存しない(絶対条件)。
export interface CaptureExecutionDeps {

  getClient: typeof getServiceRoleClient;

  resolveTargetWorkForCorrelation: typeof resolveTargetWorkForCorrelation;

}

const defaultCaptureExecutionDeps: CaptureExecutionDeps = {
  getClient: getServiceRoleClient,
  resolveTargetWorkForCorrelation,
};

export async function captureExecution(
  input: CaptureExecutionInput,
  deps: CaptureExecutionDeps = defaultCaptureExecutionDeps
): Promise<CaptureExecutionOutcome> {

  const validation = validateCaptureExecutionInput(input);

  if (!validation.ok) {
    return { status: "invalid", errors: validation.errors };
  }

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const observedAt = input.observedAt ?? new Date().toISOString();

  // 絶対条件(Part1、Never Guess Rule/tenant safety): workIdが指定
  // されている場合でも、そのまま信用してinsertしない。対象Workが
  // 存在し・同じuserIdに属し・auto-correlatable(非terminal)状態で
  // ある場合のみ、そのworkIdをwork_id列へ記録する。検証に失敗した
  // 場合はcapture自体を拒否せず(Capture First原則)、workIdを落として
  // 観測を続ける——ただしsilent dropにはせず、構造化ログを残す。
  //
  // correlation_status自体はここでは設定しない(DB default 'pending'
  // のまま)——「work_idが既に入っている」という事実の記録と、
  // 「Work Correlation pipelineがその事実を評価してhistoryへ記録する」
  // 責務を分離するため(絶対条件、Part4: history/current summaryの
  // 整合性)。work_id有りでcorrelation_status='pending'のExecutionは、
  // core/tact-execution/correlation/stages/explicit.tsが検出し、通常の
  // observeExecutionWorkCorrelation()経路でhistory行(method=
  // 'explicit')が作られたうえでcorrelation_status='matched'へ遷移する
  // ——captureExecution自身がhistoryを直接書かない。
  let resolvedWorkId: string | null = null;

  if (input.workId) {

    const resolution = await deps.resolveTargetWorkForCorrelation(input.workId, input.userId);

    if (resolution.ok) {
      resolvedWorkId = input.workId;
    } else {
      console.warn(
        "[tact-execution/store] captureExecution(): 指定されたworkIdの検証に失敗したため、" +
        `capture自体は継続しworkIdを落とす(reason=${resolution.reason})。` +
        "誤ったtenant/terminal-status Workへの自動紐付けを避けるため(絶対条件)。"
      );
    }

  }

  const { data, error } = await client
    .from("tact_canonical_executions")
    .insert({
      user_id: input.userId,
      organization_id: input.organizationId ?? null,
      workspace_id: input.workspaceId ?? null,
      work_id: resolvedWorkId,
      connection_id: input.connectionId ?? null,
      actor_kind: input.actorKind,
      actor_id: input.actorId ?? null,
      agent_id: input.agentId ?? null,
      on_behalf_of_actor_kind: input.onBehalfOfActorKind ?? null,
      on_behalf_of_actor_id: input.onBehalfOfActorId ?? null,
      provider: input.provider,
      source_type: input.sourceType,
      external_event_id: input.externalEventId,
      adapter_version: input.adapterVersion,
      source_metadata: input.sourceMetadata ?? null,
      raw_payload_ref: input.rawPayloadRef ?? null,
      action_category: input.actionCategory,
      operation: input.operation,
      resource_type: input.resourceType ?? null,
      resource_identifier: input.resourceIdentifier ?? null,
      target_provider: input.targetProvider ?? null,
      status: input.status ?? "observed",
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
      // SOR-51で明確化: captureExecution()時点はまだ何も評価していない
      // ため既定値は"pending"(未評価)であり、"unknown"(評価した結果
      // 判定できなかった)とは意味が異なる。DB CHECK制約
      // (permission_status)は両方とも許容するため、column defaultの
      // migration変更は不要(このINSERTが常に明示的に値を渡すため、
      // DB defaultは実質到達しない)。
      permission_status: input.permissionStatus ?? "pending",
      provider_occurred_at: input.providerOccurredAt ?? null,
      observed_at: observedAt,
    })
    .select(EXECUTION_COLUMNS)
    .single();

  if (!error && data) {
    return { status: "captured", execution: toCanonicalExecution(data as ExecutionRow) };
  }

  if (error && (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_CODE) {

    const existing = await client
      .from("tact_canonical_executions")
      .select(EXECUTION_COLUMNS)
      .eq("user_id", input.userId)
      .eq("provider", input.provider)
      .eq("external_event_id", input.externalEventId)
      .maybeSingle();

    if (existing.data) {
      return { status: "duplicate", execution: toCanonicalExecution(existing.data as ExecutionRow) };
    }

    return { status: "error", message: existing.error?.message ?? "duplicate claim, but existing row could not be read" };

  }

  return { status: "error", message: error?.message ?? "insert failed" };

}

// SOR-52 Closeout Hardening: 第3引数(client)はcorrelateExecutionToWork()/
// reclassifyExecutionWork()が自分自身のdeps.getClient()で既に解決した
// clientをそのまま渡せるようにするための、後方互換な拡張(省略時は
// 既存どおりgetServiceRoleClient()を直接呼ぶ、既存呼び出し元の挙動は
// 一切変えない)。
export async function getExecutionById(
  id: string,
  userId: string,
  client: ReturnType<typeof getServiceRoleClient> = getServiceRoleClient()
): Promise<CanonicalExecution | undefined> {

  if (!client) {
    return undefined;
  }

  const { data } = await client
    .from("tact_canonical_executions")
    .select(EXECUTION_COLUMNS)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) {
    return undefined;
  }

  return toCanonicalExecution(data as ExecutionRow);

}

export async function listExecutionsForWork(workId: string, userId: string): Promise<CanonicalExecution[]> {

  const client = getServiceRoleClient();

  if (!client) {
    return [];
  }

  const { data } = await client
    .from("tact_canonical_executions")
    .select(EXECUTION_COLUMNS)
    .eq("work_id", workId)
    .eq("user_id", userId)
    .order("persisted_at", { ascending: true });

  return (data ?? []).map((row) => toCanonicalExecution(row as ExecutionRow));

}

// SOR-54(Activity screen)向けの読み取り専用query。listExecutionsForWork()
// と同じ設計方針(service role client、明示的な`.eq("user_id", userId)`)
// だが、work_idで絞り込まず、そのuserの全Executionをnewest firstで返す。
// SOR-52のlistExecutionAttentions()と同じ「pagination複雑化しない、
// 固定limit」方針を踏襲する。
export interface ListExecutionsForUserOptions {
  limit?: number;

  // SOR-46(Unassigned/Ambiguous read surface): 未指定は全correlation_status
  // (既存listExecutionsForUser()の挙動を変えない、加算的option)。指定時は
  // その集合だけへ絞り込む——別のqueryやread modelを新設せず、既存の
  // Canonical Execution Ledgerに対するfilterを1つ足すだけに留める
  // (絶対条件「Do not create duplicate state or a parallel queue model」)。
  correlationStatuses?: readonly ExecutionCorrelationStatus[];
}

const DEFAULT_LIST_EXECUTIONS_FOR_USER_LIMIT = 100;
const MAX_LIST_EXECUTIONS_FOR_USER_LIMIT = 200;

export async function listExecutionsForUser(
  userId: string,
  options: ListExecutionsForUserOptions = {}
): Promise<CanonicalExecution[]> {

  const client = getServiceRoleClient();

  if (!client) {
    return [];
  }

  const limit = Math.min(options.limit ?? DEFAULT_LIST_EXECUTIONS_FOR_USER_LIMIT, MAX_LIST_EXECUTIONS_FOR_USER_LIMIT);

  let query = client
    .from("tact_canonical_executions")
    .select(EXECUTION_COLUMNS)
    .eq("user_id", userId)
    .order("persisted_at", { ascending: false })
    .limit(limit);

  if (options.correlationStatuses && options.correlationStatuses.length > 0) {
    query = query.in("correlation_status", options.correlationStatuses);
  }

  const { data } = await query;

  return (data ?? []).map((row) => toCanonicalExecution(row as ExecutionRow));

}

// SOR-52 Final Consistency & Concurrency Hardening: correlateExecutionToWork()/
// updateExecutionCorrelationStatus()/reclassifyExecutionWork()(旧、
// app層での複数query構成)はここにあったが、target Work validation・
// tenant ownership・CAS/optimistic concurrency・summary更新・history
// 追加を単一transactionで行うDB側RPC(apply_execution_work_correlation()/
// reclassify_execution_work()、supabase/migrations/
// 20261025000000_create_execution_work_correlation_rpcs.sql)へ完全に
// 置き換えたため削除した。呼び出し元はcore/tact-execution/correlation/
// store.tsのpersistWorkCorrelationDecision()/
// persistManualWorkCorrelationOverride()を使う(このfileはtact_canonical_
// executions単体のcapture/read/permission summaryにのみ責務を残す)。

export interface UpdatePermissionContextInput {

  status: ExecutionPermissionStatus;

  reasonCode?: string | null;

}

export type UpdatePermissionContextOutcome =
  | { status: "updated"; execution: CanonicalExecution }
  | { status: "not_found" }
  | { status: "unavailable" };

// SOR-51 Permission Engineが接続する入口。
export async function updateExecutionPermissionContext(
  executionId: string,
  userId: string,
  input: UpdatePermissionContextInput
): Promise<UpdatePermissionContextOutcome> {

  const client = getServiceRoleClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const { data } = await client
    .from("tact_canonical_executions")
    .update({
      permission_status: input.status,
      permission_reason_code: input.reasonCode ?? null,
      permission_evaluated_at: new Date().toISOString(),
    })
    .eq("id", executionId)
    .eq("user_id", userId)
    .select(EXECUTION_COLUMNS)
    .maybeSingle();

  if (!data) {
    return { status: "not_found" };
  }

  return { status: "updated", execution: toCanonicalExecution(data as ExecutionRow) };

}
