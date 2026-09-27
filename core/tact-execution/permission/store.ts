// =========================
// TACT Canonical Execution — Permission Decision Store (SOR-51)
// =========================
//
// core/tact-execution/permission/配下の唯一のDBアクセス層。supabase/
// migrations/20261021000000_create_tact_execution_permission_decisions.sql
// を対象とする。core/tact-execution/store.tsと同じ理由(書き込みは常に
// Permission Evaluator経由、生きたuser browser sessionを前提できない
// trust boundary)でservice role clientを使う——core/database/
// supabaseServiceRole.tsのallowlistへこのfileも追加する。
//
// 絶対条件(Idempotency/Re-evaluation): (execution_id, evaluator_version,
// policy_id)への一意indexへ直接INSERTを試み、unique_violation(23505)を
// 「既に同じ評価が記録済み」として判定する(captureExecution()と同じ
// atomic claim方式、SELECTしてから無ければINSERTという2段の方式は
// 使わない)。

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import type { JsonValue } from "../../tact-work/approvalIntegrity";
import { updateExecutionPermissionContext } from "../store";
import { validatePermissionDecision } from "./evaluate";
import { NO_MATCHING_POLICY_ID, type PermissionDecision, type PermissionDecisionStatus } from "./types";

const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";

export interface PermissionDecisionRow {

  id: string;

  execution_id: string;

  status: PermissionDecisionStatus;

  reason_code: string;

  policy_id: string;

  evaluator_version: string;

  metadata: JsonValue | null;

  evaluated_at: string;

  // SOR-47(Permission Registry v1-minimal): 静的allowlist経由の行では
  // 常にnull。Registry経由(evaluatePermissionWithRules())の行のみ、
  // match時点のtact_execution_permission_rules行のidとrevisionを持つ
  // (types.tsのPermissionDecision.registryRuleId/registryRuleRevision
  // コメント参照)。
  registry_rule_id: string | null;

  registry_rule_revision: number | null;

}

const DECISION_COLUMNS =
  "id, execution_id, status, reason_code, policy_id, evaluator_version, metadata, evaluated_at, registry_rule_id, registry_rule_revision";

export function toPermissionDecision(row: PermissionDecisionRow): PermissionDecision {

  return {
    executionId: row.execution_id,
    status: row.status,
    reasonCode: row.reason_code,
    // DB格納時のsentinel(NO_MATCHING_POLICY_ID)を、公開domain型では
    // 「実際には何もmatchしなかった」ことを正直に表すnullへ戻す
    // (types.tsのPermissionDecision.policyIdコメント参照)。
    policyId: row.policy_id === NO_MATCHING_POLICY_ID ? null : row.policy_id,
    evaluatorVersion: row.evaluator_version,
    metadata: row.metadata,
    evaluatedAt: row.evaluated_at,
    registryRuleId: row.registry_rule_id,
    registryRuleRevision: row.registry_rule_revision,
  };

}

