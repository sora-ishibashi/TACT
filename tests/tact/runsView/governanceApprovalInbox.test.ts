// =========================
// SOR-138 Slice 2A — Governance Approval Inbox read projection
// =========================
//
// Pure-function tests (no DB, no fakes needed) for
// toGovernanceApprovalInboxItemView(). Covers Human Owner test
// requirements 17, 18, 19.

import { toGovernanceApprovalInboxItemView } from "@tact/runs-core/tact-runs-view/governanceApprovalInbox";
import type {
  GovernanceApprovalRequest,
  GovernanceDecision,
  GovernanceInvocation,
  GovernanceExecutionLink,
} from "@tact/runs-core/tact-execution/governance/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeInvocation(overrides: Partial<GovernanceInvocation> = {}): GovernanceInvocation {
  return {
    id: "invocation-1",
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: "work-1",
    connectionId: null,
    actorKind: "ai_agent",
    actorId: "principal-1",
    agentId: "agent-1",
    onBehalfOfActorKind: null,
    onBehalfOfActorId: null,
    actionCategory: "send",
    operation: "slack.send_message",
    resourceType: null,
    resourceIdentifier: null,
    targetProvider: "slack",
    attemptedAt: "2026-10-04T00:00:00.000Z",
    createdAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

function makeDecision(overrides: Partial<GovernanceDecision> = {}): GovernanceDecision {
  return {
    id: "decision-1",
    userId: "user-1",
    invocationId: "invocation-1",
    evaluatedAt: "2026-10-04T00:00:01.000Z",
    actorKindSnapshot: "ai_agent",
    actorIdSnapshot: "principal-1",
    agentIdSnapshot: "agent-1",
    onBehalfOfActorKindSnapshot: null,
    onBehalfOfActorIdSnapshot: null,
    actionCategorySnapshot: "send",
    operationSnapshot: "slack.send_message",
    resourceTypeSnapshot: null,
    resourceIdentifierSnapshot: null,
    targetProviderSnapshot: "slack",
    verdict: "APPROVAL_REQUIRED",
    reasonCode: "needs_human",
    evaluatorVersion: "permission-evaluator-v1",
    decisionSource: "runs_permission_registry",
    trustLevelSnapshot: "INTERNAL",
    policyIdentifierSnapshot: "rule-1",
    registryRuleIdSnapshot: "rule-1",
    registryRuleRevisionSnapshot: 1,
    runsPermissionSnapshot: { kind: "no_match" },
    policySetFingerprint: "a".repeat(64),
    approvalId: null,
    approvalStatus: null,
    approverKind: null,
    approverId: null,
    approvedAt: null,
    createdAt: "2026-10-04T00:00:01.000Z",
    ...overrides,
  };
}

function makeApprovalRequest(overrides: Partial<GovernanceApprovalRequest> = {}): GovernanceApprovalRequest {
  return {
    id: "apr-1",
    userId: "user-1",
    governanceDecisionId: "decision-1",
    status: "pending",
    requestedAt: "2026-10-04T00:00:02.000Z",
    resolvedAt: null,
    resolvedByActorKind: null,
    resolvedByActorId: null,
    createdAt: "2026-10-04T00:00:02.000Z",
    ...overrides,
  };
}

function makeLink(overrides: Partial<GovernanceExecutionLink> = {}): GovernanceExecutionLink {
  return {
    id: "link-1",
    userId: "user-1",
    invocationId: "invocation-1",
    effectiveGovernanceDecisionId: "decision-1",
    executionId: "exec-1",
    linkedAt: "2026-10-04T00:01:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [17] execution link exists -> executed ----
  {
    const view = toGovernanceApprovalInboxItemView(makeApprovalRequest(), makeDecision(), makeInvocation(), [makeLink()]);

    results.push(check("[17] a matching GovernanceInvocationExecutionLink yields executionObservationState 'executed'", view?.executionObservationState === "executed"));
  }

  // ---- [18] no link -> no_execution_observed ----
  {
    const view = toGovernanceApprovalInboxItemView(makeApprovalRequest(), makeDecision(), makeInvocation(), []);

    results.push(check("[18] no link yields executionObservationState 'no_execution_observed'", view?.executionObservationState === "no_execution_observed"));
  }

  // A link for a DIFFERENT invocation must not count.
  {
    const unrelatedLink = makeLink({ invocationId: "some-other-invocation", executionId: "exec-unrelated" });
    const view = toGovernanceApprovalInboxItemView(makeApprovalRequest(), makeDecision(), makeInvocation(), [unrelatedLink]);

    results.push(check("a link belonging to a different invocation is not mistaken for this invocation's execution", view?.executionObservationState === "no_execution_observed"));
  }

  // ---- [19] approvalActionability is always not_proven ----
  {
    const pendingView = toGovernanceApprovalInboxItemView(makeApprovalRequest({ status: "pending" }), makeDecision(), makeInvocation(), []);
    const approvedView = toGovernanceApprovalInboxItemView(
      makeApprovalRequest({ status: "approved", resolvedAt: "2026-10-04T00:10:00.000Z", resolvedByActorKind: "human", resolvedByActorId: "approver-1" }),
      makeDecision(),
      makeInvocation(),
      [makeLink()]
    );

    results.push(check("[19] approvalActionability is 'not_proven' while pending, no execution observed", pendingView?.approvalActionability === "not_proven"));
    results.push(check("[19] approvalActionability is STILL 'not_proven' even when approved AND an execution link exists", approvedView?.approvalActionability === "not_proven"));
  }

  // ---- field mapping sanity: requested/decision-level fields carry through ----
  {
    const view = toGovernanceApprovalInboxItemView(makeApprovalRequest(), makeDecision(), makeInvocation(), []);

    results.push(check(
      "projection carries approvalId/decisionId/invocationId/workId/reasonCode/policyVersion through unchanged",
      view !== null &&
      view.approvalId === "apr-1" &&
      view.decisionId === "decision-1" &&
      view.invocationId === "invocation-1" &&
      view.workId === "work-1" &&
      view.reasonCode === "needs_human" &&
      view.policyVersion === "a".repeat(64)
    ));
  }

  // ---- incoherent source records fail closed (omitted, never guessed) ----
  {
    const mismatchedDecision = toGovernanceApprovalInboxItemView(
      makeApprovalRequest({ governanceDecisionId: "decision-X" }),
      makeDecision({ id: "decision-1" }),
      makeInvocation(),
      []
    );
    results.push(check("approvalRequest.governanceDecisionId not matching decision.id -> omitted (null), never guessed", mismatchedDecision === null));

    const mismatchedInvocation = toGovernanceApprovalInboxItemView(
      makeApprovalRequest(),
      makeDecision({ invocationId: "invocation-X" }),
      makeInvocation({ id: "invocation-1" }),
      []
    );
    results.push(check("decision.invocationId not matching invocation.id -> omitted (null)", mismatchedInvocation === null));

    const crossTenant = toGovernanceApprovalInboxItemView(
      makeApprovalRequest({ userId: "user-1" }),
      makeDecision({ userId: "user-2" }),
      makeInvocation({ userId: "user-1" }),
      []
    );
    results.push(check("mismatched userId across records -> omitted (null), never trusted across a tenant boundary", crossTenant === null));
  }

  return summarize("SOR-138 Slice 2A — Governance Approval Inbox read projection", results);

}
