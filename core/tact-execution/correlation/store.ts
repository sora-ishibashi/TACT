// =========================
// TACT Canonical Execution — Work Correlation Decision Store
// (SOR-52, transaction-safe persistence: Final Consistency &
// Concurrency Hardening)
// =========================
//
// core/tact-execution/correlation/配下の唯一のDBアクセス層。supabase/
// migrations/20261025000000_create_execution_work_correlation_rpcs.sql
// が定義するatomic RPC(apply_execution_work_correlation()/
// reclassify_execution_work())を呼ぶだけの薄いwrapper——target Work
// validation・tenant ownership・CAS/optimistic concurrency・summary
// 更新・history追加はすべてDB側のtransaction内で行われる(絶対条件、
// Section1「アプリ層は結果を受け取るだけにする」)。
//
// 以前(SOR-52 Closeout Hardening時点)は「history INSERT →
// correlateExecutionToWork()(summary UPDATE)」という複数queryで
// 構成されており、途中失敗時にhistory/summaryが食い違いうる・複数の
// 同時書き込みに対するrace conditionが残っていた(Codex最終監査、
// High)。このfileはその問題をDB側のtransaction境界へ移すことで解消
// する——correlateExecutionToWork()/updateExecutionCorrelationStatus()/
// 旧reclassifyExecutionWork()(core/tact-execution/store.ts)は、この
// atomicなRPC呼び出しに完全に置き換えられたため削除した。

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import type { JsonValue } from "../../tact-work/approvalIntegrity";
import { computeWorkCorrelationDecisionFingerprint } from "./fingerprint";
import { getExecutionById as defaultGetExecutionById } from "../store";
import type { ExecutionActorKind } from "../types";
import type {
  WorkCorrelationDecision,
  WorkCorrelationMethod,
  WorkCorrelationStatus,
} from "./types";
import { toCanonicalExecutionCorrelationStatus, type CanonicalCorrelationResult } from "./canonicalResult";

export interface WorkCorrelationDecisionRow {

  id: string;

  execution_id: string;

  work_id: string | null;

  status: WorkCorrelationStatus;

  method: WorkCorrelationMethod;

  confidence: number | null;

  reason_code: string;

  correlator_version: string;

  candidate_work_ids: string[] | null;

  metadata: JsonValue | null;

  correlated_at: string;

  previous_work_id: string | null;

  changed_by_actor_kind: ExecutionActorKind | null;

  changed_by_actor_id: string | null;

}

const DECISION_COLUMNS =
  "id, execution_id, work_id, status, method, confidence, reason_code, correlator_version, candidate_work_ids, metadata, correlated_at, previous_work_id, changed_by_actor_kind, changed_by_actor_id";

export function toWorkCorrelationDecision(row: WorkCorrelationDecisionRow): WorkCorrelationDecision {

  return {
    executionId: row.execution_id,
    status: row.status,
    workId: row.work_id,
    method: row.method,
    confidence: row.confidence,
    reasonCode: row.reason_code,
    correlatorVersion: row.correlator_version,
    candidateWorkIds: row.candidate_work_ids,
    metadata: row.metadata,
    correlatedAt: row.correlated_at,
    previousWorkId: row.previous_work_id,
    changedByActorKind: row.changed_by_actor_kind,
    changedByActorId: row.changed_by_actor_id,
  };

}

export interface ValidateWorkCorrelationDecisionResult {
  ok: boolean;
  errors: string[];
}

const METADATA_MAX_SERIALIZED_LENGTH = 4_000;
const SUSPICIOUS_KEY_SUBSTRINGS: readonly string[] = [
  "token", "secret", "password", "credential", "apikey", "api_key", "authorization",
];

function findSuspiciousKeys(value: JsonValue | null | undefined, path = "$"): string[] {

  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSuspiciousKeys(item, `${path}[${index}]`));
  }

  if (typeof value === "object") {

    const found: string[] = [];

    for (const key of Object.keys(value)) {

      const childPath = `${path}.${key}`;

      if (SUSPICIOUS_KEY_SUBSTRINGS.some((s) => key.toLowerCase().includes(s))) {
        found.push(childPath);
      }

      found.push(...findSuspiciousKeys((value as Record<string, JsonValue>)[key], childPath));

    }

    return found;

  }

  return [];

}

