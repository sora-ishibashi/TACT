// =========================
// TACT Canonical Execution — Downstream Permission Evidence Store (SOR-177 / SEC-8C)
// =========================
//
// core/tact-execution/downstreamPermission/配下の唯一のDBアクセス層。
// products/yolna-runs/supabase/migrations/
// 20270101000014_create_tact_execution_downstream_permission_evidence.sql
// を対象とする。既存../store.ts/../governance/store.tsと同じ理由(書き込みは
// 常に信頼されたinternal adapter経由、生きたuser browser sessionを前提
// できないtrust boundary)でservice role clientを使う。
//
// 絶対条件(Append-only、Human Owner section9): UPDATE/DELETE関数を一切
// 持たない。同一executionへの複数行は正常なシナリオであり、natural-key
// dedupe(execution_id, source_typeなど)は一切追加しない——後からの独立した
// 観測は常に新しいaudit factとして残る(latest-winsにしない)。
//
// 絶対条件(Idempotency): caller-generated id主キーへの直接INSERTを試み、
// unique_violation(23505)を「既に同じ内容のevidenceが記録済み」として
// 判定する(../governance/store.tsと同じ精神: canonical JSON比較による
// 内容一致判定、timestampはinstant正規化して比較する——SOR-8Bで実証済みの
// 同じ教訓を適用する)。再読み込みは常にuser_idでも絞り込み、他tenantの
// 行内容を比較結果へ漏らさない(../permission/store.ts等の既存tenant
// safety規約と同じ)。

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import type { JsonValue } from "@tact/execution-contract";
import type { ExecutionActionCategory, ExecutionActorKind, ExecutionProvider } from "../types";
import { validateDownstreamPermissionEvidenceInput } from "./validation";
import type {
  DownstreamEvidenceAuthorityLevel,
  DownstreamEvidenceTrustLevel,
  DownstreamPermissionEvidence,
  DownstreamPermissionEvidenceInput,
  DownstreamPermissionState,
} from "./types";

const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";
const POSTGRES_FOREIGN_KEY_VIOLATION_CODE = "23503";

export interface DownstreamPermissionEvidenceRow {

  id: string;

  user_id: string;

  execution_id: string;

  target_provider: ExecutionProvider;

  connection_id: string | null;

  subject_kind: ExecutionActorKind;

  subject_id: string | null;

  agent_id: string | null;

  action_category: ExecutionActionCategory;

  operation: string;

  resource_type: string | null;

  resource_identifier: string | null;

  permission_state: DownstreamPermissionState;

  source_type: string;

  source_identifier: string | null;

  authority_level: DownstreamEvidenceAuthorityLevel;

  trust_level: DownstreamEvidenceTrustLevel;

  observed_at: string;

  recorded_at: string;

  evidence_snapshot: JsonValue | null;

}

const EVIDENCE_COLUMNS =
  "id, user_id, execution_id, target_provider, connection_id, subject_kind, subject_id, agent_id, action_category, operation, resource_type, resource_identifier, permission_state, source_type, source_identifier, authority_level, trust_level, observed_at, recorded_at, evidence_snapshot";

export function toDownstreamPermissionEvidence(row: DownstreamPermissionEvidenceRow): DownstreamPermissionEvidence {

  return {
    id: row.id,
    userId: row.user_id,
    executionId: row.execution_id,
    targetProvider: row.target_provider,
    connectionId: row.connection_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    agentId: row.agent_id,
    actionCategory: row.action_category,
    operation: row.operation,
    resourceType: row.resource_type,
    resourceIdentifier: row.resource_identifier,
    permissionState: row.permission_state,
    sourceType: row.source_type,
    sourceIdentifier: row.source_identifier,
    authorityLevel: row.authority_level,
    trustLevel: row.trust_level,
    observedAt: row.observed_at,
    recordedAt: row.recorded_at,
    evidenceSnapshot: row.evidence_snapshot,
  };

}

// ../governance/store.tsのnormalizeInstantForComparison()と同じ目的
// (caller-owned instantの比較、DB表示形の揺れ(+00:00 vs Z)を無視する)。
// このfile専用に独立して持つ(既存規約: 各moduleが自分のstore層を独立
// 実装する、../validation.ts冒頭コメント参照)。
function normalizeInstantForComparison(value: string): string {

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    throw new Error("invalid timestamp reached downstream permission evidence idempotency comparison");
  }

  return new Date(timestamp).toISOString();

}

