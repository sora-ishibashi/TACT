// =========================
// TACT Canonical Execution — Security Finding Derivation (SOR-178 / SEC-8D)
// =========================
//
// Pure functions only (no DB access, no randomness, no Date.now()) — same
// discipline as ../permission/attention.ts's deriveExecutionAttentionCandidate()
// and ../downstreamPermission/compare.ts. The caller (observe.ts) assigns a
// fresh id and calls the store layer; this file only decides WHETHER a
// Finding is eligible and WHICH fixed fields it carries.
//
// section5 (PermissionDecision -> Finding): denied is always eligible
// (DEFINITE_MISMATCH). unknown is eligible only when the action is a
// built-in high-impact category OR an explicitly configured rule matches
// (HIGH_IMPACT_UNKNOWN takes precedence when both match — section5: "prefer
// HIGH_IMPACT_UNKNOWN as the canonical basis, because it requires no
// mutable/external configuration to explain"). allowed/approval_required
// never produce a Finding (DECISION B: approval_required stays on the
// existing Attention path, never becomes a SecurityFinding).
//
// section4 (ambiguity-safe UNKNOWN rule matching): a rule dimension left
// null/undefined is a wildcard; multiple distinct matching rules are
// ambiguous and MUST NOT be resolved by guessing — fail closed (no
// CONFIGURED_UNKNOWN Finding from configuration) rather than arbitrarily
// picking one.
//
// section6 (Downstream comparison -> Finding): exactly one Finding
// candidate per evidence row whose relationToRuns === "CONFLICT" — never
// collapsed, never latest-wins. detectedAt uses the evidence's own
// observedAt (never execution time — SOR-164 boundary, section23).

import type { CanonicalExecution } from "../types";
import type { PermissionDecision } from "../permission/types";
import type { DownstreamPermissionComparisonResult } from "../downstreamPermission/compare";
import type { DownstreamPermissionEvidence } from "../downstreamPermission/types";
import {
  DEFAULT_CONFIGURED_UNKNOWN_ALERT_RULES,
  HIGH_IMPACT_ACTION_CATEGORIES,
  SECURITY_FINDING_EVALUATOR_VERSION,
  SECURITY_FINDING_REASON_CODES,
  type ConfiguredUnknownAlertRule,
  type SecurityFindingCandidate,
} from "./types";

function isHighImpactAction(execution: CanonicalExecution): boolean {
  return (HIGH_IMPACT_ACTION_CATEGORIES as readonly string[]).includes(execution.actionCategory);
}

function ruleDimensionMatches<T>(ruleValue: T | null | undefined, executionValue: T): boolean {
  // undefined/null on the rule is a wildcard for that dimension (section4).
  return ruleValue === null || ruleValue === undefined || ruleValue === executionValue;
}

function ruleMatchesExecution(rule: ConfiguredUnknownAlertRule, execution: CanonicalExecution): boolean {
  return (
    ruleDimensionMatches(rule.provider, execution.provider) &&
    ruleDimensionMatches(rule.targetProvider, execution.targetProvider) &&
    ruleDimensionMatches(rule.resourceType, execution.resourceType) &&
    ruleDimensionMatches(rule.actionCategory, execution.actionCategory)
  );
}

// 絶対条件(section4): 複数ruleがmatchした場合は推測で1つを選ばない
// ——ambiguousはno-matchと同じ扱い(fail-closed、Findingを作らない方を
// 優先する)。
function resolveConfiguredUnknownMatch(
  execution: CanonicalExecution,
  rules: readonly ConfiguredUnknownAlertRule[]
): ConfiguredUnknownAlertRule | null {

  const matches = rules.filter((rule) => ruleMatchesExecution(rule, execution));

  return matches.length === 1 ? matches[0] : null;

}

// =========================
// PermissionDecision -> Finding (section5)
// =========================