// SOR-52 Closeout Hardening Part7(Permission Summary Consistency):
// history insertは成功したが、tact_canonical_executions側のsummary列
// (permission_status/permission_reason_code/permission_evaluated_at)
// への反映が失敗した場合を、単純な"persisted"/"already_evaluated"とは
// 区別できる形で返す——SOR-53がsummaryだけを見て誤った表示をしない
// ようにする(絶対条件)。
export type PersistPermissionDecisionOutcome =
  // decisionId(SOR-52追加): 実際に永続化されたdecision行のid。
  // PermissionDecision(domain型)自体はid未確定(evaluatePermission()
  // 単体の出力には行がまだ無い)状態でも作れるため、idはこのstorage層の
  // 出力(行が実在する3variantのみ)にだけ持たせる——SOR-52の
  // Attention(tact_execution_attentions.permission_decision_id)が
  // このidを参照する。
  | { status: "persisted"; decision: PermissionDecision; decisionId: string }
  // 絶対条件(Idempotency/Re-evaluation): 同一evaluator_version×policy_id
  // での再評価は、新しい行を作らず既存行をそのまま返す。
  | { status: "already_evaluated"; decision: PermissionDecision; decisionId: string }
  | { status: "persisted_summary_sync_failed"; decision: PermissionDecision; decisionId: string; summarySyncStatus: string }
  | { status: "invalid"; errors: string[] }
  | { status: "execution_not_found" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface PersistPermissionDecisionDeps {

  getClient: typeof getServiceRoleClient;

  updateExecutionPermissionContext: typeof updateExecutionPermissionContext;

}

const defaultDeps: PersistPermissionDecisionDeps = {
  getClient: getServiceRoleClient,
  updateExecutionPermissionContext,
};

// decisionを永続化し、続けてtact_canonical_executions側のsummary列
// (permission_status/permission_reason_code/permission_evaluated_at、
// SOR-50で確立済みのupdateExecutionPermissionContext()をそのまま
// 再利用する——重複実装を増やさない)を更新する。
export async function persistPermissionDecision(
  decision: PermissionDecision,
  userId: string,
  deps: PersistPermissionDecisionDeps = defaultDeps
): Promise<PersistPermissionDecisionOutcome> {

  const validation = validatePermissionDecision(decision);

  if (!validation.ok) {
    return { status: "invalid", errors: validation.errors };
  }

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const policyIdForStorage = decision.policyId ?? NO_MATCHING_POLICY_ID;

  const { data, error } = await client
    .from("tact_execution_permission_decisions")
    .insert({
      execution_id: decision.executionId,
      status: decision.status,
      reason_code: decision.reasonCode,
      policy_id: policyIdForStorage,
      evaluator_version: decision.evaluatorVersion,
      metadata: decision.metadata ?? null,
      evaluated_at: decision.evaluatedAt,
      registry_rule_id: decision.registryRuleId ?? null,
      registry_rule_revision: decision.registryRuleRevision ?? null,
    })
    .select(DECISION_COLUMNS)
    .single();

  let persisted: PermissionDecision;
  let persistedId: string;
  let outcomeStatus: "persisted" | "already_evaluated";

  if (!error && data) {

    persisted = toPermissionDecision(data as PermissionDecisionRow);
    persistedId = (data as PermissionDecisionRow).id;
    outcomeStatus = "persisted";

  } else if (error && (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_CODE) {

    const existing = await client
      .from("tact_execution_permission_decisions")
      .select(DECISION_COLUMNS)
      .eq("execution_id", decision.executionId)
      .eq("evaluator_version", decision.evaluatorVersion)
      .eq("policy_id", policyIdForStorage)
      .maybeSingle();

    if (!existing.data) {
      return {
        status: "error",
        message: existing.error?.message ?? "duplicate claim, but existing decision could not be read",
      };
    }

    persisted = toPermissionDecision(existing.data as PermissionDecisionRow);
    persistedId = (existing.data as PermissionDecisionRow).id;
    outcomeStatus = "already_evaluated";

  } else if (error && (error as { code?: string }).code === "23503") {

    // FK違反(execution_idが存在しない)。fail closedでnot_foundを返す
    // ——存在しないExecutionへ評価結果を紐付けない。
    return { status: "execution_not_found" };

  } else {

    return { status: "error", message: error?.message ?? "insert failed" };

  }

  // summary列の更新失敗はdecision永続化自体を取り消さない
  // (core/tact-work/audit.tsのemitAuditSafely()と同じ精神: 補助的な
  // 反映の失敗を、既に確定した主操作の失敗へ昇格させない)。ただし
  // silentには握り潰さない。
  const summaryOutcome = await deps.updateExecutionPermissionContext(decision.executionId, userId, {
    status: persisted.status,
    reasonCode: persisted.reasonCode,
  });

  if (summaryOutcome.status !== "updated") {

    console.warn(
      "[tact-execution/permission/store] persistPermissionDecision(): " +
      `updateExecutionPermissionContext()がupdated以外を返した(status=${summaryOutcome.status})。` +
      "decision自体は既に確定済みのため、この境界での失敗によって取り消しは行わないが、" +
      "呼び出し元が不整合を識別できるよう、persisted_summary_sync_failedとして報告する。"
    );

    return {
      status: "persisted_summary_sync_failed",
      decision: persisted,
      decisionId: persistedId,
      summarySyncStatus: summaryOutcome.status,
    };

  }

  return { status: outcomeStatus, decision: persisted, decisionId: persistedId };

}

export async function listPermissionDecisionsForExecution(
  executionId: string
): Promise<PermissionDecision[]> {

  const client = getServiceRoleClient();

  if (!client) {
    return [];
  }

  const { data } = await client
    .from("tact_execution_permission_decisions")
    .select(DECISION_COLUMNS)
    .eq("execution_id", executionId)
    .order("evaluated_at", { ascending: false });

  return (data ?? []).map((row) => toPermissionDecision(row as PermissionDecisionRow));

}