// ../governance/store.tsのcanonical()と同じ目的(key順序に依存しない
// deterministic JSON比較)。このfile専用に独立して持つ。
function canonicalJson(value: JsonValue | null): string {

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, JsonValue>;

  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;

}

interface ComparableEvidenceContent {
  id: string;
  userId: string;
  executionId: string;
  targetProvider: ExecutionProvider;
  connectionId: string | null;
  subjectKind: ExecutionActorKind;
  subjectId: string | null;
  agentId: string | null;
  actionCategory: ExecutionActionCategory;
  operation: string;
  resourceType: string | null;
  resourceIdentifier: string | null;
  permissionState: DownstreamPermissionState;
  sourceType: string;
  sourceIdentifier: string | null;
  authorityLevel: DownstreamEvidenceAuthorityLevel;
  trustLevel: DownstreamEvidenceTrustLevel;
  observedAt: string;
  evidenceSnapshot: JsonValue | null;
}

// idempotency判定対象の「意味内容」全体。recordedAtはserver生成のため
// 比較対象に含めない(retryごとに変わり得る値を同一性判定に使わない、
// ../governance/store.tsと同じ精神)。
function comparablePayload(content: ComparableEvidenceContent): string {

  return canonicalJson({
    id: content.id,
    userId: content.userId,
    executionId: content.executionId,
    targetProvider: content.targetProvider,
    connectionId: content.connectionId,
    subjectKind: content.subjectKind,
    subjectId: content.subjectId,
    agentId: content.agentId,
    actionCategory: content.actionCategory,
    operation: content.operation,
    resourceType: content.resourceType,
    resourceIdentifier: content.resourceIdentifier,
    permissionState: content.permissionState,
    sourceType: content.sourceType,
    sourceIdentifier: content.sourceIdentifier,
    authorityLevel: content.authorityLevel,
    trustLevel: content.trustLevel,
    observedAt: normalizeInstantForComparison(content.observedAt),
    evidenceSnapshot: content.evidenceSnapshot,
  });

}

function toComparableContent(input: DownstreamPermissionEvidenceInput): ComparableEvidenceContent {

  return {
    id: input.id,
    userId: input.userId,
    executionId: input.executionId,
    targetProvider: input.targetProvider,
    connectionId: input.connectionId ?? null,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId ?? null,
    agentId: input.agentId ?? null,
    actionCategory: input.actionCategory,
    operation: input.operation,
    resourceType: input.resourceType ?? null,
    resourceIdentifier: input.resourceIdentifier ?? null,
    permissionState: input.permissionState,
    sourceType: input.sourceType,
    sourceIdentifier: input.sourceIdentifier ?? null,
    authorityLevel: input.authorityLevel,
    trustLevel: input.trustLevel,
    observedAt: input.observedAt,
    evidenceSnapshot: input.evidenceSnapshot ?? null,
  };

}

function toComparableContentFromRow(row: DownstreamPermissionEvidenceRow): ComparableEvidenceContent {

  return {
    id: row.id,
    userId: row.user_id,
    executionId: row.execution_id,
    targetProvider: row.target_provider,
    connectionId: row.connection_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    agentId: row.agent_id,
    actionCategory: row.action_category,
    operation: row.operation,
    resourceType: row.resource_type,
    resourceIdentifier: row.resource_identifier,
    permissionState: row.permission_state,
    sourceType: row.source_type,
    sourceIdentifier: row.source_identifier,
    authorityLevel: row.authority_level,
    trustLevel: row.trust_level,
    observedAt: row.observed_at,
    evidenceSnapshot: row.evidence_snapshot,
  };

}

