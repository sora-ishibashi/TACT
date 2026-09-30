// =========================
// TACT Canonical Execution — Integration & Observation Registry Store (SOR-14)
// =========================
//
// tact_execution_observation_registryへの読み取り専用境界(v1)。
// 既存のcore/tact-execution/permission/registryStore.tsと同じ理由
// (書き込みはservice-role専用、DI-testable deps pattern)でservice
// role clientを使う。このfile自身はCRUD APIを提供しない——SOR-14 v1
// はseed migrationで初期データを表現し、更新はSOR-130等のReality
// Testが再実行された際に別途migration/opsで反映する想定(将来の
// CRUD boundaryはこのscope外)。

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import type { ExecutionActionCategory, ExecutionProvider } from "../types";
import {
  toObservationCapability,
  type ListObservationCapabilitiesFilter,
  type ObservationCapabilityRow,
  type ObservationCapabilityWithPermissionInfo,
} from "./types";

export interface ObservationRegistryStoreDeps {
  getClient: typeof getServiceRoleClient;
}

const defaultStoreDeps: ObservationRegistryStoreDeps = {
  getClient: getServiceRoleClient,
};

const CAPABILITY_COLUMNS =
  "id, provider, provider_label, observation_path, action_category, observation_mode, pre_execution_visible, can_block_or_require_approval, principal_attribution_available, principal_attribution_confidence, agent_attribution_available, agent_attribution_confidence, work_context_carrier, reconciliation_available, excludes_raw_payload, privacy_notes, credential_custody, verification_status, verification_note, connection_id, created_at, updated_at";

// =========================
// Permission-policy availability (絶対条件2: 別概念として分離)
// =========================
//
// tact_execution_observation_registry自体にはpermission-policyの
// 有無を一切保存しない——tact_execution_permission_rulesへ都度
// 問い合わせて導出する(単一の真実源)。ここではグローバル
// (user_id is null)のenabledなruleの存在有無だけを見る、v1-minimalな
// 判定(実際のfirst-match-wins評価ロジックは
// core/tact-execution/permission/registryEvaluate.tsのscope、
// 重複実装しない)。
async function isGlobalPermissionPolicyConfigured(
  provider: ExecutionProvider,
  actionCategory: ExecutionActionCategory,
  deps: ObservationRegistryStoreDeps
): Promise<boolean> {

  const client = deps.getClient();

  if (!client) {
    return false;
  }

  const { data } = await client
    .from("tact_execution_permission_rules")
    .select("id")
    .is("user_id", null)
    .eq("enabled", true)
    .or(`provider.eq.${provider},provider.is.null`)
    .or(`action_category.eq.${actionCategory},action_category.is.null`)
    .limit(1);

  return Array.isArray(data) && data.length > 0;

}

export async function listObservationCapabilities(
  filter: ListObservationCapabilitiesFilter = {},
  deps: ObservationRegistryStoreDeps = defaultStoreDeps
): Promise<ObservationCapabilityWithPermissionInfo[]> {

  const client = deps.getClient();

  if (!client) {
    return [];
  }

  let query = client
    .from("tact_execution_observation_registry")
    .select(CAPABILITY_COLUMNS)
    .order("provider", { ascending: true })
    .order("observation_path", { ascending: true })
    .order("action_category", { ascending: true });

  if (filter.provider) {
    query = query.eq("provider", filter.provider);
  }

  if (filter.actionCategory) {
    query = query.eq("action_category", filter.actionCategory);
  }

  if (filter.verificationStatus) {
    query = query.eq("verification_status", filter.verificationStatus);
  }

  const { data } = await query;

  const rows = (data ?? []) as ObservationCapabilityRow[];

  const capabilities = rows.map(toObservationCapability);

  // provider×actionCategoryの組ごとに1回だけpermission policyの
  // 存在確認を行う(同じ組が複数observationPathへ重複するケースの
  // 無駄なquery往復を避ける)。
  const permissionCache = new Map<string, boolean>();

  const withPermissionInfo: ObservationCapabilityWithPermissionInfo[] = [];

  for (const capability of capabilities) {
    const cacheKey = `${capability.provider}:${capability.actionCategory}`;
    let permissionPolicyConfigured = permissionCache.get(cacheKey);

    if (permissionPolicyConfigured === undefined) {
      permissionPolicyConfigured = await isGlobalPermissionPolicyConfigured(
        capability.provider,
        capability.actionCategory,
        deps
      );
      permissionCache.set(cacheKey, permissionPolicyConfigured);
    }

    withPermissionInfo.push({ ...capability, permissionPolicyConfigured });
  }

  return withPermissionInfo;

}

export async function getObservationCapability(
  provider: ExecutionProvider,
  observationPath: string,
  actionCategory: ExecutionActionCategory,
  deps: ObservationRegistryStoreDeps = defaultStoreDeps
): Promise<ObservationCapabilityWithPermissionInfo | undefined> {

  const client = deps.getClient();

  if (!client) {
    return undefined;
  }

  const { data } = await client
    .from("tact_execution_observation_registry")
    .select(CAPABILITY_COLUMNS)
    .eq("provider", provider)
    .eq("observation_path", observationPath)
    .eq("action_category", actionCategory)
    .is("connection_id", null)
    .maybeSingle();

  if (!data) {
    return undefined;
  }

  const capability = toObservationCapability(data as ObservationCapabilityRow);
  const permissionPolicyConfigured = await isGlobalPermissionPolicyConfigured(
    capability.provider,
    capability.actionCategory,
    deps
  );

  return { ...capability, permissionPolicyConfigured };

}
