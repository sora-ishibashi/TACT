// =========================
// TACT Canonical Execution — Integration & Observation Registry Types (SOR-14)
// =========================
//
// 「接続されているか」ではなく「何を、どの方法で、どこまで観測
// できるか」を表現する契約。絶対条件: 以下5つは別概念であり、単一の
// connected/supported booleanへ潰さない。
//   1. Observation capability      -- ObservationCapability本体
//   2. Permission-policy availability -- permissionPolicyConfigured
//        (このmoduleでは保存しない、都度導出するderived field)
//   3. Execution capability        -- このmoduleのscope外(SOR-31)
//   4. Verification status         -- VerificationStatus
//   5. Per-action coverage         -- row grain(provider,
//        observationPath, actionCategory)自体で表現

import type { ExecutionActionCategory, ExecutionObservationMode, ExecutionProvider } from "../types";

export type VerificationStatus = "live_verified" | "mock_only" | "unverified";

export const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  "live_verified",
  "mock_only",
  "unverified",
];

export type AttributionConfidence = "none" | "low" | "medium" | "high";

export const ATTRIBUTION_CONFIDENCES: readonly AttributionConfidence[] = ["none", "low", "medium", "high"];

// SOR-131: Runs v1 observation priority(docs/architecture/
// runs-v1-observation-first-connection-strategy.md §4)。優先順位の
// 上下は「正当性の階層」ではなく「新しい観測経路を作る際にどこまで
// 到達を目指すか」の指針——現時点でinlineを使うadapterは無い
// (ExecutionObservationModeの既存コメント参照)。Browser/Desktop
// observationはv1では扱わないためこの配列に含まれない。
export const OBSERVATION_MODE_PRIORITY_V1: readonly ExecutionObservationMode[] = [
  "inline",
  "instrumented",
  "reconciled",
];

// SOR-130絶対条件(Work IDについて): legitimateなexplicit carrierが
// 無い限り'none'。'explicit_claim'は呼び出し元(adapter/MCPホスト等)
// がworkIdを明示的に主張できる経路、'reconciled_correlation'は
// Structural Correlator(core/tact-execution/correlation/)による
// 事後相関のみで到達しうる経路を指す。
export type WorkContextCarrier = "none" | "explicit_claim" | "reconciled_correlation";

export const WORK_CONTEXT_CARRIERS: readonly WorkContextCarrier[] = [
  "none",
  "explicit_claim",
  "reconciled_correlation",
];

export interface ObservationCapability {

  id: string;

  // ---- Identity ----
  provider: ExecutionProvider;
  // providerが実体を表せない場合(例: GitHub→'custom')の補足識別子。
  providerLabel: string | null;
  // adapterVersion文字列そのもの(例: 'notion-mcp-v1')。
  observationPath: string;
  actionCategory: ExecutionActionCategory;

  // ---- Observation capability ----
  observationMode: ExecutionObservationMode | null;
  preExecutionVisible: boolean;
  canBlockOrRequireApproval: boolean;
  principalAttributionAvailable: boolean;
  principalAttributionConfidence: AttributionConfidence | null;
  agentAttributionAvailable: boolean;
  agentAttributionConfidence: AttributionConfidence | null;
  workContextCarrier: WorkContextCarrier;
  reconciliationAvailable: boolean;

  // ---- Privacy characteristics ----
  excludesRawPayload: boolean;
  privacyNotes: string | null;

  // ---- Credential custody / owner ----
  credentialCustody: string | null;

  // ---- Verification status ----
  verificationStatus: VerificationStatus;
  verificationNote: string | null;

  // ---- Optional connection-level scope ----
  connectionId: string | null;

  createdAt: string;
  updatedAt: string;

}

// SOR-130絶対条件(permissionStatus UNKNOWNとobservation failureを
// 混同しない、permission-policy availabilityを別概念として扱う):
// このfieldはtact_execution_observation_registry自体には保存せず、
// tact_execution_permission_rulesへ都度問い合わせて導出する
// (単一の真実源、drift防止)。ObservationCapabilityWithPermissionInfo
// はAPI/store層の読み取り結果としてのみ存在する合成型。
export interface ObservationCapabilityWithPermissionInfo extends ObservationCapability {
  // グローバル(user_id is null)のPermission Registryに、この
  // provider/actionCategoryへ適用されうるenabledなruleが存在するか。
  // falseは「未設定」を意味するだけで、observation自体の失敗ではない
  // (SOR-130の教訓)。
  permissionPolicyConfigured: boolean;
}

export interface ObservationCapabilityRow {
  id: string;
  provider: string;
  provider_label: string | null;
  observation_path: string;
  action_category: string;
  observation_mode: string | null;
  pre_execution_visible: boolean;
  can_block_or_require_approval: boolean;
  principal_attribution_available: boolean;
  principal_attribution_confidence: string | null;
  agent_attribution_available: boolean;
  agent_attribution_confidence: string | null;
  work_context_carrier: string;
  reconciliation_available: boolean;
  excludes_raw_payload: boolean;
  privacy_notes: string | null;
  credential_custody: string | null;
  verification_status: string;
  verification_note: string | null;
  connection_id: string | null;
  created_at: string;
  updated_at: string;
}

export function toObservationCapability(row: ObservationCapabilityRow): ObservationCapability {
  return {
    id: row.id,
    provider: row.provider as ExecutionProvider,
    providerLabel: row.provider_label,
    observationPath: row.observation_path,
    actionCategory: row.action_category as ExecutionActionCategory,
    observationMode: row.observation_mode as ExecutionObservationMode | null,
    preExecutionVisible: row.pre_execution_visible,
    canBlockOrRequireApproval: row.can_block_or_require_approval,
    principalAttributionAvailable: row.principal_attribution_available,
    principalAttributionConfidence: row.principal_attribution_confidence as AttributionConfidence | null,
    agentAttributionAvailable: row.agent_attribution_available,
    agentAttributionConfidence: row.agent_attribution_confidence as AttributionConfidence | null,
    workContextCarrier: row.work_context_carrier as WorkContextCarrier,
    reconciliationAvailable: row.reconciliation_available,
    excludesRawPayload: row.excludes_raw_payload,
    privacyNotes: row.privacy_notes,
    credentialCustody: row.credential_custody,
    verificationStatus: row.verification_status as VerificationStatus,
    verificationNote: row.verification_note,
    connectionId: row.connection_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListObservationCapabilitiesFilter {
  provider?: ExecutionProvider;
  actionCategory?: ExecutionActionCategory;
  verificationStatus?: VerificationStatus;
}
