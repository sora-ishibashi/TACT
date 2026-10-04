import type { JsonValue } from "@tact/execution-contract";
import type { ExecutionActorKind, ExecutionActionCategory, ExecutionProvider } from "../types";

export type GovernanceDecisionVerdict = "ALLOW" | "DENY" | "APPROVAL_REQUIRED" | "UNKNOWN";
export const GOVERNANCE_DECISION_VERDICTS: readonly GovernanceDecisionVerdict[] = ["ALLOW", "DENY", "APPROVAL_REQUIRED", "UNKNOWN"];
// Legacy/reserved (SOR-138 Slice 2A, Human Owner decision 3): GovernanceDecision's
// own approvalId/approvalStatus/approverKind/approverId/approvedAt fields (below)
// are kept in the schema/type for compatibility only. No Slice 2A code writes a
// non-null value into them, and current approval state is never sourced from them
// after this slice — see GovernanceApprovalRequest, the live record. They remain
// untouched here (not mutated, not dropped) and GovernanceDecision stays
// immutable/append-only exactly as Slice 1 left it.
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

// =========================
// GovernanceApprovalRequest (SOR-138 Slice 2A)
// =========================
//
// Separate, first-class pre-execution Human Decision record — never the
// post-execution tact_execution_attentions lifecycle, and never a mutation of
// GovernanceDecision (see the legacy-field comment above). One GovernanceDecision
// with verdict APPROVAL_REQUIRED has at most one GovernanceApprovalRequest,
// enforced by UNIQUE(governance_decision_id) at the DB layer (see the Slice 2A
// migration), not by any id-equality scheme — `id` is DB-generated
// (gen_random_uuid()) and plays no role in idempotency.
//
// Absolute condition (Human Owner decision 4): a GovernanceApprovalRequest,
// resolved or not, is NEVER an execution authorization token, lease, or
// replay/target/transaction-bound grant. "approved" means only "a human
// decision was recorded" — see approvalActionability on the read projection
// (tact-runs-view/governanceApprovalInbox.ts), which is hardcoded "not_proven"
// in this slice specifically so nothing downstream can infer otherwise.
export type GovernanceApprovalRequestStatus = "pending" | "approved" | "rejected";
export const GOVERNANCE_APPROVAL_REQUEST_STATUSES: readonly GovernanceApprovalRequestStatus[] = ["pending", "approved", "rejected"];

// Human-only resolver (SOR-138 Slice 2A, Human Owner correction 1):
// GovernanceApprovalRequest is a HUMAN approval record. Unlike every other
// actor field in this module (which uses the full ExecutionActorKind
// vocabulary — human/ai_agent/service/connector/system), resolvedByActorKind
// is deliberately narrowed to the single literal "human". An ai_agent,
// service, connector, or system actor approving/rejecting its own (or any)
// pending request is never a legitimate outcome in this slice — self/peer
// AI approval of a human-decision record is exactly the failure mode this
// type exists to make unrepresentable. resolvedByActorId stays opaque text
// (no auth.users FK — see GovernanceApprovalRequestInput's own comment)
// specifically so a future externally-authenticated human identity (e.g. a
// Slack user id) can resolve a request without this type changing.
export interface GovernanceApprovalRequest {
  id: string;
  userId: string;
  governanceDecisionId: string;
  status: GovernanceApprovalRequestStatus;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedByActorKind: "human" | null;
  resolvedByActorId: string | null;
  createdAt: string;
}

// The only shape a caller may supply to resolve a request. actorKind has
// exactly one legal value by construction — there is no other literal to
// pass, so a caller cannot even express an ai_agent/service/connector/system
// resolver at the type level, let alone have it accepted at runtime (see
// validateGovernanceApprovalResolver in ./validation.ts for the matching
// runtime + empty/whitespace-actorId rejection, and the Slice 2A migration's
// CHECK constraint for the third, DB-level enforcement layer).
export interface GovernanceApprovalResolver {
  actorKind: "human";
  actorId: string;
}

// No `id`: the DB assigns it (default gen_random_uuid()), unlike
// GovernanceInvocation/GovernanceDecision, whose first-decision determinism
// requirement (../governance/contract.ts) does not apply here — this table's
// own UNIQUE(governance_decision_id) constraint is the sole concurrency
// boundary (Human Owner decision, "CREATION SEMANTICS").
export interface GovernanceApprovalRequestInput {
  userId: string;
  governanceDecisionId: string;
}
export type RunsPermissionSnapshot =
  | { kind: "no_match" }
  | { kind: "matched_rule"; identifier: string; revision: number; userScope: "global" | "tenant"; subjectKind: ExecutionActorKind | null; actorId: string | null; agentId: string | null; provider: ExecutionProvider | null; targetProvider: ExecutionProvider | null; resourceType: string | null; actionCategory: ExecutionActionCategory | null; connectionId: string | null; priority: number; requiresKnownActorId: boolean; requiresKnownAgentId: boolean; decision: "allowed" | "denied" | "approval_required"; reasonCode: string }
  | { kind: "ambiguous"; candidates: Array<{ id: string; identifier: string; revision: number; decision: "allowed" | "denied" | "approval_required"; reasonCode: string; priority: number }> };
