// =========================
// TACT Canonical Execution — Permission Registry Store (SOR-47)
// =========================
//
// core/tact-execution/permission/配下のtact_execution_permission_rules
// アクセス層。既存store.ts/attentionStore.tsと同じ理由(書き込みは常に
// 認証済みCRUD boundary経由、生きたuser browser sessionのRLSに頼らない
// trust boundary)でservice role clientを使う。
//
// 絶対条件(Human Owner指示、SOR-47 Phase1スコープB「session-derived
// tenant ownership enforced above the store」): このfile自身は
// requestからuserIdを解決しない——呼び出し元(app/api/tact/
// permission-rules/、getCurrentUserContext(request)経由)が既に検証
// 済みのuserIdを渡すことを前提とする(他の全てのstore.ts系file——
// core/tact-execution/permission/store.ts・attentionStore.ts等——と
// 同じ既存パターン)。ただし、このfile自身も「渡されたuserIdでのみ
// 行を変更できる」ことを明示的な`.eq("user_id", userId)`で常に
// 強制する(defense in depth、caller-supplied user_idを信用しない
// という要件をstore層でも独立に満たす)。
//
// user_id=NULL(global fallback rule)は、このCRUD境界からは一切
// 作成・変更・削除できない——`.eq("user_id", userId)`は具体的な
// uuidに対してuser_id IS NULLの行に一致しないため、自然に除外される
// (SOR-47 v1-minimalの意図的なscope絞り込み: adminロール概念が
// このrepositoryに存在しないため、global ruleはmigration/ops経由の
// みで管理する)。

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import {
  EXECUTION_ACTOR_KINDS,
  EXECUTION_ACTION_CATEGORIES,
  EXECUTION_PROVIDERS,
  type ExecutionActorKind,
  type ExecutionActionCategory,
  type ExecutionProvider,
} from "../types";
import type {
  PermissionRegistryRule,
  PermissionRegistryRuleInput,
  PermissionRegistryRuleUpdateInput,
} from "./types";

const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";

// =========================
// SOR-47 Phase2(Evaluator Cutover): Registry infrastructure failure
// =========================
//
// 絶対条件(Human Owner指示、Phase2「DO NOT silently fall back to the
// static POLICY_RULES if Registry loading/evaluation fails」):
// service role client不可、またはquery自体の失敗(network/DB障害)は、
// 「ruleが1件もmatchしなかった」(正常なno-match unknown)とは全く
// 別の事象であり、混同してはならない。listActivePermissionRulesForMatching()
// はこの2つを、戻り値の形(空配列)で暗黙的に区別不能にしていた
// (Phase1時点の実装、CRUD boundary用途では許容されたが、live
// observation pathのdefault evaluatorとして使うPhase2では許容
// できない)。このErrorはinfrastructure障害だけをmarkし、呼び出し元
// (registryEvaluate.ts経由でcore/tact-execution/permission/observe.ts)
// が握り潰さず、既存のCapture Failure Policy(stage単位の独立した
// try/catch、onFailureへの構造化報告)へ伝播させるためのsignalとして
// 使う——新しいPersistPermissionDecisionOutcome variantやDB書き込みは
// 一切追加しない(絶対条件: 誤ったPermission Decision provenanceを
// 作らない)。
export class RegistryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryUnavailableError";
  }
}

