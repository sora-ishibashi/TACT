// =========================
// TACT Runs — Governance Approval Inbox Read Projection (SOR-138 Slice 2A)
// =========================
//
// Pure, DB-free transform — same discipline as index.ts's own header
// comment: no business logic, no re-judging of permission/governance
// decisions, no DB access. Type-only imports from the leaf
// governance/types.ts file only (never the governance barrel, which
// pulls in store.ts's top-level getServiceRoleClient chain — see
// index.ts's own header comment on why that bundling rule exists).
//
// This is additive future-Human-Decision-Inbox groundwork only
// (SOR-184 does not consume this file in Slice 2A, and this file does
// not touch attentionInbox.ts/AttentionInbox.tsx/RunsSection.tsx —
// SOR-184 owns those). Whoever later builds the combined pre+post
// inbox calls this alongside the existing attention projection; it is
// not wired into any route or component here.

import type {
  GovernanceApprovalRequest,
  GovernanceApprovalRequestStatus,
  GovernanceDecision,
  GovernanceInvocation,
  GovernanceExecutionLink,
} from "../tact-execution/governance/types";
import type { ExecutionActorKind, ExecutionActionCategory, ExecutionProvider } from "../tact-execution/types";

// Truthful classification only (Human Owner decision, "EXECUTION
// OBSERVATION STATE"): a GovernanceInvocationExecutionLink existing for
// this invocation is the only provable "executed" signal this slice has.
// Its absence means only "no execution has been observed and linked for
// this decision yet" — it is NOT proof the action is still blockable
// (see approvalActionability below). "unknown" is reserved for source
// data this function cannot coherently relate at all; today that always
// collapses into the whole item being omitted (see
// toGovernanceApprovalInboxItemView's null return), kept in the type for
// forward completeness rather than invented a use for here.
export type GovernanceExecutionObservationState = "executed" | "no_execution_observed" | "unknown";

// Absolute condition (Human Owner decision 4 / "EXECUTION OBSERVATION
// STATE"): this is hardcoded "not_proven" for every item this slice ever
// produces. It exists specifically so a future UI cannot infer
// `status === "pending" && executionObservationState === "no_execution_observed"`
// as "safe to show an Approve button" — that inference requires a later,
// distinct trusted/actionable state this slice deliberately does not
// introduce (SOR-160/SOR-164/SOR-169 and later live-mediation work).
export type GovernanceApprovalActionability = "not_proven";

export interface GovernanceApprovalInboxItemView {

  approvalId: string;
  decisionId: string;
  invocationId: string;

  requestedAt: string;
  approvalStatus: GovernanceApprovalRequestStatus;

  actorKind: ExecutionActorKind;
  actorId: string | null;
  agentId: string | null;
  onBehalfOfActorKind: ExecutionActorKind | null;
  onBehalfOfActorId: string | null;

  actionCategory: ExecutionActionCategory;
  operation: string;

  targetProvider: ExecutionProvider | null;
  resourceType: string | null;
  resourceIdentifier: string | null;

  workId: string | null;

  reasonCode: string;
  matchedRuleIdentifier: string | null;
  policyVersion: string;

  executionObservationState: GovernanceExecutionObservationState;

  // Always "not_proven" in Slice 2A — see the type's own comment above.
  approvalActionability: GovernanceApprovalActionability;

}

/**
 * Builds one inbox item from already-fetched, already-decided rows. Returns
 * null (fail-closed omission, per the safest existing read-model convention)
 * when the three records are not coherently related — a caller bug, not a
 * real data state, and never worth guessing a row into existence for.
 */
export function toGovernanceApprovalInboxItemView(
  approvalRequest: GovernanceApprovalRequest,
  decision: GovernanceDecision,
  invocation: GovernanceInvocation,
  executionLinks: readonly GovernanceExecutionLink[]
): GovernanceApprovalInboxItemView | null {

  if (decision.id !== approvalRequest.governanceDecisionId) return null;
  if (invocation.id !== decision.invocationId) return null;

  if (
    decision.userId !== approvalRequest.userId ||
    invocation.userId !== approvalRequest.userId
  ) {
    return null;
  }

  const hasObservedLink = executionLinks.some((link) =>
    link.invocationId === invocation.id &&
    (link.effectiveGovernanceDecisionId === null || link.effectiveGovernanceDecisionId === decision.id)
  );

  const executionObservationState: GovernanceExecutionObservationState =
    hasObservedLink ? "executed" : "no_execution_observed";

  return {
    approvalId: approvalRequest.id,
    decisionId: decision.id,
    invocationId: invocation.id,

    requestedAt: approvalRequest.requestedAt,
    approvalStatus: approvalRequest.status,

    actorKind: decision.actorKindSnapshot,
    actorId: decision.actorIdSnapshot,
    agentId: decision.agentIdSnapshot,
    onBehalfOfActorKind: decision.onBehalfOfActorKindSnapshot,
    onBehalfOfActorId: decision.onBehalfOfActorIdSnapshot,

    actionCategory: decision.actionCategorySnapshot,
    operation: decision.operationSnapshot,

    targetProvider: decision.targetProviderSnapshot,
    resourceType: decision.resourceTypeSnapshot,
    resourceIdentifier: decision.resourceIdentifierSnapshot,

    workId: invocation.workId,

    reasonCode: decision.reasonCode,
    matchedRuleIdentifier: decision.policyIdentifierSnapshot,
    policyVersion: decision.policySetFingerprint,

    executionObservationState,
    approvalActionability: "not_proven",
  };

}
