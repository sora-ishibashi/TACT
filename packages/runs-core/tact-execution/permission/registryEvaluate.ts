// =========================
// TACT Canonical Execution — Permission Registry Evaluator (SOR-47)
// =========================
//
// core/tact-execution/permission/evaluate.ts(静的allowlist経由、既存
// evaluatePermission())とは並行稼働する、DB-backed Permission
// Registry経由の評価器。Phase1では未接続(observeExecutionPermission()
// のdefault依存は既存のまま、Human Owner指示section F「Do NOT cut
// over」)——cutoverは別途の明示的な承認を得てから行う。
//
// evaluatePermissionFromRegistry(): 既に取得済みのrule集合に対する
// pure matching/ambiguity判定(DBアクセスなし、テスト容易性を優先)。
// evaluatePermissionWithRules(): registryStore.tsから対象userの有効な
// rule集合を取得した上でevaluatePermissionFromRegistry()を呼ぶ、
// 実際の呼び出し入口(async、DB-backed)。

import type { JsonValue } from "@tact/execution-contract";
import type { CanonicalExecution } from "../types";
import { resolvePermissionSubject } from "./resolveSubject";
import { listActivePermissionRulesForMatching } from "./registryStore";
import type { PermissionDecision, PermissionRegistryRule, PermissionSubject } from "./types";

export const PERMISSION_REGISTRY_EVALUATOR_VERSION = "permission-evaluator-registry-v1";

const NO_MATCHING_RULE_REASON_CODE = "no_matching_registry_rule";
const AMBIGUOUS_RULES_REASON_CODE = "ambiguous_registry_rules";

export interface PermissionRegistryMatchContext {
  provider: CanonicalExecution["provider"] | null;
  targetProvider: CanonicalExecution["targetProvider"];
  resourceType: CanonicalExecution["resourceType"];
  actionCategory: CanonicalExecution["actionCategory"];
  agentId: CanonicalExecution["agentId"];
  connectionId: CanonicalExecution["connectionId"];
}

// Human Owner指示(SOR-47 revised design section1「Principal/Agent
// scope」): 静的allowlist(policy.tsのmatchesRule())と同じ判定に加え、
// actorId/agentIdの厳格一致checkを追加する。ruleのnullは常に
// wildcard(そのfieldを一切見ない)。
export function matchesRegistryRule(
  rule: PermissionRegistryRule,
  subject: PermissionSubject,
  execution: PermissionRegistryMatchContext
): boolean {

  if (rule.subjectKind !== null && rule.subjectKind !== subject.kind) {
    return false;
  }

  if (rule.provider !== null && rule.provider !== execution.provider) {
    return false;
  }

  if (rule.targetProvider !== null && rule.targetProvider !== execution.targetProvider) {
    return false;
  }

  if (rule.resourceType !== null && rule.resourceType !== execution.resourceType) {
    return false;
  }

  if (rule.actionCategory !== null && rule.actionCategory !== execution.actionCategory) {
    return false;
  }

  // 絶対条件(既存policy.tsのmatchesRule()と同じ「推測しない」原則):
  // 既知性のみを要求するrequiresKnown*と、特定ID一致を要求する
  // actorId/agentIdは独立したcheckとして両方適用する——specific
  // actorId/agentIdを設定したruleは、この2つのcheckにより「既知で
  // あり、かつそのIDと一致する」ことを自動的に要求する(specific
  // matchはrequiresKnown*を包含する、SOR-47 revised design section2)。
  if (rule.requiresKnownActorId && !subject.id) {
    return false;
  }

  if (rule.requiresKnownAgentId && !execution.agentId) {
    return false;
  }

  if (rule.actorId !== null && rule.actorId !== subject.id) {
    return false;
  }

  if (rule.agentId !== null && rule.agentId !== execution.agentId) {
    return false;
  }

  // account scope = connectionId matching(SOR-47 revised design
  // section7、repository realityの調査結果に基づく)。
  if (rule.connectionId !== null && rule.connectionId !== execution.connectionId) {
    return false;
  }

  return true;

}

// 半開区間[validFrom, validUntil)。Human Owner指示section6。
export function isPermissionRuleValidAt(rule: PermissionRegistryRule, asOf: Date): boolean {

  const asOfMs = asOf.getTime();

  if (rule.validFrom !== null && asOfMs < Date.parse(rule.validFrom)) {
    return false;
  }

  if (rule.validUntil !== null && asOfMs >= Date.parse(rule.validUntil)) {
    return false;
  }

  return true;

}

// 過去のPermission Decisionを、現在のmutable rule行を一切参照せずに
// 説明できるようにするための、match時点のsnapshot(Human Owner指示
// section3「Historical explainability」、SOR-47 revised design
// section9)。小さく・固定shapeであり、巨大JSON dump禁止の絶対条件に
// 抵触しない。
function buildRuleSnapshot(rule: PermissionRegistryRule): JsonValue {
  return {
    identifier: rule.identifier,
    revision: rule.revision,
    userScope: rule.userId === null ? "global" : "tenant",
    subjectKind: rule.subjectKind,
    actorId: rule.actorId,
    agentId: rule.agentId,
    provider: rule.provider,
    targetProvider: rule.targetProvider,
    resourceType: rule.resourceType,
    actionCategory: rule.actionCategory,
    connectionId: rule.connectionId,
    priority: rule.priority,
    requiresKnownActorId: rule.requiresKnownActorId,
    requiresKnownAgentId: rule.requiresKnownAgentId,
    decision: rule.decision,
    reasonCode: rule.reasonCode,
  };
}

