// =========================
// TACT Canonical Execution — Downstream Permission Comparison (SOR-177 / SEC-8C)
// =========================
//
// PURE関数のみ(DBアクセス無し、副作用無し)。Observed Action
// (CanonicalExecution)・Runs Registered Permission(呼び出し元が明示的に
// 渡すPermissionDecision | null)・Downstream Permission Evidence(0..N行)
// の3つを、常に別々のfieldとして保持したまま比較する——1つのbooleanへ
// 畳み込まない(絶対条件、Human Owner section11)。
//
// 絶対条件(section11): どのPermissionDecisionを比較対象にするかは呼び出し元
// が決める。この関数自身が「最新のdecisionを自動選択する」ことは一切しない
// ——nullを渡された場合はNOT_COMPARABLEとして正直に扱う。
//
// 絶対条件(section14、SOR-164境界): このmoduleは「providerが実行時点で
// このactionを拒否していたのに実行された」というtransaction-bound
// authorizationの主張を一切行わない——downstreamActionPermissionConflict
// に相当するfieldは存在しない。temporalRelationは常に記述的(descriptive)
// なだけであり、relationToRuns/applicability/downstreamPermissionConflict
// のいずれの判定にも使わない。

import type { CanonicalExecution } from "../types";
import type { PermissionDecision } from "../permission/types";
import type {
  DownstreamEvidenceAuthorityLevel,
  DownstreamEvidenceTrustLevel,
  DownstreamPermissionEvidence,
  DownstreamPermissionState,
} from "./types";

export type DownstreamEvidenceRelationToRuns =
  | "CONSISTENT"
  | "CONFLICT"
  | "UNKNOWN"
  | "NOT_COMPARABLE"
  | "NOT_APPLICABLE";

export const DOWNSTREAM_EVIDENCE_RELATIONS_TO_RUNS: readonly DownstreamEvidenceRelationToRuns[] = [
  "CONSISTENT",
  "CONFLICT",
  "UNKNOWN",
  "NOT_COMPARABLE",
  "NOT_APPLICABLE",
];

export type DownstreamEvidenceTemporalRelation =
  | "BEFORE_EXECUTION_REFERENCE"
  | "AFTER_EXECUTION_REFERENCE"
  | "SAME_INSTANT"
  | "UNKNOWN";

export interface DownstreamEvidenceApplicability {

  applicable: boolean;

  // 「何が一致しなかったか」を説明する固定reasonCode
  // (PermissionDecision.reasonCode/GovernanceDecision.reasonCodeと同じ
  // 「固定文字列、自由形式JSONではない」規約)。
  reasonCode: string;

}

export interface DownstreamEvidenceComparison {

  evidenceId: string;

  permissionState: DownstreamPermissionState;

  authorityLevel: DownstreamEvidenceAuthorityLevel;

  trustLevel: DownstreamEvidenceTrustLevel;

  observedAt: string;

  recordedAt: string;

  applicability: DownstreamEvidenceApplicability;

  relationToRuns: DownstreamEvidenceRelationToRuns;

  temporalRelation: DownstreamEvidenceTemporalRelation;

}

export interface DownstreamPermissionComparisonInput {

  execution: CanonicalExecution;

  // 絶対条件(section11): 呼び出し元が明示的に選んだ1件、またはnull
  // (比較対象のPermission Decisionが無い/選ばない、という正直な表現)。
  // この関数自身が複数件から「最新」を選ぶことは一切しない。
  registeredPermissionResult: PermissionDecision | null;

  downstreamEvidence: readonly DownstreamPermissionEvidence[];

}

export interface DownstreamPermissionComparisonResult {

  registeredPermissionResult: PermissionDecision | null;

  observedAction: {
    actionCategory: CanonicalExecution["actionCategory"];
    operation: CanonicalExecution["operation"];
    resourceType: CanonicalExecution["resourceType"];
    resourceIdentifier: CanonicalExecution["resourceIdentifier"];
    status: CanonicalExecution["status"];
  };

  evidenceComparisons: DownstreamEvidenceComparison[];

  // section13(絶対条件): 「applicableかつAUTHORITATIVEで、かつ確定的な
  // allowed/deniedを持つ行」が1件も無いことだけを表す——Runs側の状態とは
  // 無関係(absence is NEVER deny、Runs decisionの有無にも依存しない)。
  downstreamPermissionUnknown: boolean;