export interface PermissionRegistryRuleRow {
  id: string;
  user_id: string | null;
  identifier: string;
  revision: number;
  subject_kind: ExecutionActorKind | null;
  actor_id: string | null;
  agent_id: string | null;
  provider: ExecutionProvider | null;
  target_provider: ExecutionProvider | null;
  resource_type: string | null;
  action_category: ExecutionActionCategory | null;
  decision: "allowed" | "denied" | "approval_required";
  reason_code: string;
  requires_known_actor_id: boolean;
  requires_known_agent_id: boolean;
  connection_id: string | null;
  priority: number;
  valid_from: string | null;
  valid_until: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// store.ts/attentionStore.tsと同じ既存パターン(deps注入によるfake
// client差し替え、実Supabase接続無しでのbranch検証を可能にする)を
// このfileにも適用する。default(getServiceRoleClient())は既存の
// service role専用境界を一切変えない。
export interface PermissionRegistryStoreDeps {
  getClient: typeof getServiceRoleClient;
}

const defaultStoreDeps: PermissionRegistryStoreDeps = {
  getClient: getServiceRoleClient,
};

const RULE_COLUMNS =
  "id, user_id, identifier, revision, subject_kind, actor_id, agent_id, provider, target_provider, resource_type, action_category, decision, reason_code, requires_known_actor_id, requires_known_agent_id, connection_id, priority, valid_from, valid_until, enabled, created_at, updated_at";

export function toPermissionRegistryRule(row: PermissionRegistryRuleRow): PermissionRegistryRule {
  return {
    id: row.id,
    userId: row.user_id,
    identifier: row.identifier,
    revision: row.revision,
    subjectKind: row.subject_kind,
    actorId: row.actor_id,
    agentId: row.agent_id,
    provider: row.provider,
    targetProvider: row.target_provider,
    resourceType: row.resource_type,
    actionCategory: row.action_category,
    decision: row.decision,
    reasonCode: row.reason_code,
    requiresKnownActorId: row.requires_known_actor_id,
    requiresKnownAgentId: row.requires_known_agent_id,
    connectionId: row.connection_id,
    priority: row.priority,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// =========================
// Validation
// =========================

export type ValidatePermissionRuleInputResult = { ok: true } | { ok: false; errors: string[] };

const IDENTIFIER_MAX_LENGTH = 255;
const REASON_CODE_MAX_LENGTH = 255;
const RESOURCE_TYPE_MAX_LENGTH = 255;
const ACTOR_AGENT_ID_MAX_LENGTH = 255;

function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

// create/update双方が通る、caller-supplied内容の唯一の検証入口
// (巨大metadata禁止と同じ精神: 未知のenum値・不正な長さ・矛盾した
// validity windowをDB到達前に拒否する)。
export function validatePermissionRuleInput(
  input: PermissionRegistryRuleInput
): ValidatePermissionRuleInputResult {

  const errors: string[] = [];

  if (input.identifier.length < 1 || input.identifier.length > IDENTIFIER_MAX_LENGTH) {
    errors.push(`identifier must be between 1 and ${IDENTIFIER_MAX_LENGTH} characters`);
  }

  if (!["allowed", "denied", "approval_required"].includes(input.decision)) {
    errors.push("decision must be one of allowed, denied, approval_required");
  }

  if (input.reasonCode.length < 1 || input.reasonCode.length > REASON_CODE_MAX_LENGTH) {
    errors.push(`reasonCode must be between 1 and ${REASON_CODE_MAX_LENGTH} characters`);
  }

  if (input.subjectKind != null && !EXECUTION_ACTOR_KINDS.includes(input.subjectKind)) {
    errors.push(`subjectKind must be one of ${EXECUTION_ACTOR_KINDS.join(", ")} or null`);
  }

  if (input.provider != null && !EXECUTION_PROVIDERS.includes(input.provider)) {
    errors.push(`provider must be one of ${EXECUTION_PROVIDERS.join(", ")} or null`);
  }

  if (input.targetProvider != null && !EXECUTION_PROVIDERS.includes(input.targetProvider)) {
    errors.push(`targetProvider must be one of ${EXECUTION_PROVIDERS.join(", ")} or null`);
  }

  if (input.actionCategory != null && !EXECUTION_ACTION_CATEGORIES.includes(input.actionCategory)) {
    errors.push(`actionCategory must be one of ${EXECUTION_ACTION_CATEGORIES.join(", ")} or null`);
  }

  if (input.resourceType != null && (input.resourceType.length < 1 || input.resourceType.length > RESOURCE_TYPE_MAX_LENGTH)) {
    errors.push(`resourceType must be between 1 and ${RESOURCE_TYPE_MAX_LENGTH} characters or null`);
  }

  if (input.actorId != null && (input.actorId.length < 1 || input.actorId.length > ACTOR_AGENT_ID_MAX_LENGTH)) {
    errors.push(`actorId must be between 1 and ${ACTOR_AGENT_ID_MAX_LENGTH} characters or null`);
  }

  if (input.agentId != null && (input.agentId.length < 1 || input.agentId.length > ACTOR_AGENT_ID_MAX_LENGTH)) {
    errors.push(`agentId must be between 1 and ${ACTOR_AGENT_ID_MAX_LENGTH} characters or null`);
  }

  if (input.priority != null && (!Number.isInteger(input.priority) || input.priority < 0)) {
    errors.push("priority must be a non-negative integer");
  }

  if (input.validFrom != null && !isValidTimestamp(input.validFrom)) {
    errors.push("validFrom must be a valid ISO timestamp or null");
  }

  if (input.validUntil != null && !isValidTimestamp(input.validUntil)) {
    errors.push("validUntil must be a valid ISO timestamp or null");
  }

  if (
    input.validFrom != null &&
    input.validUntil != null &&
    isValidTimestamp(input.validFrom) &&
    isValidTimestamp(input.validUntil) &&
    Date.parse(input.validFrom) >= Date.parse(input.validUntil)
  ) {
    errors.push("validFrom must be strictly before validUntil");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };

}

// =========================
// Read (matching)
// =========================

// registryEvaluate.tsの唯一の入力source。tenant行(user_id = userId)と
// global fallback行(user_id is null)を1回のqueryでまとめて取得する
// ——tier分けとvalidity window filtering/matchingは呼び出し側
// (registryEvaluate.ts、pure関数)が行う(この関数自体はexecution
// context非依存、単なる「有効なruleの候補集合」を返すだけ)。
//
// 絶対条件(SOR-47 Phase2、上記RegistryUnavailableErrorコメント参照):
// service role client不可、またはquery自体のerrorは、両方とも
// RegistryUnavailableErrorをthrowする——Phase1では(CRUD list用途の
// listOwnedPermissionRules()と同じ精神で)空配列へfail closedしていた
// が、live observation pathのdefault evaluatorとして使われる
// Phase2では、これが「正常なno-match(0件match)」と区別不能になり、
// 「registryが読めなかった」ケースを「matchするruleが無かった」
// (unknown/no_matching_registry_rule、正当なPermission Decision)へ
// 静かに変換してしまう——絶対に避けるべき誤ったprovenance
// (Human Owner指示)。listOwnedPermissionRules()(CRUD一覧用途、
// Phase2のscope外)は意図的に変更せず、空配列へのfail closedのまま
// 残す。
export async function listActivePermissionRulesForMatching(
  userId: string,
  deps: PermissionRegistryStoreDeps = defaultStoreDeps
): Promise<PermissionRegistryRule[]> {

  const client = deps.getClient();

  if (!client) {
    throw new RegistryUnavailableError("permission registry service role client unavailable");
  }

  const { data, error } = await client
    .from("tact_execution_permission_rules")
    .select(RULE_COLUMNS)
    .or(`user_id.eq.${userId},user_id.is.null`)
    .eq("enabled", true);

  if (error) {
    throw new RegistryUnavailableError(error.message);
  }

  return (data ?? []).map((row) => toPermissionRegistryRule(row as PermissionRegistryRuleRow));

}

// admin/user CRUD boundary(app/api/tact/permission-rules/)のlist用。
// v1-minimalではglobal fallback ruleは管理対象外(このCRUD boundary
// からは作成/編集/削除できないため、一覧にも含めない——見えるが
// 操作できない行を見せて混乱させない)。
export async function listOwnedPermissionRules(
  userId: string,
  deps: PermissionRegistryStoreDeps = defaultStoreDeps
): Promise<PermissionRegistryRule[]> {

  const client = deps.getClient();

  if (!client) {
    return [];
  }

  const { data } = await client
    .from("tact_execution_permission_rules")
    .select(RULE_COLUMNS)
    .eq("user_id", userId)
    .order("priority", { ascending: true });

  return (data ?? []).map((row) => toPermissionRegistryRule(row as PermissionRegistryRuleRow));

}

// =========================
// Write (CRUD boundary)
// =========================

export type CreatePermissionRuleOutcome =
  | { status: "created"; rule: PermissionRegistryRule }
  | { status: "duplicate_identifier" }
  | { status: "invalid"; errors: string[] }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export async function createPermissionRule(
  userId: string,
  input: PermissionRegistryRuleInput,
  deps: PermissionRegistryStoreDeps = defaultStoreDeps
): Promise<CreatePermissionRuleOutcome> {

  const validation = validatePermissionRuleInput(input);

  if (!validation.ok) {
    return { status: "invalid", errors: validation.errors };
  }

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const { data, error } = await client
    .from("tact_execution_permission_rules")
    // user_idは常にcallerが渡したuserId(=認証済みsessionから導出済み)
    // で上書きする。input側にはuserIdフィールド自体が存在しない
    // (PermissionRegistryRuleInputの型定義、caller-supplied user_idを
    // 受け付ける余地そのものを型レベルで排除している)。
    .insert({
      user_id: userId,
      identifier: input.identifier,
      subject_kind: input.subjectKind ?? null,
      actor_id: input.actorId ?? null,
      agent_id: input.agentId ?? null,
      provider: input.provider ?? null,
      target_provider: input.targetProvider ?? null,
      resource_type: input.resourceType ?? null,
      action_category: input.actionCategory ?? null,
      decision: input.decision,
      reason_code: input.reasonCode,
      requires_known_actor_id: input.requiresKnownActorId ?? false,
      requires_known_agent_id: input.requiresKnownAgentId ?? false,
      connection_id: input.connectionId ?? null,
      priority: input.priority ?? 0,
      valid_from: input.validFrom ?? null,
      valid_until: input.validUntil ?? null,
    })
    .select(RULE_COLUMNS)
    .single();

  if (error) {

    if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_CODE) {
      return { status: "duplicate_identifier" };
    }

    return { status: "error", message: error.message };

  }

  return { status: "created", rule: toPermissionRegistryRule(data as PermissionRegistryRuleRow) };

}

export type UpdatePermissionRuleOutcome =
  | { status: "updated"; rule: PermissionRegistryRule }
  | { status: "not_found" }
  | { status: "duplicate_identifier" }
  | { status: "invalid"; errors: string[] }
  | { status: "unavailable" }
  | { status: "error"; message: string };

// 絶対条件(historical explainability): 内容が変わるUPDATEは常に
// revisionを+1する(単純な「常に増分する」1ルール、特殊ケース分岐
// なし——SOR-47 revised design section9)。
export async function updatePermissionRule(
  userId: string,
  ruleId: string,
  patch: PermissionRegistryRuleUpdateInput,
  deps: PermissionRegistryStoreDeps = defaultStoreDeps
): Promise<UpdatePermissionRuleOutcome> {

  if (Object.keys(patch).length === 0) {
    return { status: "invalid", errors: ["patch must include at least one field"] };
  }

  // decision/reasonCode/identifierがpatchに含まれる場合のみ、
  // validatePermissionRuleInput()相当の検証をfield単位で適用する
  // (全field必須のInput型ではなくPartialなため、専用チェックにする)。
  const errors: string[] = [];

  if (patch.identifier != null && (patch.identifier.length < 1 || patch.identifier.length > IDENTIFIER_MAX_LENGTH)) {
    errors.push(`identifier must be between 1 and ${IDENTIFIER_MAX_LENGTH} characters`);
  }

  if (patch.decision != null && !["allowed", "denied", "approval_required"].includes(patch.decision)) {
    errors.push("decision must be one of allowed, denied, approval_required");
  }

  if (patch.reasonCode != null && (patch.reasonCode.length < 1 || patch.reasonCode.length > REASON_CODE_MAX_LENGTH)) {
    errors.push(`reasonCode must be between 1 and ${REASON_CODE_MAX_LENGTH} characters`);
  }

  if (patch.subjectKind != null && !EXECUTION_ACTOR_KINDS.includes(patch.subjectKind)) {
    errors.push(`subjectKind must be one of ${EXECUTION_ACTOR_KINDS.join(", ")} or null`);
  }

  if (patch.provider != null && !EXECUTION_PROVIDERS.includes(patch.provider)) {
    errors.push(`provider must be one of ${EXECUTION_PROVIDERS.join(", ")} or null`);
  }

  if (patch.targetProvider != null && !EXECUTION_PROVIDERS.includes(patch.targetProvider)) {
    errors.push(`targetProvider must be one of ${EXECUTION_PROVIDERS.join(", ")} or null`);
  }

  if (patch.actionCategory != null && !EXECUTION_ACTION_CATEGORIES.includes(patch.actionCategory)) {
    errors.push(`actionCategory must be one of ${EXECUTION_ACTION_CATEGORIES.join(", ")} or null`);
  }

  if (patch.priority != null && (!Number.isInteger(patch.priority) || patch.priority < 0)) {
    errors.push("priority must be a non-negative integer");
  }

  if (patch.validFrom != null && !isValidTimestamp(patch.validFrom)) {
    errors.push("validFrom must be a valid ISO timestamp or null");
  }

  if (patch.validUntil != null && !isValidTimestamp(patch.validUntil)) {
    errors.push("validUntil must be a valid ISO timestamp or null");
  }

  if (errors.length > 0) {
    return { status: "invalid", errors };
  }

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (patch.identifier !== undefined) updatePayload.identifier = patch.identifier;
  if (patch.subjectKind !== undefined) updatePayload.subject_kind = patch.subjectKind;
  if (patch.actorId !== undefined) updatePayload.actor_id = patch.actorId;
  if (patch.agentId !== undefined) updatePayload.agent_id = patch.agentId;
  if (patch.provider !== undefined) updatePayload.provider = patch.provider;
  if (patch.targetProvider !== undefined) updatePayload.target_provider = patch.targetProvider;
  if (patch.resourceType !== undefined) updatePayload.resource_type = patch.resourceType;
  if (patch.actionCategory !== undefined) updatePayload.action_category = patch.actionCategory;
  if (patch.decision !== undefined) updatePayload.decision = patch.decision;
  if (patch.reasonCode !== undefined) updatePayload.reason_code = patch.reasonCode;
  if (patch.requiresKnownActorId !== undefined) updatePayload.requires_known_actor_id = patch.requiresKnownActorId;
  if (patch.requiresKnownAgentId !== undefined) updatePayload.requires_known_agent_id = patch.requiresKnownAgentId;
  if (patch.connectionId !== undefined) updatePayload.connection_id = patch.connectionId;
  if (patch.priority !== undefined) updatePayload.priority = patch.priority;
  if (patch.validFrom !== undefined) updatePayload.valid_from = patch.validFrom;
  if (patch.validUntil !== undefined) updatePayload.valid_until = patch.validUntil;
  if (patch.enabled !== undefined) updatePayload.enabled = patch.enabled;

  // revisionはDB側の現在値を信頼して読み直す必要があるため、RPC的な
  // atomic increment(`revision = revision + 1`)をPostgRESTのraw
  // expression経由ではなく、単純に「読み→+1して書く」の2段にすると
  // race conditionの余地が残る。ここではSupabase RPC無しでも安全な
  // 方法として、Postgresの生成列ではなくupdate文自体にraw SQLを渡せない
  // 制約上、read-modify-writeを避けられないpostgrest-jsの制約内で
  // 最小のrace窓に収める(v1-minimal、他のtenant CRUD操作と同じく
  // 単一managerによる低頻度書き込みを前提とする——本格的な
  // optimistic concurrency controlはこのスコープ外)。

  const { data: currentRow, error: readError } = await client
    .from("tact_execution_permission_rules")
    .select("revision")
    .eq("id", ruleId)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    return { status: "error", message: readError.message };
  }

  if (!currentRow) {
    return { status: "not_found" };
  }

  updatePayload.revision = (currentRow as { revision: number }).revision + 1;

  const { data, error } = await client
    .from("tact_execution_permission_rules")
    .update(updatePayload)
    .eq("id", ruleId)
    .eq("user_id", userId)
    .select(RULE_COLUMNS)
    .maybeSingle();

  if (error) {

    if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_CODE) {
      return { status: "duplicate_identifier" };
    }

    return { status: "error", message: error.message };

  }