// pure(DBアクセスなし)——rulesは呼び出し元が既に取得済みの候補集合
// (tenant行 + global fallback行、enabled/disabledいずれも混在してよい
// ——enabled判定はこの関数内で行う)。
export function evaluatePermissionFromRegistry(
  subject: PermissionSubject,
  execution: CanonicalExecution,
  rules: readonly PermissionRegistryRule[],
  asOf: Date = new Date()
): PermissionDecision {

  const evaluatedAt = asOf.toISOString();

  const candidates = rules.filter(
    (rule) => rule.enabled && isPermissionRuleValidAt(rule, asOf) && matchesRegistryRule(rule, subject, execution)
  );

  // Human Owner指示(precedence): tenant-specific ruleは常にglobal
  // fallback ruleに優先する。v1-minimalには restrictive overlay
  // tierが存在しない(SOR-47 revised design section3)。
  const tenantMatches = candidates.filter((rule) => rule.userId !== null);
  const globalMatches = candidates.filter((rule) => rule.userId === null);
  const winningTier = tenantMatches.length > 0 ? tenantMatches : globalMatches;

  if (winningTier.length === 0) {

    return {
      executionId: execution.id,
      status: "unknown",
      reasonCode: NO_MATCHING_RULE_REASON_CODE,
      policyId: null,
      evaluatorVersion: PERMISSION_REGISTRY_EVALUATOR_VERSION,
      evaluatedAt,
      registryRuleId: null,
      registryRuleRevision: null,
    };

  }

  const minPriority = Math.min(...winningTier.map((rule) => rule.priority));
  const topGroup = winningTier.filter((rule) => rule.priority === minPriority);

  // 絶対条件(Human Owner指示、2回目の修正): 同一tier+priorityで
  // 複数ruleがmatchした場合、decisionが一致していても推測で選ばない
  // ——policy_id/reason_code/registry_rule_id/snapshotの由来が
  // 曖昧になるため。
  if (topGroup.length > 1) {

    return {
      executionId: execution.id,
      status: "unknown",
      reasonCode: AMBIGUOUS_RULES_REASON_CODE,
      policyId: null,
      evaluatorVersion: PERMISSION_REGISTRY_EVALUATOR_VERSION,
      evaluatedAt,
      registryRuleId: null,
      registryRuleRevision: null,
      metadata: { ambiguousRuleIds: topGroup.map((rule) => rule.id) },
    };

  }

  const rule = topGroup[0];

  return {
    executionId: execution.id,
    status: rule.decision,
    reasonCode: rule.reasonCode,
    policyId: rule.identifier,
    evaluatorVersion: PERMISSION_REGISTRY_EVALUATOR_VERSION,
    evaluatedAt,
    registryRuleId: rule.id,
    registryRuleRevision: rule.revision,
    metadata: buildRuleSnapshot(rule),
  };

}

export interface EvaluatePermissionWithRulesDeps {
  listActivePermissionRulesForMatching: typeof listActivePermissionRulesForMatching;
}

const defaultDeps: EvaluatePermissionWithRulesDeps = {
  listActivePermissionRulesForMatching,
};

// 実際の呼び出し入口(async、DB-backed)。
//
// 絶対条件(SOR-47 Phase2): deps.listActivePermissionRulesForMatching()
// がRegistryUnavailableError(registryStore.ts)をthrowした場合、この
// 関数自身はそれを一切catchせず、そのまま呼び出し元へ伝播させる
// ——「読み込めなかった」ことを「matchしなかった」(unknown)へ
// 変換しない(Human Owner指示、最重要)。呼び出し元
// (evaluatePermissionForObservation() → observe.ts →
// 各adapterの既存Capture Failure Policy)が、この伝播を前提に
// 独立したstage単位のtry/catchで処理する。
export async function evaluatePermissionWithRules(
  execution: CanonicalExecution,
  userId: string,
  deps: EvaluatePermissionWithRulesDeps = defaultDeps
): Promise<PermissionDecision> {

  const subject = resolvePermissionSubject(execution);
  const rules = await deps.listActivePermissionRulesForMatching(userId);

  return evaluatePermissionFromRegistry(subject, execution, rules);

}

// =========================
// SOR-47 Phase2: Evaluator Cutover
// =========================
//
// core/tact-execution/permission/observe.tsのObserveExecutionPermissionDeps.
// evaluatePermissionスロットへ、Phase2からdefaultで接続する関数
// (Human Owner指示「observeExecutionPermission should use the
// registry-backed evaluator by default」)。呼び出し形状
// (execution一つだけを受け取りPermission Decisionを返す)は、既存の
// 静的評価器evaluatePermission()(evaluate.ts、cutover後もtests/
// migration equivalence/dev utilities向けにそのまま残る、絶対に
// 削除・変更しない)と同じシグネチャ位置を保つため、userIdは
// execution.userId(既存フィールド、SOR-50から存在)からそのまま導出
// する——ObserveExecutionPermissionDeps自体の形を広げない、
// 「smallest safe cutover」(Human Owner指示)。
//
// sync(旧evaluatePermission())からasyncへのsignature変更が、この
// cutoverで必要な唯一のcontract変更(DB-backed評価はどうしても非同期
// になるため、Human Owner側でも織り込み済み——SOR-47設計段階で
// 「a new DB table + a sync→async evaluator signature change」として
// 明示的に言及されている)。
export async function evaluatePermissionForObservation(
  execution: CanonicalExecution,
  deps: EvaluatePermissionWithRulesDeps = defaultDeps
): Promise<PermissionDecision> {

  return evaluatePermissionWithRules(execution, execution.userId, deps);

}