  // section16(絶対条件): 「applicableかつAUTHORITATIVEな行のうち、少なくとも
  // 1件がCONFLICT」の場合のみtrue。複数行がある場合もlatest-winsにしない
  // ——matchしたすべての行のidをconflictEvidenceIdsへ列挙する。
  downstreamPermissionConflict: boolean;

  conflictEvidenceIds: string[];

}

// =========================
// Applicability (section12、絶対条件: 未知のidentityをwildcard一致にしない)
// =========================

// 両辺が既知かつ不一致の場合のみfalse。片方だけ既知(もう片方null)の場合は
// 「不十分な情報」としてfalse(=insufficient、wildcard化しない)。両方null
// の場合のみ、このdimension自体は「満たされた」とみなす(両者ともその
// identityを持たない、という一致した事実)。
function dimensionMatches(executionValue: string | null, evidenceValue: string | null): boolean {

  if (executionValue === null && evidenceValue === null) {
    return true;
  }

  if (executionValue === null || evidenceValue === null) {
    return false;
  }

  return executionValue === evidenceValue;

}

function assessApplicability(
  execution: CanonicalExecution,
  evidence: DownstreamPermissionEvidence
): DownstreamEvidenceApplicability {

  // 絶対条件(section12、Human Owner指示): execution.targetProviderがnull
  // の場合、execution.providerへ無断で代入しない——SOR-51 M-0時点で
  // targetProvider=nullは「providerそのものが対象system」のケース
  // (Slack app_mention等、../permission/types.tsのPermissionPolicyRule.
  // targetProviderコメント参照)だが、registryの既存match方式はこれを
  // 「ruleがtargetProviderを指定しないwildcard」として扱っているだけで、
  // 「execution.providerがtargetである」という断定をどこでも行っていない。
  // Downstream Evidenceという「外部providerの実際のACL」を主張する文脈
  // では、この代入はguessingに当たるため、targetProvider不明は常に
  // insufficient(not applicable)として扱う。
  if (execution.targetProvider === null) {
    return { applicable: false, reasonCode: "execution_target_provider_unknown" };
  }

  if (evidence.targetProvider !== execution.targetProvider) {
    return { applicable: false, reasonCode: "target_provider_mismatch" };
  }

  if (!dimensionMatches(execution.connectionId, evidence.connectionId)) {
    return { applicable: false, reasonCode: "connection_mismatch" };
  }

  if (evidence.subjectKind !== execution.actorKind) {
    return { applicable: false, reasonCode: "subject_kind_mismatch" };
  }

  if (!dimensionMatches(execution.actorId, evidence.subjectId)) {
    return { applicable: false, reasonCode: "subject_id_mismatch" };
  }

  if (!dimensionMatches(execution.agentId, evidence.agentId)) {
    return { applicable: false, reasonCode: "agent_mismatch" };
  }

  if (evidence.actionCategory !== execution.actionCategory) {
    return { applicable: false, reasonCode: "action_category_mismatch" };
  }

  if (evidence.operation !== execution.operation) {
    return { applicable: false, reasonCode: "operation_mismatch" };
  }

  if (!dimensionMatches(execution.resourceType, evidence.resourceType)) {
    return { applicable: false, reasonCode: "resource_type_mismatch" };
  }

  if (!dimensionMatches(execution.resourceIdentifier, evidence.resourceIdentifier)) {
    return { applicable: false, reasonCode: "resource_identifier_mismatch" };
  }

  return { applicable: true, reasonCode: "applicable" };

}

// =========================
// Temporal relation (section15、絶対条件: 記述的なだけ、判定に使わない)
// =========================

function resolveExecutionTemporalReference(execution: CanonicalExecution): string {
  // section15: providerOccurredAtを優先し、無ければobservedAtを使う。
  return execution.providerOccurredAt ?? execution.observedAt;
}

function computeTemporalRelation(
  executionReferenceAt: string,
  evidenceObservedAt: string
): DownstreamEvidenceTemporalRelation {

  const referenceMs = Date.parse(executionReferenceAt);
  const evidenceMs = Date.parse(evidenceObservedAt);

  if (Number.isNaN(referenceMs) || Number.isNaN(evidenceMs)) {
    return "UNKNOWN";
  }

  if (evidenceMs === referenceMs) {
    return "SAME_INSTANT";
  }

  return evidenceMs < referenceMs ? "BEFORE_EXECUTION_REFERENCE" : "AFTER_EXECUTION_REFERENCE";

}

