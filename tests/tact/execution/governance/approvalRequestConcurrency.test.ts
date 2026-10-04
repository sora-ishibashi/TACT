// =========================
// SOR-138 Slice 2A — GovernanceApprovalRequest concurrency
// =========================
//
// Genuine interleaved JS Promise races via governanceContractFakes.ts's
// `artificialRaceYield` option — same honesty note as
// execution/governance/concurrency.test.ts: this proves the APPLICATION
// logic reacts correctly when two callers truly interleave past a
// check-then-write boundary; the cross-connection atomicity guarantee at
// the real Postgres layer comes from the UNIQUE(governance_decision_id)
// constraint (creation) and the single conditional UPDATE's WHERE clause
// (resolution), both already relied upon elsewhere in this repository.
//
// Covers Human Owner test requirements 6 and 11.

import { preflight, type PreflightDeps } from "@tact/runs-core/tact-execution/governance/contract";
import type { PreflightRequest } from "@tact/execution-contract";
import { makeFakeGovernanceStore, makeFakeRule } from "./governanceContractFakes";
import { check, summarize, type CheckResult } from "../../lib/check";

const TRUSTED_USER_ID = "user-approval-race";

function makeRequest(invocationId: string): PreflightRequest {
  return {
    invocationId,
    actorKind: "ai_agent",
    agentId: "agent-1",
    actionCategory: "send",
    operation: "slack.send_message",
    targetProvider: "slack",
    attemptedAt: "2026-10-04T00:00:00.000Z",
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [6] concurrent identical Preflight: one GovernanceDecision, one
  //      ApprovalRequest, both callers observe the same approvalId ----
  {
    const store = makeFakeGovernanceStore({ artificialRaceYield: true });
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "approval_required", reasonCode: "race_needs_human" });
    const deps: PreflightDeps = {
      createGovernanceInvocation: store.createGovernanceInvocation,
      listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
      appendGovernanceDecision: store.appendGovernanceDecision,
      ensureGovernanceApprovalRequestForDecision: store.ensureGovernanceApprovalRequestForDecision,
      listActivePermissionRulesForMatching: async () => [rule],
      now: () => new Date("2026-10-04T00:00:01.000Z"),
    };

    const invocationId = "99999999-9999-4999-8999-aaaaaaaaaaaa";
    const request = makeRequest(invocationId);

    const [outcomeA, outcomeB] = await Promise.all([
      preflight(request, TRUSTED_USER_ID, deps),
      preflight(request, TRUSTED_USER_ID, deps),
    ]);

    results.push(check(
      "[6] both racing calls resolve to status=decided",
      outcomeA.status === "decided" && outcomeB.status === "decided"
    ));

    results.push(check("[6] exactly one GovernanceDecision row persisted", store.decisions.size === 1));
    results.push(check("[6] exactly one GovernanceApprovalRequest row persisted despite the race", store.approvalRequestsById.size === 1));

    results.push(check(
      "[6] both callers observe the SAME approvalId (one winner, one reader of the winner)",
      outcomeA.status === "decided" && outcomeB.status === "decided" &&
      outcomeA.response.approval.approvalId !== null &&
      outcomeA.response.approval.approvalId === outcomeB.response.approval.approvalId
    ));
  }

  // ---- [11] concurrent approve/reject race: exactly one terminal winner,
  //      the loser observes the winner's state, never a flip ----
  {
    const store = makeFakeGovernanceStore({ artificialRaceYield: true });

    // ensureGovernanceApprovalRequestForDecision() now requires a persisted,
    // tenant-matched, APPROVAL_REQUIRED decision to already exist (Human
    // Owner correction 2) — seed one directly into the fake's own
    // `decisions` map rather than going through a full preflight() call,
    // since this test is about the approve/reject race, not creation.
    store.decisions.set("decision-race-1", {
      id: "decision-race-1",
      userId: "user-race-resolve",
      invocationId: "invocation-race-1",
      evaluatedAt: "2026-10-04T00:00:01.000Z",
      actorKindSnapshot: "ai_agent",
      actorIdSnapshot: null,
      agentIdSnapshot: null,
      onBehalfOfActorKindSnapshot: null,
      onBehalfOfActorIdSnapshot: null,
      actionCategorySnapshot: "send",
      operationSnapshot: "slack.send_message",
      resourceTypeSnapshot: null,
      resourceIdentifierSnapshot: null,
      targetProviderSnapshot: "slack",
      verdict: "APPROVAL_REQUIRED",
      reasonCode: "race_resolve_setup",
      evaluatorVersion: "test-fixture",
      decisionSource: "runs_permission_registry",
      trustLevelSnapshot: "INTERNAL",
      policyIdentifierSnapshot: null,
      registryRuleIdSnapshot: null,
      registryRuleRevisionSnapshot: null,
      runsPermissionSnapshot: { kind: "no_match" },
      policySetFingerprint: "a".repeat(64),
      approvalId: null,
      approvalStatus: null,
      approverKind: null,
      approverId: null,
      approvedAt: null,
      createdAt: "2026-10-04T00:00:01.000Z",
    });

    const created = await store.ensureGovernanceApprovalRequestForDecision("decision-race-1", "user-race-resolve");

    if (created.status !== "created") {
      results.push(check("[11] setup: approval request was created", false));
    } else {

      const approvalRequestId = created.approvalRequest.id;

      const [approveOutcome, rejectOutcome] = await Promise.all([
        store.approveGovernanceApprovalRequest(approvalRequestId, "user-race-resolve", { actorKind: "human", actorId: "approver-race" }),
        store.rejectGovernanceApprovalRequest(approvalRequestId, "user-race-resolve", { actorKind: "human", actorId: "rejecter-race" }),
      ]);

      const resolvedCount = [approveOutcome, rejectOutcome].filter((o) => o.status === "resolved").length;
      const alreadyResolvedCount = [approveOutcome, rejectOutcome].filter((o) => o.status === "already_resolved").length;

      results.push(check("[11] exactly one side actually transitioned the row (resolved)", resolvedCount === 1));
      results.push(check("[11] the other side observed already_resolved, never erroring or silently succeeding twice", alreadyResolvedCount === 1));

      const winnerStatus = approveOutcome.status === "resolved" ? "approved" : rejectOutcome.status === "resolved" ? "rejected" : null;
      const loserOutcome = approveOutcome.status === "already_resolved" ? approveOutcome : rejectOutcome.status === "already_resolved" ? rejectOutcome : null;

      results.push(check(
        "[11] the loser's reported approvalRequest.status equals the winner's actual terminal status — no flip-flop",
        winnerStatus !== null && loserOutcome !== null && loserOutcome.approvalRequest.status === winnerStatus
      ));

      results.push(check("[11] exactly one GovernanceApprovalRequest row exists, in a single terminal state", store.approvalRequestsById.size === 1));
    }
  }

  return summarize("SOR-138 Slice 2A — GovernanceApprovalRequest concurrency", results);

}