export type RecordDownstreamPermissionEvidenceOutcome =
  | { status: "created"; evidence: DownstreamPermissionEvidence }
  // 絶対条件(Idempotency): 同一id + 同一内容での再送は、新しい行を作らず
  // 既存行をそのまま返す。
  | { status: "already_exists"; evidence: DownstreamPermissionEvidence }
  // 絶対条件: 同一id + 異なる内容は、既存行を一切書き換えずconflictとして
  // 報告する(No UPDATE API、サイレントな上書きを一切しない)。
  | { status: "idempotency_conflict" }
  | { status: "invalid"; errors: string[] }
  | { status: "execution_not_found" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface DownstreamPermissionEvidenceStoreDeps {
  getClient: typeof getServiceRoleClient;
}

const defaultStoreDeps: DownstreamPermissionEvidenceStoreDeps = {
  getClient: getServiceRoleClient,
};

// 絶対条件(No UPDATE/DELETE、Human Owner section9): この関数がこのstoreの
// 唯一の書き込み入口。同一execution_idに対する複数回の呼び出しはすべて
// 正当な別行として保存される——natural-key dedupeは一切行わない。
export async function recordDownstreamPermissionEvidence(
  input: DownstreamPermissionEvidenceInput,
  deps: DownstreamPermissionEvidenceStoreDeps = defaultStoreDeps
): Promise<RecordDownstreamPermissionEvidenceOutcome> {

  const validation = validateDownstreamPermissionEvidenceInput(input);

  if (!validation.ok) {
    return { status: "invalid", errors: validation.errors };
  }

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const { data, error } = await client
    .from("tact_execution_downstream_permission_evidence")
    .insert({
      id: input.id,
      user_id: input.userId,
      execution_id: input.executionId,
      target_provider: input.targetProvider,
      connection_id: input.connectionId ?? null,
      subject_kind: input.subjectKind,
      subject_id: input.subjectId ?? null,
      agent_id: input.agentId ?? null,
      action_category: input.actionCategory,
      operation: input.operation,
      resource_type: input.resourceType ?? null,
      resource_identifier: input.resourceIdentifier ?? null,
      permission_state: input.permissionState,
      source_type: input.sourceType,
      source_identifier: input.sourceIdentifier ?? null,
      authority_level: input.authorityLevel,
      trust_level: input.trustLevel,
      observed_at: input.observedAt,
      evidence_snapshot: input.evidenceSnapshot ?? null,
    })
    .select(EVIDENCE_COLUMNS)
    .single();

  if (!error && data) {
    return { status: "created", evidence: toDownstreamPermissionEvidence(data as DownstreamPermissionEvidenceRow) };
  }

  if (error && (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_CODE) {

    // 絶対条件(tenant safety、../permission/store.ts等の既存規約と同じ):
    // idempotency比較のための再読み込みも、呼び出し元のuserIdで絞り込む
    // ——衝突したidが他tenantの行だった場合に、その内容を比較結果として
    // 漏らさない。
    const existing = await client
      .from("tact_execution_downstream_permission_evidence")
      .select(EVIDENCE_COLUMNS)
      .eq("id", input.id)
      .eq("user_id", input.userId)
      .maybeSingle();

    if (!existing.data) {
      return {
        status: "error",
        message: existing.error?.message ?? "duplicate claim, but existing evidence row could not be read",
      };
    }

    const existingRow = existing.data as DownstreamPermissionEvidenceRow;

    const same = comparablePayload(toComparableContentFromRow(existingRow)) === comparablePayload(toComparableContent(input));

    return same
      ? { status: "already_exists", evidence: toDownstreamPermissionEvidence(existingRow) }
      : { status: "idempotency_conflict" };

  }

  if (error && (error as { code?: string }).code === POSTGRES_FOREIGN_KEY_VIOLATION_CODE) {

    // FK違反(execution_idが存在しない、またはuser_idと組み合わせて一致
    // しない)。fail closedでnot_foundを返す——存在しないExecution、または
    // 他tenantのExecutionへevidenceを紐付けない(../store.tsの
    // captureExecution()と同じ既存規約)。
    return { status: "execution_not_found" };

  }

  return { status: "error", message: error?.message ?? "insert failed" };

}

export interface ListDownstreamPermissionEvidenceDeps {
  getClient: typeof getServiceRoleClient;
}

const defaultListDeps: ListDownstreamPermissionEvidenceDeps = {
  getClient: getServiceRoleClient,
};

// compare.tsへの唯一の入力source。oldest firstで返す——「latest-winsでは
// ない、全行がそのまま等しく見える」という絶対条件を、読み取りの既定順序
// でも裏切らない(呼び出し元が必要なら自分で並べ替える)。
export async function listDownstreamPermissionEvidenceForExecution(
  executionId: string,
  userId: string,
  deps: ListDownstreamPermissionEvidenceDeps = defaultListDeps
): Promise<DownstreamPermissionEvidence[]> {

  const client = deps.getClient();

  if (!client) {
    return [];
  }

  const { data } = await client
    .from("tact_execution_downstream_permission_evidence")
    .select(EVIDENCE_COLUMNS)
    .eq("execution_id", executionId)
    .eq("user_id", userId)
    .order("recorded_at", { ascending: true });

  return (data ?? []).map((row) => toDownstreamPermissionEvidence(row as DownstreamPermissionEvidenceRow));

}