// SOR-51のvalidatePermissionDecision()と同じ最小限guard(巨大JSON dump
// 禁止・suspicious key guard)を、この新domain専用に独立して適用する。
// RPC呼び出し前のfail-fast validationとして機能する(絶対条件: 構造的に
// 不正なdecisionをDBまで到達させない)。
export function validateWorkCorrelationDecision(decision: WorkCorrelationDecision): ValidateWorkCorrelationDecisionResult {

  const errors: string[] = [];

  if (decision.status === "matched" && !decision.workId) {
    errors.push("matched decisions must include a workId (Never Guess Rule)");
  }

  if (decision.status !== "matched" && decision.workId) {
    errors.push("non-matched decisions must not include a workId (Never Guess Rule)");
  }

  if (decision.reasonCode.length < 1 || decision.reasonCode.length > 255) {
    errors.push("reasonCode must be between 1 and 255 characters");
  }

  if (decision.correlatorVersion.length < 1 || decision.correlatorVersion.length > 100) {
    errors.push("correlatorVersion must be between 1 and 100 characters");
  }

  if (decision.confidence !== null && (decision.confidence < 0 || decision.confidence > 1)) {
    errors.push("confidence must be between 0 and 1");
  }

  if (decision.metadata !== null && decision.metadata !== undefined) {

    const suspiciousKeys = findSuspiciousKeys(decision.metadata);

    if (suspiciousKeys.length > 0) {
      errors.push(`metadata contains suspicious keys: ${suspiciousKeys.join(", ")}`);
    }

    if (JSON.stringify(decision.metadata).length > METADATA_MAX_SERIALIZED_LENGTH) {
      errors.push(`metadata must serialize to at most ${METADATA_MAX_SERIALIZED_LENGTH} characters`);
    }

  }

  return { ok: errors.length === 0, errors };

}

// apply_execution_work_correlation()が返すjsonbの形(RPC側のコメント
// 参照)。
interface ApplyAutoWorkCorrelationRpcResult {
  outcome: string;
  workId?: string | null;
  currentWorkId?: string | null;
  historyId?: string;
}

