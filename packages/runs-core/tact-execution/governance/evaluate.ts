import { createHash } from "node:crypto";
import { isPermissionRuleValidAt, matchesRegistryRule, PERMISSION_REGISTRY_EVALUATOR_VERSION } from "../permission/registryEvaluate";
import type { PermissionRegistryRule, PermissionSubject } from "../permission/types";
import type { GovernanceDecisionInput, GovernanceInvocation, RunsPermissionSnapshot } from "./types";

const MAX_AMBIGUOUS_CANDIDATES = 20;
const verdict = (value: "allowed" | "denied" | "approval_required") => value === "allowed" ? "ALLOW" : value === "denied" ? "DENY" : "APPROVAL_REQUIRED" as const;

/** SHA-256 of the enabled, time-effective registry rules supplied to this evaluation,
 * sorted by immutable identity/revision/identifier. It contains no rule payload or secret. */
export function policySetFingerprint(rules: readonly PermissionRegistryRule[], asOf: Date): string {
  const canonical = rules.filter((r) => r.enabled && isPermissionRuleValidAt(r, asOf))
    .map((r) => `${r.id}\u001f${r.revision}\u001f${r.identifier}\u001f${r.enabled ? "1" : "0"}`)
    .sort().join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function buildGovernanceDecisionFromRegistry(
  invocation: GovernanceInvocation,
  decisionId: string,
  rules: readonly PermissionRegistryRule[],
  asOf = new Date()
): GovernanceDecisionInput {
  const subject: PermissionSubject = { kind: invocation.actorKind, id: invocation.actorId };
  const context = { provider: null, targetProvider: invocation.targetProvider, resourceType: invocation.resourceType, actionCategory: invocation.actionCategory, agentId: invocation.agentId, connectionId: invocation.connectionId };
  const candidates = rules.filter((r) => r.enabled && isPermissionRuleValidAt(r, asOf) && matchesRegistryRule(r, subject, context));
  const tier = candidates.some((r) => r.userId !== null) ? candidates.filter((r) => r.userId !== null) : candidates;
  const best = tier.length === 0 ? [] : tier.filter((r) => r.priority === Math.min(...tier.map((r) => r.priority)));
  let decision: Pick<GovernanceDecisionInput, "verdict" | "reasonCode" | "policyIdentifierSnapshot" | "registryRuleIdSnapshot" | "registryRuleRevisionSnapshot" | "runsPermissionSnapshot">;
  if (best.length === 0) {
    decision = { verdict: "UNKNOWN", reasonCode: "no_matching_registry_rule", policyIdentifierSnapshot: null, registryRuleIdSnapshot: null, registryRuleRevisionSnapshot: null, runsPermissionSnapshot: { kind: "no_match" } };
  } else if (best.length > 1) {
    if (best.length > MAX_AMBIGUOUS_CANDIDATES) throw new Error("ambiguous registry candidate set exceeds fixed evidence limit");
    decision = { verdict: "UNKNOWN", reasonCode: "ambiguous_registry_rules", policyIdentifierSnapshot: null, registryRuleIdSnapshot: null, registryRuleRevisionSnapshot: null, runsPermissionSnapshot: { kind: "ambiguous", candidates: best.map((r) => ({ id: r.id, identifier: r.identifier, revision: r.revision, decision: r.decision, reasonCode: r.reasonCode, priority: r.priority })).sort((a, b) => a.id.localeCompare(b.id)) } };
  } else {
    const r = best[0];
    const snapshot: RunsPermissionSnapshot = { kind: "matched_rule", identifier: r.identifier, revision: r.revision, userScope: r.userId === null ? "global" : "tenant", subjectKind: r.subjectKind, actorId: r.actorId, agentId: r.agentId, provider: r.provider, targetProvider: r.targetProvider, resourceType: r.resourceType, actionCategory: r.actionCategory, connectionId: r.connectionId, priority: r.priority, requiresKnownActorId: r.requiresKnownActorId, requiresKnownAgentId: r.requiresKnownAgentId, decision: r.decision, reasonCode: r.reasonCode };
    decision = { verdict: verdict(r.decision), reasonCode: r.reasonCode, policyIdentifierSnapshot: r.identifier, registryRuleIdSnapshot: r.id, registryRuleRevisionSnapshot: r.revision, runsPermissionSnapshot: snapshot };
  }
  return { id: decisionId, userId: invocation.userId, invocationId: invocation.id, evaluatedAt: asOf.toISOString(), actorKindSnapshot: invocation.actorKind, actorIdSnapshot: invocation.actorId, agentIdSnapshot: invocation.agentId, onBehalfOfActorKindSnapshot: invocation.onBehalfOfActorKind, onBehalfOfActorIdSnapshot: invocation.onBehalfOfActorId, actionCategorySnapshot: invocation.actionCategory, operationSnapshot: invocation.operation, resourceTypeSnapshot: invocation.resourceType, resourceIdentifierSnapshot: invocation.resourceIdentifier, targetProviderSnapshot: invocation.targetProvider, evaluatorVersion: PERMISSION_REGISTRY_EVALUATOR_VERSION, decisionSource: "runs_permission_registry", trustLevelSnapshot: "INTERNAL", policySetFingerprint: policySetFingerprint(rules, asOf), approvalId: null, approvalStatus: null, approverKind: null, approverId: null, approvedAt: null, ...decision };
}