export function deriveRunsPermissionSecurityFindingCandidate(
  execution: CanonicalExecution,
  decision: PermissionDecision,
  permissionDecisionId: string,
  configuredUnknownRules: readonly ConfiguredUnknownAlertRule[] = DEFAULT_CONFIGURED_UNKNOWN_ALERT_RULES,
  evaluatorVersion: string = SECURITY_FINDING_EVALUATOR_VERSION
): SecurityFindingCandidate | null {

  if (decision.status === "denied") {

    return {
      userId: execution.userId,
      executionId: execution.id,
      findingType: "RUNS_REGISTERED_PERMISSION_MISMATCH",
      reasonCode: SECURITY_FINDING_REASON_CODES.RUNS_REGISTERED_PERMISSION_MISMATCH,
      eligibilityBasis: "DEFINITE_MISMATCH",
      evaluatorVersion,
      detectedAt: decision.evaluatedAt,
      permissionDecisionId,
      downstreamPermissionEvidenceId: null,
      configuredUnknownRuleId: null,
    };

  }

  if (decision.status === "unknown") {

    // section5 (絶対条件): both match => HIGH_IMPACT_UNKNOWN wins, because
    // it requires no mutable/external configuration to explain.
    if (isHighImpactAction(execution)) {

      return {
        userId: execution.userId,
        executionId: execution.id,
        findingType: "RUNS_REGISTERED_PERMISSION_UNKNOWN",
        reasonCode: SECURITY_FINDING_REASON_CODES.RUNS_REGISTERED_PERMISSION_UNKNOWN_HIGH_IMPACT,
        eligibilityBasis: "HIGH_IMPACT_UNKNOWN",
        evaluatorVersion,
        detectedAt: decision.evaluatedAt,
        permissionDecisionId,
        downstreamPermissionEvidenceId: null,
        configuredUnknownRuleId: null,
      };

    }

    const configuredMatch = resolveConfiguredUnknownMatch(execution, configuredUnknownRules);

    if (configuredMatch) {

      return {
        userId: execution.userId,
        executionId: execution.id,
        findingType: "RUNS_REGISTERED_PERMISSION_UNKNOWN",
        reasonCode: SECURITY_FINDING_REASON_CODES.RUNS_REGISTERED_PERMISSION_UNKNOWN_CONFIGURED,
        eligibilityBasis: "CONFIGURED_UNKNOWN",
        evaluatorVersion,
        detectedAt: decision.evaluatedAt,
        permissionDecisionId,
        downstreamPermissionEvidenceId: null,
        configuredUnknownRuleId: configuredMatch.id,
      };

    }

    // Low-impact, unconfigured, or ambiguously-configured unknown: no
    // Finding (fail closed — section4/section5, never guess).
    return null;

  }

  // allowed / approval_required: never a SecurityFinding (DECISION B,
  // section5 absolute condition "Do not call unknown denied" extends to
  // "never produce a Finding for a decision this module was not told to").
  return null;

}

// =========================
// Downstream comparison -> Finding (section6)
// =========================

export function deriveDownstreamPermissionSecurityFindingCandidates(
  execution: CanonicalExecution,
  permissionDecisionId: string,
  comparison: DownstreamPermissionComparisonResult,
  downstreamEvidence: readonly DownstreamPermissionEvidence[],
  evaluatorVersion: string = SECURITY_FINDING_EVALUATOR_VERSION
): SecurityFindingCandidate[] {

  const evidenceById = new Map(downstreamEvidence.map((evidence) => [evidence.id, evidence]));

  // 絶対条件(section6): 1行ごとに独立した候補を作る。conflictEvidenceIds
  // を1つのFindingへ畳み込まない。
  return comparison.evidenceComparisons
    .filter((item) => item.relationToRuns === "CONFLICT")
    .map((item) => {

      const evidence = evidenceById.get(item.evidenceId);

      // No-Fabrication: the comparison result and the evidence array must
      // come from the same caller-supplied list (observe.ts's contract) —
      // if an evidenceId cannot be resolved, this candidate is dropped
      // rather than fabricating a detectedAt from execution time.
      if (!evidence) {
        return null;
      }

      const candidate: SecurityFindingCandidate = {
        userId: execution.userId,
        executionId: execution.id,
        findingType: "DOWNSTREAM_PERMISSION_CONFLICT",
        reasonCode: SECURITY_FINDING_REASON_CODES.DOWNSTREAM_PERMISSION_CONFLICT,
        eligibilityBasis: "DOWNSTREAM_CONFLICT",
        evaluatorVersion,
        // section6/section23 (SOR-164 boundary): the evidence's own
        // observation time, never a guessed execution-time assertion.
        detectedAt: evidence.observedAt,
        permissionDecisionId,
        downstreamPermissionEvidenceId: evidence.id,
        configuredUnknownRuleId: null,
      };

      return candidate;

    })
    .filter((candidate): candidate is SecurityFindingCandidate => candidate !== null);

}