export type PersistWorkCorrelationDecisionOutcome =
  | { status: "persisted"; decision: WorkCorrelationDecision }
  // Part3: 同一fingerprint(同一観測・同一correlator version・同一
  // 候補集合・同一結論)の再評価は、新しいhistoryを作らない。
  | { status: "duplicate_decision" }
  // 絶対条件8: このoutcomeの場合、matched historyは一切作られない。
  | { status: "conflict_existing_other_work"; currentWorkId: string }
  // 確定済みmatchをambiguous/unresolvedで上書きしようとした(guardが
  // 正しく機能した結果、historyは作らない)。
  | { status: "already_matched"; workId: string }
  | { status: "invalid"; errors: string[] }
  | { status: "execution_not_found" }
  | { status: "target_work_not_found" }
  | { status: "target_work_not_correlatable" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface PersistWorkCorrelationDecisionDeps {

  getClient: typeof getServiceRoleClient;

}

const defaultDeps: PersistWorkCorrelationDecisionDeps = {
  getClient: getServiceRoleClient,
};

// decisionをtransaction-safeに永続化する(絶対条件、Section1): target
// Work validation・tenant ownership・CAS・summary更新・history追加を
// すべてapply_execution_work_correlation() RPC(単一のtransaction)内
// で行う。この関数自身はfingerprintを計算してRPCへ渡し、結果を
// 判別するだけ。
export async function persistWorkCorrelationDecision(
  decision: WorkCorrelationDecision,
  userId: string,
  deps: PersistWorkCorrelationDecisionDeps = defaultDeps
): Promise<PersistWorkCorrelationDecisionOutcome> {

  const validation = validateWorkCorrelationDecision(decision);

  if (!validation.ok) {
    return { status: "invalid", errors: validation.errors };
  }

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const fingerprint = computeWorkCorrelationDecisionFingerprint(decision);

  const { data, error } = await client.rpc("apply_execution_work_correlation", {
    p_execution_id: decision.executionId,
    p_user_id: userId,
    p_status: decision.status,
    p_method: decision.method,
    p_reason_code: decision.reasonCode,
    p_correlator_version: decision.correlatorVersion,
    p_decision_fingerprint: fingerprint,
    p_target_work_id: decision.workId,
    p_confidence: decision.confidence,
    p_candidate_work_ids: decision.candidateWorkIds ?? null,
    p_metadata: decision.metadata ?? null,
  });

  if (error) {
    return { status: "error", message: error.message };
  }

  const result = data as ApplyAutoWorkCorrelationRpcResult;

  switch (result.outcome) {

    case "correlated":
    case "already_same_work":
    case "updated":
      // RPC自身がhistory/summaryの両方をatomicに確定させた後の値。
      // 入力decisionの内容(method/reasonCode/candidateWorkIds等)は
      // RPCがそのままINSERTしたものと一致するため、再取得せず入力を
      // そのまま返す(不要な追加queryを避ける)。
      return { status: "persisted", decision };

    case "duplicate_decision":
      return { status: "duplicate_decision" };

    case "conflict_existing_other_work":
      return { status: "conflict_existing_other_work", currentWorkId: result.currentWorkId ?? "" };

    case "already_matched":
      return { status: "already_matched", workId: result.workId ?? "" };

    case "execution_not_found":
      return { status: "execution_not_found" };

    case "target_work_not_found":
      return { status: "target_work_not_found" };

    case "target_work_not_correlatable":
      return { status: "target_work_not_correlatable" };

    default:
      return { status: "error", message: `apply_execution_work_correlation returned unexpected outcome: ${result.outcome}` };

  }

}

export async function listWorkCorrelationDecisionsForExecution(
  executionId: string
): Promise<WorkCorrelationDecision[]> {

  const client = getServiceRoleClient();

  if (!client) {
    return [];
  }

  const { data } = await client
    .from("tact_execution_work_correlations")
    .select(DECISION_COLUMNS)
    .eq("execution_id", executionId)
    .order("correlated_at", { ascending: false });

  return (data ?? []).map((row) => toWorkCorrelationDecision(row as WorkCorrelationDecisionRow));

}

// =========================
// listLatestCorrelationDecisionsForExecutions (SOR-77 UX gap fix,
// extended by SOR-23 OBS-UX-P1 for Work Timeline "why" display)
// =========================
//
// live Staging検証で発見したUX gap(SOR-77): 一度manual_overrideで訂正
// したExecution(correlationStatus="matched")は、Activity画面上で
// Review/History導線が完全に消えていた——WorkReference(components/
// tact/runs/badges.tsx)がCORRELATED行では常に「Workへのlinkのみ」を
// 出す既存分岐しか持たなかったため。「この行は人間が訂正したものか」は
// tact_canonical_executions自体には存在しない(絶対条件、SOR-77
// 「do not add duplicate columns」)——既存のappend-only historyから
// 都度導出する。
//
// SOR-23: Work Timelineの「なぜこのExecutionはこのWorkへ割り当てられ
// たか」表示も、method単体ではなくconfidence/reasonCodeまで必要になった
// ため、返り値をWorkCorrelationMethod単体からsummary object全体へ拡張
// した(呼び出し元のActivity/Unassignedは`.method`だけを見ればよく、
// 挙動は変わらない)。
//
// 既存のfetchRelatedRecords()(core/tact-execution/permission/
// attentionStore.ts)と同じ「単純な.in()一括取得 + application層で
// executionId単位に整理」という規約をそのまま踏襲する(PostgRESTの
// relational embeddingや複雑なSQLに依存しない)。correlated_at descで
// 取得するため、同じexecution_idの最初の出現が必ず最新のdecisionになる。
export interface LatestCorrelationDecisionSummary {

  method: WorkCorrelationMethod;

  confidence: number | null;

  reasonCode: string;

}

export async function listLatestCorrelationDecisionsForExecutions(
  executionIds: readonly string[]
): Promise<Map<string, LatestCorrelationDecisionSummary>> {

  const latest = new Map<string, LatestCorrelationDecisionSummary>();

  const uniqueIds = [...new Set(executionIds)];

  if (uniqueIds.length === 0) {
    return latest;
  }

  const client = getServiceRoleClient();

  if (!client) {
    return latest;
  }

  const { data } = await client
    .from("tact_execution_work_correlations")
    .select("execution_id, method, confidence, reason_code, correlated_at")
    .in("execution_id", uniqueIds)
    .order("correlated_at", { ascending: false });

  for (const row of (data ?? []) as Array<{
    execution_id: string;
    method: WorkCorrelationMethod;
    confidence: number | null;
    reason_code: string;
  }>) {

    if (!latest.has(row.execution_id)) {
      latest.set(row.execution_id, { method: row.method, confidence: row.confidence, reasonCode: row.reason_code });
    }

  }

  return latest;

}

// =========================
// getExecutionCorrelationView (SOR-53 Query/Read Boundary)
// =========================
//
// SOR-54(Work Detail/Activity)が使う最小限のread model。UI-specific
// formattingはしない(生のtyped fieldのみ)。product-facing canonical
// wording(CORRELATED/AMBIGUOUS/UNASSIGNED)へこの境界でだけ変換する
// ——domain内部(matched/ambiguous/unresolved)はrenameしない
// (SOR-53指示「Canonical mapping」)。

export interface ExecutionCorrelationView {

  executionId: string;

  workId: string | null;

  correlationStatus: CanonicalCorrelationResult;

  confidence: number | null;

  reasonCode: string | null;

  method: WorkCorrelationMethod | null;

  candidateCount: number | null;

  // SOR-77 (CORRELATION-REVIEW-P1): the actual candidate Work ids behind
  // candidateCount, so a human reviewing a SUGGESTED/UNASSIGNED Execution can
  // see and pick one. Already persisted on every decision (SOR-52) — this
  // was previously only surfaced as a count, never wired through to the read
  // model. Never a source of truth on its own: every candidate was already
  // produced by a tenant-scoped query (structural/temporal stages), and the
  // reclassify RPC re-validates tenant/state independently when one is
  // chosen.
  candidateWorkIds: readonly string[] | null;

  // status=CORRELATEDの場合のみ非null(assign確定時刻)。
  assignedAt: string | null;

  // 最新decisionの評価時刻(status問わず、決定が1件でも存在すれば
  // 非null)。一度もcorrelationが試みられていない場合はnull。
  decidedAt: string | null;

}

export interface GetExecutionCorrelationViewDeps {

  getExecutionById: typeof defaultGetExecutionById;

  listWorkCorrelationDecisionsForExecution: typeof listWorkCorrelationDecisionsForExecution;

}

const defaultGetExecutionCorrelationViewDeps: GetExecutionCorrelationViewDeps = {
  getExecutionById: defaultGetExecutionById,
  listWorkCorrelationDecisionsForExecution,
};


export async function getExecutionCorrelationView(
  executionId: string,
  userId: string,
  deps: GetExecutionCorrelationViewDeps = defaultGetExecutionCorrelationViewDeps
): Promise<ExecutionCorrelationView | undefined> {

  const execution = await deps.getExecutionById(executionId, userId);

  if (!execution) {
    return undefined;
  }

  const decisions = await deps.listWorkCorrelationDecisionsForExecution(executionId);
  // listWorkCorrelationDecisionsForExecution()はcorrelated_at descで
  // 既に並んでいる(store.ts参照)——先頭が最新decision。
  const latest = decisions[0];

  return {
    executionId: execution.id,
    workId: execution.workId,
    correlationStatus: toCanonicalExecutionCorrelationStatus(execution.correlationStatus),
    confidence: latest?.confidence ?? null,
    reasonCode: latest?.reasonCode ?? null,
    method: latest?.method ?? null,
    candidateCount: latest?.candidateWorkIds?.length ?? null,
    candidateWorkIds: latest?.candidateWorkIds ?? null,
    assignedAt: execution.workId ? (latest?.correlatedAt ?? null) : null,
    decidedAt: latest?.correlatedAt ?? null,
  };

}

// =========================
// getExecutionCorrectionContext (SOR-77 CORRELATION-REVIEW-P1)
// =========================
//
// SOR-77指示「do not add duplicate columns if append-only correlation
// history can derive these values reliably」: predictedWorkId/
// predictedConfidence/finalWorkId/decision actor/correction timestampの
// いずれも新しい列を持たない——既存のappend-only tact_execution_work_
// correlations(SOR-52)を読み、historyの中から「最後のmanual_override」
// と「その直前の自動stage決定(explicit/structural/temporal_participant/
// ai_assisted)」を取り出して組み立てるだけの、pure derivationである。
//
// 絶対条件(Never Guess Rule、この関数固有): manual_overrideが一度も
// 無い場合はcorrection=null(推測でcorrectionを作らない)。自動決定が
// 一度も無いまま最初からmanual_overrideされた場合(稀だが実データ上
// あり得る、例: candidateが無いままユーザーが直接assignした場合)は
// predicted=null——存在しない予測を捏造しない。
export interface ExecutionCorrectionPrediction {

  workId: string | null;

  candidateWorkIds: readonly string[] | null;

  confidence: number | null;

  method: WorkCorrelationMethod;

  reasonCode: string;

  correlatedAt: string;

}

export interface ExecutionCorrection {

  finalWorkId: string | null;

  previousWorkId: string | null;

  reasonCode: string;

  changedByActorKind: ExecutionActorKind | null;

  changedByActorId: string | null;

  correlatedAt: string;

}

export interface ExecutionCorrectionContext {

  executionId: string;

  currentWorkId: string | null;

  currentStatus: CanonicalCorrelationResult;

  // The most recent non-manual_override decision — what the system actually
  // suggested. null only when no automatic stage has ever produced a
  // decision for this Execution (never fabricated otherwise).
  predicted: ExecutionCorrectionPrediction | null;

  // The most recent manual_override, if this Execution has ever been
  // human-corrected. null means it has not — "Keep Unassigned" is itself a
  // manual_override (newWorkId=null), so this is never null-vs-Keep-
  // Unassigned ambiguous.
  correction: ExecutionCorrection | null;

  // Every decision ever recorded for this Execution, newest first — the
  // full auditable trail (SOR-77 "Activity/Audit must still expose the
  // prior prediction/correction trail"). Never mutated or deleted by a
  // correction; a correction only appends to it.
  history: WorkCorrelationDecision[];

}

export interface GetExecutionCorrectionContextDeps {

  getExecutionById: typeof defaultGetExecutionById;

  listWorkCorrelationDecisionsForExecution: typeof listWorkCorrelationDecisionsForExecution;

}

const defaultGetExecutionCorrectionContextDeps: GetExecutionCorrectionContextDeps = {
  getExecutionById: defaultGetExecutionById,
  listWorkCorrelationDecisionsForExecution,
};

export async function getExecutionCorrectionContext(
  executionId: string,
  userId: string,
  deps: GetExecutionCorrectionContextDeps = defaultGetExecutionCorrectionContextDeps
): Promise<ExecutionCorrectionContext | undefined> {

  const execution = await deps.getExecutionById(executionId, userId);

  if (!execution) {
    return undefined;
  }

  // 既にcorrelated_at descで並んでいる(listWorkCorrelationDecisionsForExecution()参照)。
  const history = await deps.listWorkCorrelationDecisionsForExecution(executionId);

  // 絶対条件(重要なedge case): correlationStatusが"matched"でない限り
  // (例: 人間が"Keep Unassigned"を選んだ後)、duplicate webhook配信等に
  // よる自動pipelineの再評価はブロックされない(observeExecutionWorkCorrelation()
  // のguardはcorrelationStatus==="matched"のみを見る)——つまりmanual_
  // override**より後**に新しい自動decisionが積まれることがあり得る。
  // predictedは「この訂正の直前に何が提示されていたか」を表すべきで
  // あり、単に「manual_override以外で最新のdecision」を拾うと、訂正の
  // 後で起きた無関係な自動再評価を「予測」として誤表示しかねない
  // (correctionより後のdecisionは検索対象から除外する)。
  const correctionIndex = history.findIndex((d) => d.method === "manual_override");
  const correction = correctionIndex >= 0 ? history[correctionIndex] : undefined;

  const predictedSearchSpace = correctionIndex >= 0 ? history.slice(correctionIndex + 1) : history;
  const predictedDecision = predictedSearchSpace.find((d) => d.method !== "manual_override");

  return {
    executionId: execution.id,
    currentWorkId: execution.workId,
    currentStatus: toCanonicalExecutionCorrelationStatus(execution.correlationStatus),
    predicted: predictedDecision
      ? {
          workId: predictedDecision.workId,
          candidateWorkIds: predictedDecision.candidateWorkIds,
          confidence: predictedDecision.confidence,
          method: predictedDecision.method,
          reasonCode: predictedDecision.reasonCode,
          correlatedAt: predictedDecision.correlatedAt,
        }
      : null,
    correction: correction
      ? {
          finalWorkId: correction.workId,
          previousWorkId: correction.previousWorkId ?? null,
          reasonCode: correction.reasonCode,
          changedByActorKind: correction.changedByActorKind ?? null,
          changedByActorId: correction.changedByActorId ?? null,
          correlatedAt: correction.correlatedAt,
        }
      : null,
    history,
  };

}

// =========================
// persistManualWorkCorrelationOverride (Manual Override, Part4/5)
// =========================
//
// auto pipeline(persistWorkCorrelationDecision())とは明確に分離された
// 入口。reclassify_execution_work() RPC(単一transaction、optimistic
// concurrency込み)を呼ぶだけの薄いwrapper。
//
// 曖昧な汎用update関数にしない(絶対条件): 呼び出し元はnewWorkId
// (nullable、Workを外す操作を許容)・expectedPreviousWorkId
// (optimistic concurrency)・changedBy・reasonCodeを必須の名前付き
// 引数として渡す。

export interface PersistManualWorkCorrelationOverrideInput {

  executionId: string;

  userId: string;

  // Optimistic Concurrency(絶対条件、Part4、最重要): 呼び出し元が
  // 「自分が最後に見た」work_id。未割当を期待する場合はnull。行lock後
  // の実際のwork_idと一致しなければstale_revisionとして拒否される
  // ——2人が同時にmanual overrideしても両方成功にはならない。
  expectedPreviousWorkId: string | null;

  // null = Workの割り当てを外す(絶対条件、Part3「Workを外す操作」)。
  newWorkId: string | null;

  changedBy: { kind: ExecutionActorKind; id: string | null };

  reasonCode: string;

  metadata?: JsonValue | null;

}

interface ReclassifyExecutionWorkRpcResult {
  outcome: string;
  workId?: string | null;
  correlationStatus?: string;
  previousWorkId?: string | null;
  actualWorkId?: string | null;
  historyId?: string;
}

export type PersistManualWorkCorrelationOverrideOutcome =
  | { status: "reclassified"; decision: WorkCorrelationDecision; previousWorkId: string | null }
  // 絶対条件(Part4): expectedPreviousWorkIdが実際の現在値と一致しない
  // (=呼び出し元が古い状態を前提にしていた)場合、書き込まずに拒否する。
  | { status: "stale_revision"; actualWorkId: string | null }
  | { status: "execution_not_found" }
  | { status: "target_work_not_found" }
  | { status: "target_work_not_correlatable" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface PersistManualWorkCorrelationOverrideDeps {

  getClient: typeof getServiceRoleClient;

}

const defaultManualOverrideDeps: PersistManualWorkCorrelationOverrideDeps = {
  getClient: getServiceRoleClient,
};

const MANUAL_OVERRIDE_CORRELATOR_VERSION = "manual-override-v1";

export async function persistManualWorkCorrelationOverride(
  input: PersistManualWorkCorrelationOverrideInput,
  deps: PersistManualWorkCorrelationOverrideDeps = defaultManualOverrideDeps
): Promise<PersistManualWorkCorrelationOverrideOutcome> {

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const { data, error } = await client.rpc("reclassify_execution_work", {
    p_execution_id: input.executionId,
    p_user_id: input.userId,
    p_expected_previous_work_id: input.expectedPreviousWorkId,
    p_new_work_id: input.newWorkId,
    p_changed_by_actor_kind: input.changedBy.kind,
    p_changed_by_actor_id: input.changedBy.id,
    p_reason_code: input.reasonCode,
    p_metadata: input.metadata ?? null,
  });

  if (error) {
    return { status: "error", message: error.message };
  }

  const result = data as ReclassifyExecutionWorkRpcResult;

  switch (result.outcome) {

    case "reclassified": {

      const decision: WorkCorrelationDecision = {
        executionId: input.executionId,
        status: (result.correlationStatus as WorkCorrelationStatus) ?? (input.newWorkId ? "matched" : "unresolved"),
        workId: result.workId ?? null,
        method: "manual_override",
        confidence: null,
        reasonCode: input.reasonCode,
        correlatorVersion: MANUAL_OVERRIDE_CORRELATOR_VERSION,
        candidateWorkIds: null,
        metadata: input.metadata ?? null,
        correlatedAt: new Date().toISOString(),
        previousWorkId: result.previousWorkId ?? null,
        changedByActorKind: input.changedBy.kind,
        changedByActorId: input.changedBy.id,
      };

      return { status: "reclassified", decision, previousWorkId: result.previousWorkId ?? null };

    }

    case "stale_revision":
      return { status: "stale_revision", actualWorkId: result.actualWorkId ?? null };

    case "execution_not_found":
      return { status: "execution_not_found" };

    case "target_work_not_found":
      return { status: "target_work_not_found" };

    case "target_work_not_correlatable":
      return { status: "target_work_not_correlatable" };

    default:
      return { status: "error", message: `reclassify_execution_work returned unexpected outcome: ${result.outcome}` };

  }

}
