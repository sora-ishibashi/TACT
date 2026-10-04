// =========================
// SOR-138 Slice 2A — Preflight / GovernanceApprovalRequest wiring
// =========================
//
// Zero real Supabase/DB access (governanceContractFakes.ts, same convention
// as contract.test.ts/concurrency.test.ts). Covers the Human Owner's
// numbered test requirements 1-5, 7, 8, 15, 16 (6 and 11 are in
// approvalRequestConcurrency.test.ts; 9, 10, 12, 13 are in
// approvalRequestStore.test.ts; 14 is in approvalRequestImmutability.test.ts;
// 17-19 are in tests/tact/runsView/governanceApprovalInbox.test.ts).

import { preflight, type PreflightDeps } from "@tact/runs-core/tact-execution/governance/contract";
import type { PreflightRequest } from "@tact/execution-contract";
import { makeFakeGovernanceStore, makeFakeRule } from "./governanceContractFakes";
import { check, summarize, type CheckResult } from "../../lib/check";

const TRUSTED_USER_ID = "user-approval-contract";

function makeRequest(invocationId: string, overrides: Partial<PreflightRequest> = {}): PreflightRequest {
  return {
    invocationId,
    actorKind: "ai_agent",
    agentId: "agent-1",
    actionCategory: "send",
    operation: "slack.send_message",
    targetProvider: "slack",
    attemptedAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(store: ReturnType<typeof makeFakeGovernanceStore>, rules: Parameters<typeof makeFakeRule>[0][] | ReturnType<typeof makeFakeRule>[]): PreflightDeps {
  const resolvedRules = rules as ReturnType<typeof makeFakeRule>[];
  return {
    createGovernanceInvocation: store.createGovernanceInvocation,
    listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
    appendGovernanceDecision: store.appendGovernanceDecision,
    ensureGovernanceApprovalRequestForDecision: store.ensureGovernanceApprovalRequestForDecision,
    listActivePermissionRulesForMatching: async () => resolvedRules,
    now: () => new Date("2026-10-04T00:00:01.000Z"),
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [1] APPROVAL_REQUIRED creates exactly one ApprovalRequest ----
  {
    const store = makeFakeGovernanceStore();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "approval_required", reasonCode: "needs_human" });
    const deps = makeDeps(store, [rule]);
    const invocationId = "11111111-1111-4111-8111-aaaaaaaaaaaa";

    const outcome = await preflight(makeRequest(invocationId), TRUSTED_USER_ID, deps);

    results.push(check("[1] verdict is APPROVAL_REQUIRED", outcome.status === "decided" && outcome.response.verdict === "APPROVAL_REQUIRED"));
    results.push(check("[1] exactly one GovernanceApprovalRequest was persisted", store.approvalRequestsById.size === 1));
    results.push(check(
      "[1] PreflightResponse.approval carries that request's stable id, status null while pending",
      outcome.status === "decided" && outcome.response.approval.approvalId !== null && outcome.response.approval.status === null
    ));
  }

  // ---- [2]/[3]/[4] ALLOW / DENY / UNKNOWN create NO approval request ----
  {
    const cases: Array<{ decision: "allowed" | "denied"; verdict: string; label: string }> = [
      { decision: "allowed", verdict: "ALLOW", label: "[2] ALLOW" },
      { decision: "denied", verdict: "DENY", label: "[3] DENY" },
    ];

    for (const testCase of cases) {
      const store = makeFakeGovernanceStore();
      const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: testCase.decision, reasonCode: "deterministic" });
      const deps = makeDeps(store, [rule]);
      const invocationId = `22222222-${testCase.decision === "allowed" ? "1111" : "2222"}-4222-8222-bbbbbbbbbbbb`;

      const outcome = await preflight(makeRequest(invocationId), TRUSTED_USER_ID, deps);

      results.push(check(`${testCase.label} verdict is ${testCase.verdict}`, outcome.status === "decided" && outcome.response.verdict === testCase.verdict));
      results.push(check(`${testCase.label} creates no GovernanceApprovalRequest`, store.approvalRequestsById.size === 0));
      results.push(check(`${testCase.label} approval is {approvalId:null,status:null}`, outcome.status === "decided" && outcome.response.approval.approvalId === null && outcome.response.approval.status === null));
    }

    // [4] UNKNOWN: no rule matches at all.
    const store = makeFakeGovernanceStore();
    const deps = makeDeps(store, []);
    const invocationId = "22222222-3333-4222-8222-bbbbbbbbbbbb";
    const outcome = await preflight(makeRequest(invocationId), TRUSTED_USER_ID, deps);

    results.push(check("[4] UNKNOWN verdict with no matching rule", outcome.status === "decided" && outcome.response.verdict === "UNKNOWN"));
    results.push(check("[4] UNKNOWN creates no GovernanceApprovalRequest", store.approvalRequestsById.size === 0));
  }

  // ---- [5] identical Preflight retry: same decision, same approvalId, one row ----
  {
    const store = makeFakeGovernanceStore();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "approval_required", reasonCode: "needs_human" });
    const deps = makeDeps(store, [rule]);
    const invocationId = "33333333-3333-4333-8333-cccccccccccc";
    const request = makeRequest(invocationId);

    const first = await preflight(request, TRUSTED_USER_ID, deps);
    const second = await preflight(request, TRUSTED_USER_ID, deps);

    results.push(check(
      "[5] both calls decided with the same decisionId and the same approvalId",
      first.status === "decided" && second.status === "decided" &&
      first.response.decisionId === second.response.decisionId &&
      first.response.approval.approvalId === second.response.approval.approvalId &&
      first.response.approval.approvalId !== null
    ));
    results.push(check("[5] still exactly one GovernanceApprovalRequest row", store.approvalRequestsById.size === 1));
  }

  // ---- [7] crash recovery: decision exists, approval request missing ----
  {
    const store = makeFakeGovernanceStore();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "approval_required", reasonCode: "needs_human" });
    const deps = makeDeps(store, [rule]);
    const invocationId = "44444444-4444-4444-8444-dddddddddddd";
    const request = makeRequest(invocationId);

    // First call persists invocation + decision, but simulate the prior
    // process dying before it ensured the approval request existed: call
    // preflight() once, then forcibly delete the approval request this
    // call just created, leaving the decision behind — exactly the state a
    // crash between appendGovernanceDecision() and
    // createGovernanceApprovalRequest() would leave.
    const first = await preflight(request, TRUSTED_USER_ID, deps);

    if (first.status === "decided" && first.response.approval.approvalId) {
      store.approvalRequestsById.delete(first.response.approval.approvalId);
      store.approvalRequestsByDecisionId.delete(first.response.decisionId);
    }

    results.push(check("[7] decision exists, approval request was removed to simulate the crash", store.decisions.size === 1 && store.approvalRequestsById.size === 0));

    const retry = await preflight(request, TRUSTED_USER_ID, deps);

    results.push(check("[7] retry recovers: decided, same decisionId", retry.status === "decided" && first.status === "decided" && retry.response.decisionId === first.response.decisionId));
    results.push(check("[7] retry created exactly one (new) GovernanceApprovalRequest", store.approvalRequestsById.size === 1));
    results.push(check("[7] still exactly one GovernanceDecision row — recovery never re-evaluates", store.decisions.size === 1));
  }

  // ---- [8] approval-request persistence unavailable -> fails closed ----
  {
    const store = makeFakeGovernanceStore();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "approval_required", reasonCode: "needs_human" });
    const deps: PreflightDeps = {
      ...makeDeps(store, [rule]),
      ensureGovernanceApprovalRequestForDecision: async () => ({ status: "error", message: "simulated approval-request store outage" }),
    };
    const invocationId = "55555555-5555-4555-8555-eeeeeeeeeeee";

    const outcome = await preflight(makeRequest(invocationId), TRUSTED_USER_ID, deps);

    results.push(check("[8] preflight fails closed as unavailable, not a fake decided response", outcome.status === "unavailable"));
    results.push(check("[8] the GovernanceDecision itself was still persisted honestly (append-only ledger unaffected)", store.decisions.size === 1));
    results.push(check("[8] no GovernanceApprovalRequest row exists — no fabricated handle", store.approvalRequestsById.size === 0));
  }

  // ---- [15]/[16] verdict stays APPROVAL_REQUIRED after resolution, status reflects it ----
  {
    const store = makeFakeGovernanceStore();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "approval_required", reasonCode: "needs_human" });
    const deps = makeDeps(store, [rule]);
    const invocationId = "66666666-6666-4666-8666-ffffffffffff";
    const request = makeRequest(invocationId);

    const decided = await preflight(request, TRUSTED_USER_ID, deps);

    if (decided.status === "decided" && decided.response.approval.approvalId) {

      const approveResult = await store.approveGovernanceApprovalRequest(decided.response.approval.approvalId, TRUSTED_USER_ID, { actorKind: "human", actorId: "approver-1" });
      results.push(check("[15] approve resolved the request", approveResult.status === "resolved"));

      const afterApproval = await preflight(request, TRUSTED_USER_ID, deps);
      results.push(check(
        "[15] Preflight after approval: verdict stays APPROVAL_REQUIRED, approval.status is approved",
        afterApproval.status === "decided" && afterApproval.response.verdict === "APPROVAL_REQUIRED" && afterApproval.response.approval.status === "approved"
      ));

    } else {
      results.push(check("[15]/[16] setup failed to decide/produce an approval handle", false));
    }

    const store2 = makeFakeGovernanceStore();
    const deps2 = makeDeps(store2, [rule]);
    const invocationId2 = "77777777-7777-4777-8777-111111111111";
    const request2 = makeRequest(invocationId2);

    const decided2 = await preflight(request2, TRUSTED_USER_ID, deps2);

    if (decided2.status === "decided" && decided2.response.approval.approvalId) {

      const rejectResult = await store2.rejectGovernanceApprovalRequest(decided2.response.approval.approvalId, TRUSTED_USER_ID, { actorKind: "human", actorId: "approver-2" });
      results.push(check("[16] reject resolved the request", rejectResult.status === "resolved"));

      const afterRejection = await preflight(request2, TRUSTED_USER_ID, deps2);
      results.push(check(
        "[16] Preflight after rejection: verdict stays APPROVAL_REQUIRED, approval.status is rejected",
        afterRejection.status === "decided" && afterRejection.response.verdict === "APPROVAL_REQUIRED" && afterRejection.response.approval.status === "rejected"
      ));

    } else {
      results.push(check("[16] setup failed to decide/produce an approval handle", false));
    }
  }

  return summarize("SOR-138 Slice 2A — Preflight / GovernanceApprovalRequest wiring", results);

}