// =========================
// Per-row comparison (section13、固定の2値比較matrix)
// =========================

function isDefiniteRunsState(status: PermissionDecision["status"]): status is "allowed" | "denied" {
  return status === "allowed" || status === "denied";
}

function compareEvidenceRow(
  execution: CanonicalExecution,
  registeredPermissionResult: PermissionDecision | null,
  evidence: DownstreamPermissionEvidence
): DownstreamEvidenceComparison {

  const applicability = assessApplicability(execution, evidence);
  const temporalRelation = computeTemporalRelation(resolveExecutionTemporalReference(execution), evidence.observedAt);

  let relationToRuns: DownstreamEvidenceRelationToRuns;

  if (!applicability.applicable) {

    relationToRuns = "NOT_APPLICABLE";

  } else if (registeredPermissionResult === null || !isDefiniteRunsState(registeredPermissionResult.status)) {

    // section13(絶対条件): Runs側がunknown/approval_required、または
    // 比較対象のdecisionそのものが無い場合は、どちらも「2値で比較できる
    // Runs側の答えが無い」という同じ構造的事実——NOT_COMPARABLEへ統一する
    // (provider ACL "allowed"がRunsのapproval_requiredと矛盾しない、という
    // section13の絶対条件もこの分岐で自動的に満たされる——Runsが上位の
    // approval governanceを課しているだけであり、"unauthorized"ではない)。
    relationToRuns = "NOT_COMPARABLE";

  } else if (evidence.authorityLevel !== "AUTHORITATIVE" || evidence.permissionState === "unknown") {

    // 絶対条件: NON_AUTHORITATIVE/UNKNOWN authority、およびAUTHORITATIVE
    // でもpermissionState=unknownの行は、一致していても矛盾していても
    // CONSISTENT/CONFLICTを主張しない。
    relationToRuns = "UNKNOWN";

  } else {

    const runsAllowed = registeredPermissionResult.status === "allowed";
    const downstreamAllowed = evidence.permissionState === "allowed";

    relationToRuns = runsAllowed === downstreamAllowed ? "CONSISTENT" : "CONFLICT";

  }

  return {
    evidenceId: evidence.id,
    permissionState: evidence.permissionState,
    authorityLevel: evidence.authorityLevel,
    trustLevel: evidence.trustLevel,
    observedAt: evidence.observedAt,
    recordedAt: evidence.recordedAt,
    applicability,
    relationToRuns,
    temporalRelation,
  };

}

// =========================
// Top-level comparison (section16、絶対条件: silent latest-winsをしない)
// =========================

export function compareDownstreamPermissionEvidence(
  input: DownstreamPermissionComparisonInput
): DownstreamPermissionComparisonResult {

  // 絶対条件(section16): 全行を個別に比較する。並べ替え・重複排除・
  // 「最新のみ残す」操作を一切行わない——inputの配列順をそのまま1:1で
  // evidenceComparisonsへ写す。
  const evidenceComparisons = input.downstreamEvidence.map((evidence) =>
    compareEvidenceRow(input.execution, input.registeredPermissionResult, evidence)
  );

  // section13(絶対条件): Runs側の状態とは無関係に、evidence自身が確定的な
  // 答えを持っているかだけを見る(absence is NEVER deny)。
  const hasDefiniteAuthoritativeEvidence = evidenceComparisons.some(
    (comparison) =>
      comparison.applicability.applicable &&
      comparison.authorityLevel === "AUTHORITATIVE" &&
      (comparison.permissionState === "allowed" || comparison.permissionState === "denied")
  );

  const conflictEvidenceIds = evidenceComparisons
    .filter((comparison) => comparison.relationToRuns === "CONFLICT")
    .map((comparison) => comparison.evidenceId);

  return {
    registeredPermissionResult: input.registeredPermissionResult,
    observedAction: {
      actionCategory: input.execution.actionCategory,
      operation: input.execution.operation,
      resourceType: input.execution.resourceType,
      resourceIdentifier: input.execution.resourceIdentifier,
      status: input.execution.status,
    },
    evidenceComparisons,
    downstreamPermissionUnknown: !hasDefiniteAuthoritativeEvidence,
    downstreamPermissionConflict: conflictEvidenceIds.length > 0,
    conflictEvidenceIds,
  };

}
