// =========================
// TACT Canonical Execution — Security Finding Store (SOR-178 / SEC-8D)
// =========================
//
// The only DB access layer for public.tact_execution_security_findings
// (products/yolna-runs/supabase/migrations/
// 20270101000015_create_tact_execution_security_findings.sql). Same trust
// boundary as ../permission/store.ts / ../downstreamPermission/store.ts —
// service role client only, write boundary is always this trusted
// observation path, never a live browser session.
//
// Append-only (section7/section21 absolute condition): no UPDATE/DELETE
// function exists in this file, by construction.
//
// Idempotency (section7, two independent layers):
//   1. id-based — same id + same immutable content => already_exists; same
//      id + different content => idempotency_conflict (same pattern as
//      ../downstreamPermission/store.ts).
//   2. source-based — a retry that supplies a DIFFERENT caller-generated id
//      for the SAME immutable source fact (permissionDecisionId+findingType,
//      or downstreamPermissionEvidenceId+findingType) must still resolve to
//      the existing row rather than creating a duplicate Finding. Migration
//      00015 enforces this with two partial unique indexes; this store
//      disambiguates which one fired by re-reading first by id, then by
//      source key.

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import { validateSecurityFindingInput } from "./validation";
import type {
  SecurityFinding,
  SecurityFindingEligibilityBasis,
  SecurityFindingInput,
  SecurityFindingType,
} from "./types";

const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";
const POSTGRES_FOREIGN_KEY_VIOLATION_CODE = "23503";

export interface SecurityFindingRow {

  id: string;

  user_id: string;

  execution_id: string;

  finding_type: SecurityFindingType;

  reason_code: string;

  eligibility_basis: SecurityFindingEligibilityBasis;

  evaluator_version: string;

  detected_at: string;

  recorded_at: string;

  permission_decision_id: string;

  downstream_permission_evidence_id: string | null;

  configured_unknown_rule_id: string | null;

}

const FINDING_COLUMNS =
  "id, user_id, execution_id, finding_type, reason_code, eligibility_basis, evaluator_version, detected_at, recorded_at, permission_decision_id, downstream_permission_evidence_id, configured_unknown_rule_id";

export function toSecurityFinding(row: SecurityFindingRow): SecurityFinding {

  return {
    id: row.id,
    userId: row.user_id,
    executionId: row.execution_id,
    findingType: row.finding_type,
    reasonCode: row.reason_code,
    eligibilityBasis: row.eligibility_basis,
    evaluatorVersion: row.evaluator_version,
    detectedAt: row.detected_at,
    recordedAt: row.recorded_at,
    permissionDecisionId: row.permission_decision_id,
    downstreamPermissionEvidenceId: row.downstream_permission_evidence_id,
    configuredUnknownRuleId: row.configured_unknown_rule_id,
  };

}

// ../downstreamPermission/store.tsのnormalizeInstantForComparison()/
// canonicalJson()と同じ目的・同じ理由で、このfile専用に独立して持つ
// (既存規約、各moduleが自分のstore層を独立実装する)。
function normalizeInstantForComparison(value: string): string {

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    throw new Error("invalid timestamp reached security finding idempotency comparison");
  }

  return new Date(timestamp).toISOString();

}

interface ComparableFindingContent {
  id: string;
  userId: string;
  executionId: string;
  findingType: SecurityFindingType;
  reasonCode: string;
  eligibilityBasis: SecurityFindingEligibilityBasis;
  evaluatorVersion: string;
  detectedAt: string;
  permissionDecisionId: string;
  downstreamPermissionEvidenceId: string | null;
  configuredUnknownRuleId: string | null;
}

function comparablePayload(content: ComparableFindingContent): string {

  return JSON.stringify({
    id: content.id,
    userId: content.userId,
    executionId: content.executionId,
    findingType: content.findingType,
    reasonCode: content.reasonCode,
    eligibilityBasis: content.eligibilityBasis,
    evaluatorVersion: content.evaluatorVersion,
    detectedAt: normalizeInstantForComparison(content.detectedAt),
    permissionDecisionId: content.permissionDecisionId,
    downstreamPermissionEvidenceId: content.downstreamPermissionEvidenceId,
    configuredUnknownRuleId: content.configuredUnknownRuleId,
  });

}

// id自体は(retryが別のidを使う可能性があるため、section7)意味内容の
// 同一性判定には含めない——sourceベースの衝突判定ではidが異なることが
// 正常であるため。
function comparablePayloadExcludingId(content: Omit<ComparableFindingContent, "id">): string {
  return comparablePayload({ ...content, id: "" });
}

function toComparableContent(input: SecurityFindingInput): ComparableFindingContent {

  return {
    id: input.id,
    userId: input.userId,
    executionId: input.executionId,
    findingType: input.findingType,
    reasonCode: input.reasonCode,
    eligibilityBasis: input.eligibilityBasis,
    evaluatorVersion: input.evaluatorVersion,
    detectedAt: input.detectedAt,
    permissionDecisionId: input.permissionDecisionId,
    downstreamPermissionEvidenceId: input.downstreamPermissionEvidenceId,
    configuredUnknownRuleId: input.configuredUnknownRuleId,
  };

}

function toComparableContentFromRow(row: SecurityFindingRow): ComparableFindingContent {

  return {
    id: row.id,
    userId: row.user_id,
    executionId: row.execution_id,
    findingType: row.finding_type,
    reasonCode: row.reason_code,
    eligibilityBasis: row.eligibility_basis,
    evaluatorVersion: row.evaluator_version,
    detectedAt: row.detected_at,
    permissionDecisionId: row.permission_decision_id,
    downstreamPermissionEvidenceId: row.downstream_permission_evidence_id,
    configuredUnknownRuleId: row.configured_unknown_rule_id,
  };

}

