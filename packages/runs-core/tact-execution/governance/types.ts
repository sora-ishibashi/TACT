import type { JsonValue } from "@tact/execution-contract";
import type { ExecutionActorKind, ExecutionActionCategory, ExecutionProvider } from "../types";

export type GovernanceDecisionVerdict = "ALLOW" | "DENY" | "APPROVAL_REQUIRED" | "UNKNOWN";
export const GOVERNANCE_DECISION_VERDICTS: readonly GovernanceDecisionVerdict[] = ["ALLOW", "DENY", "APPROVAL_REQUIRED", "UNKNOWN"];
export type GovernanceApprovalStatus = "approved" | "rejected";
export interface GovernanceInvocation {
  id: string; userId: string; organizationId: string | null; workspaceId: string | null; workId: string | null; connectionId: string | null;
  actorKind: ExecutionActorKind; actorId: string | null; agentId: string | null; onBehalfOfActorKind: ExecutionActorKind | null; onBehalfOfActorId: string | null;
  actionCategory: ExecutionActionCategory; operation: string; resourceType: string | null; resourceIdentifier: string | null; targetProvider: ExecutionProvider | null; attemptedAt: string; createdAt: string;
}
export interface GovernanceInvocationInput extends Omit<GovernanceInvocation, "createdAt"> {}
export interface GovernanceDecision {
  id: string; userId: string; invocationId: string; evaluatedAt: string;
  actorKindSnapshot: ExecutionActorKind; actorIdSnapshot: string | null; agentIdSnapshot: string | null; onBehalfOfActorKindSnapshot: ExecutionActorKind | null; onBehalfOfActorIdSnapshot: string | null;
  actionCategorySnapshot: ExecutionActionCategory; operationSnapshot: string; resourceTypeSnapshot: string | null; resourceIdentifierSnapshot: string | null; targetProviderSnapshot: ExecutionProvider | null;
  verdict: GovernanceDecisionVerdict; reasonCode: string; evaluatorVersion: string; decisionSource: "runs_permission_registry"; trustLevelSnapshot: "INTERNAL";
  policyIdentifierSnapshot: string | null; registryRuleIdSnapshot: string | null; registryRuleRevisionSnapshot: number | null; runsPermissionSnapshot: JsonValue; policySetFingerprint: string;
  approvalId: string | null; approvalStatus: GovernanceApprovalStatus | null; approverKind: ExecutionActorKind | null; approverId: string | null; approvedAt: string | null; createdAt: string;
}
export interface GovernanceDecisionInput extends Omit<GovernanceDecision, "createdAt"> {}
export interface GovernanceExecutionLink { id: string; userId: string; invocationId: string; effectiveGovernanceDecisionId: string | null; executionId: string; linkedAt: string; }
export interface GovernanceExecutionLinkInput { userId: string; invocationId: string; effectiveGovernanceDecisionId?: string | null; executionId: string; }
export type RunsPermissionSnapshot =
  | { kind: "no_match" }
  | { kind: "matched_rule"; identifier: string; revision: number; userScope: "global" | "tenant"; subjectKind: ExecutionActorKind | null; actorId: string | null; agentId: string | null; provider: ExecutionProvider | null; targetProvider: ExecutionProvider | null; resourceType: string | null; actionCategory: ExecutionActionCategory | null; connectionId: string | null; priority: number; requiresKnownActorId: boolean; requiresKnownAgentId: boolean; decision: "allowed" | "denied" | "approval_required"; reasonCode: string }
  | { kind: "ambiguous"; candidates: Array<{ id: string; identifier: string; revision: number; decision: "allowed" | "denied" | "approval_required"; reasonCode: string; priority: number }> };