  if (!data) {
    return { status: "not_found" };
  }

  return { status: "updated", rule: toPermissionRegistryRule(data as PermissionRegistryRuleRow) };

}

export type DisablePermissionRuleOutcome =
  | { status: "disabled"; rule: PermissionRegistryRule }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

// disableは「もう使いたくないが監査証跡は残したい」場合の推奨操作
// (SOR-47 revised design section8)。updatePermissionRule()の薄い
// wrapper(enabled=falseへのpatch)——revision増分等の挙動を重複実装
// しない。
export async function disablePermissionRule(
  userId: string,
  ruleId: string,
  deps: PermissionRegistryStoreDeps = defaultStoreDeps
): Promise<DisablePermissionRuleOutcome> {

  const outcome = await updatePermissionRule(userId, ruleId, { enabled: false }, deps);

  if (outcome.status === "updated") {
    return { status: "disabled", rule: outcome.rule };
  }

  if (outcome.status === "not_found" || outcome.status === "unavailable") {
    return outcome;
  }

  if (outcome.status === "invalid") {
    // enabled=falseのみのpatchはvalidatePermissionRuleInput()の
    // どのfieldにも該当しないため到達しない想定だが、型を尽くす。
    return { status: "error", message: outcome.errors.join(", ") };
  }

  // duplicate_identifierはidentifierを変更しないこの呼び出し経路では
  // 発生し得ない想定だが、型を尽くす。
  return { status: "error", message: `unexpected outcome: ${outcome.status}` };

}

export type DeletePermissionRuleOutcome =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

// 絶対条件(historical explainability): hard deleteしても、過去の
// Permission Decisionの説明可能性は失われない——decision側が既に
// match時点のfull snapshotをmetadataへ記録済みであり(SOR-47 revised
// design section9)、registry_rule_id FKはON DELETE SET NULLで安全に
// 外れる。
export async function deletePermissionRule(
  userId: string,
  ruleId: string,
  deps: PermissionRegistryStoreDeps = defaultStoreDeps
): Promise<DeletePermissionRuleOutcome> {

  const client = deps.getClient();

  if (!client) {
    return { status: "unavailable" };
  }

  const { data, error } = await client
    .from("tact_execution_permission_rules")
    .delete()
    .eq("id", ruleId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { status: "error", message: error.message };
  }

  if (!data) {
    return { status: "not_found" };
  }

  return { status: "deleted" };

}