export type RecordSecurityFindingOutcome =
  | { status: "created"; finding: SecurityFinding }
  | { status: "already_exists"; finding: SecurityFinding }
  | { status: "idempotency_conflict" }
  | { status: "invalid"; errors: string[] }
  // execution_id/permission_decision_id/downstream_permission_evidence_id
  // のいずれかのFKが解決できなかった(section8のcomposite FKのいずれか)。
  // どのFKが原因かは意図的に区別しない(他tenant/存在しない、を漏らさない
  // 既存規約、../correlation/store.tsのtarget_work_not_foundと同じ精神)。
  | { status: "source_not_found" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface SecurityFindingStoreDeps {
  getClient: typeof getServiceRoleClient;
}

const defaultStoreDeps: SecurityFindingStoreDeps = {
  getClient: getServiceRoleClient,
};

async function rereadBySourceKey(
  client: NonNullable<ReturnType<typeof getServiceRoleClient>>,
  input: SecurityFindingInput
): Promise<SecurityFindingRow | null> {

  let query = client
    .from("tact_execution_security_findings")
    .select(FINDING_COLUMNS)
    .eq("user_id", input.userId)
    .eq("finding_type", input.findingType);

  query =
    input.findingType === "DOWNSTREAM_PERMISSION_CONFLICT"
      ? query.eq("downstream_permission_evidence_id", input.downstreamPermissionEvidenceId as string)
      : query.eq("permission_decision_id", input.permissionDecisionId);

  const { data } = await query.maybeSingle();

  return (data as SecurityFindingRow | null) ?? null;

}

// section7の唯一の書き込み入口。No UPDATE/DELETE function exists anywhere
// in this file (section21/section26 acceptance checks assert this
// structurally).
export async function recordSecurityFinding(
  input: SecurityFindingInput,
  deps: SecurityFindingStoreDeps = defaultStoreDeps
): Promise<RecordSecurityFindingOutcome> {

  const validation = validateSecurityFindingInput(input);

  if (!validation.ok) {
    return { status: "invalid", errors: validation.errors };
  }

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const { data, error } = await client
    .from("tact_execution_security_findings")
    .insert({
      id: input.id,
      user_id: input.userId,
      execution_id: input.executionId,
      finding_type: input.findingType,
      reason_code: input.reasonCode,
      eligibility_basis: input.eligibilityBasis,
      evaluator_version: input.evaluatorVersion,
      detected_at: input.detectedAt,
      permission_decision_id: input.permissionDecisionId,
      downstream_permission_evidence_id: input.downstreamPermissionEvidenceId,
      configured_unknown_rule_id: input.configuredUnknownRuleId,
    })
    .select(FINDING_COLUMNS)
    .single();

  if (!error && data) {
    return { status: "created", finding: toSecurityFinding(data as SecurityFindingRow) };
  }

  if (error && (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_CODE) {

    // Disambiguate which of the two unique constraints fired: re-read by id
    // first (the PK) — if that id already exists, this is an id-collision
    // retry. Otherwise, the source-uniqueness partial index fired, so
    // re-read by source key instead (section7, "prevent reprocessing the
    // same immutable source fact... even if the retry supplies a different
    // command UUID").
    const byId = await client
      .from("tact_execution_security_findings")
      .select(FINDING_COLUMNS)
      .eq("id", input.id)
      .eq("user_id", input.userId)
      .maybeSingle();

    const existingRow = (byId.data as SecurityFindingRow | null) ?? (await rereadBySourceKey(client, input));

    if (!existingRow) {
      return { status: "error", message: byId.error?.message ?? "duplicate claim, but existing finding could not be read" };
    }

    const same =
      existingRow.id === input.id
        ? comparablePayload(toComparableContentFromRow(existingRow)) === comparablePayload(toComparableContent(input))
        : comparablePayloadExcludingId(toComparableContentFromRow(existingRow)) ===
          comparablePayloadExcludingId(toComparableContent(input));

    return same
      ? { status: "already_exists", finding: toSecurityFinding(existingRow) }
      : { status: "idempotency_conflict" };

  }

  if (error && (error as { code?: string }).code === POSTGRES_FOREIGN_KEY_VIOLATION_CODE) {
    return { status: "source_not_found" };
  }

  return { status: "error", message: error?.message ?? "insert failed" };

}

export interface ListSecurityFindingsDeps {
  getClient: typeof getServiceRoleClient;
}

const defaultListDeps: ListSecurityFindingsDeps = {
  getClient: getServiceRoleClient,
};

export async function listSecurityFindingsForExecution(
  executionId: string,
  userId: string,
  deps: ListSecurityFindingsDeps = defaultListDeps
): Promise<SecurityFinding[]> {

  const client = deps.getClient();

  if (!client) {
    return [];
  }

  const { data } = await client
    .from("tact_execution_security_findings")
    .select(FINDING_COLUMNS)
    .eq("execution_id", executionId)
    .eq("user_id", userId)
    .order("detected_at", { ascending: true });

  return (data ?? []).map((row) => toSecurityFinding(row as SecurityFindingRow));

}

export async function listSecurityFindingsByIds(
  findingIds: readonly string[],
  userId: string,
  deps: ListSecurityFindingsDeps = defaultListDeps
): Promise<SecurityFinding[]> {

  if (findingIds.length === 0) {
    return [];
  }

  const client = deps.getClient();

  if (!client) {
    return [];
  }

  const { data } = await client
    .from("tact_execution_security_findings")
    .select(FINDING_COLUMNS)
    .in("id", findingIds)
    .eq("user_id", userId);

  return (data ?? []).map((row) => toSecurityFinding(row as SecurityFindingRow));

}
