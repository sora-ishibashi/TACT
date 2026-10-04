// =========================
// SOR-138 Slice 2A — GovernanceApprovalRequest store CAS regression
// =========================
//
// Exercises the real store.ts implementation (ensureGovernanceApprovalRequestForDecision/
// approve/reject) against a fake Supabase client — same convention as
// tests/tact/execution/permission/attentionStore.test.ts (no real
// Supabase/DB connection). Covers Human Owner test requirements 9, 10, 12,
// 13; the human-only resolver invariant (correction 1); the decision-
// verifying creation boundary (correction 2); and the unavailable-client
// path.
//
// Note: the raw, non-verifying `createGovernanceApprovalRequest` is NOT
// exported from store.ts anymore (Human Owner correction 2) — it cannot be
// imported here even if we wanted to. Every creation test below goes
// through ensureGovernanceApprovalRequestForDecision(), the only path a
// caller (test or production) has.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ensureGovernanceApprovalRequestForDecision,
  approveGovernanceApprovalRequest,
  rejectGovernanceApprovalRequest,
  type GovernanceStoreDeps,
} from "@tact/runs-core/tact-execution/governance/store";
import type { GovernanceApprovalResolver } from "@tact/runs-core/tact-execution/governance/types";
import { check, summarize, type CheckResult } from "../../lib/check";

const HUMAN_APPROVER: GovernanceApprovalResolver = { actorKind: "human", actorId: "approver-1" };

// Sequential fake client: each `.single()`/`.maybeSingle()` call consumes
// the next entry from `singleResults`, in call order — identical shape to
// attentionStore.test.ts's own makeInsertFakeClient().
function makeSequentialFakeClient(singleResults: Array<{ data: unknown; error: unknown }>) {

  let callIndex = 0;

  const builder = {
    from: () => builder,
    insert: () => builder,
    update: () => builder,
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    single: async () => singleResults[callIndex++],
    maybeSingle: async () => singleResults[callIndex++],
  };

  return builder as unknown as SupabaseClient;

}

function approvalRequestRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "apr-1",
    user_id: "user-1",
    governance_decision_id: "decision-1",
    status: "pending",
    requested_at: "2026-10-04T00:00:00.000Z",
    resolved_at: null,
    resolved_by_actor_kind: null,
    resolved_by_actor_id: null,
    created_at: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

function decisionRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    user_id: "user-1",
    verdict: "APPROVAL_REQUIRED",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [direct misuse A] APPROVAL_REQUIRED decision -> succeeds ----
  {
    const row = approvalRequestRowFixture();
    // ensureGovernanceApprovalRequestForDecision() calls deps.getClient()
    // itself (for the decision read) AND delegates to the private
    // createGovernanceApprovalRequest() (for the insert), which calls
    // deps.getClient() AGAIN — exactly like the real cached
    // getServiceRoleClient() returns the SAME client both times. The fake
    // must build the client ONCE and hand back that same instance, or its
    // own callIndex counter would wrongly reset between the two calls.
    const client = makeSequentialFakeClient([
      { data: decisionRowFixture(), error: null }, // decision read: verdict=APPROVAL_REQUIRED
      { data: row, error: null }, // insert succeeds
    ]);
    const deps: GovernanceStoreDeps = { getClient: () => client };

    const outcome = await ensureGovernanceApprovalRequestForDecision("decision-1", "user-1", deps);

    results.push(check("[direct] APPROVAL_REQUIRED decision creates a request", outcome.status === "created"));
    results.push(check(
      "[direct] mapped row round-trips to camelCase domain shape",
      outcome.status === "created" && outcome.approvalRequest.id === "apr-1" && outcome.approvalRequest.status === "pending" && outcome.approvalRequest.governanceDecisionId === "decision-1"
    ));
  }

  // ---- [direct misuse B] ALLOW decision -> rejected, no row ----
  {
    const deps: GovernanceStoreDeps = {
      getClient: () => makeSequentialFakeClient([
        { data: decisionRowFixture({ verdict: "ALLOW" }), error: null },
      ]),
    };

    const outcome = await ensureGovernanceApprovalRequestForDecision("decision-1", "user-1", deps);

    results.push(check("[direct] ALLOW decision: verdict_not_approval_required, never creates a row", outcome.status === "verdict_not_approval_required"));
  }

  // ---- [direct misuse C] DENY decision -> rejected, no row ----
  {
    const deps: GovernanceStoreDeps = {
      getClient: () => makeSequentialFakeClient([
        { data: decisionRowFixture({ verdict: "DENY" }), error: null },
      ]),
    };

    const outcome = await ensureGovernanceApprovalRequestForDecision("decision-1", "user-1", deps);

    results.push(check("[direct] DENY decision: verdict_not_approval_required, never creates a row", outcome.status === "verdict_not_approval_required"));
  }

  // ---- [direct misuse D] UNKNOWN decision -> rejected, no row ----
  {
    const deps: GovernanceStoreDeps = {
      getClient: () => makeSequentialFakeClient([
        { data: decisionRowFixture({ verdict: "UNKNOWN" }), error: null },
      ]),
    };

    const outcome = await ensureGovernanceApprovalRequestForDecision("decision-1", "user-1", deps);

    results.push(check("[direct] UNKNOWN decision: verdict_not_approval_required, never creates a row", outcome.status === "verdict_not_approval_required"));
  }

  // ---- [direct misuse E] missing decision -> rejected, no row ----
  {
    const deps: GovernanceStoreDeps = {
      getClient: () => makeSequentialFakeClient([
        { data: null, error: null }, // decision read: no row at all
      ]),
    };

    const outcome = await ensureGovernanceApprovalRequestForDecision("decision-does-not-exist", "user-1", deps);

    results.push(check("[direct] missing decision: decision_not_found, never creates a row", outcome.status === "decision_not_found"));
  }

  // ---- [direct misuse F] another tenant's decision -> rejected, non-disclosing ----
  {
    // The query itself is `.eq("id", governanceDecisionId).eq("user_id", trustedUserId)`
    // — a foreign tenant's decision id simply never matches a row under a
    // DIFFERENT trustedUserId, so this is indistinguishable from "missing"
    // at the fake-client level too (same as the real query would be).
    const deps: GovernanceStoreDeps = {
      getClient: () => makeSequentialFakeClient([
        { data: null, error: null }, // decision read scoped to "user-b": tenant A's row never matches
      ]),
    };

    const outcome = await ensureGovernanceApprovalRequestForDecision("decision-owned-by-user-a", "user-b", deps);

    results.push(check("[direct] foreign-tenant decision: decision_not_found (same outcome as missing — non-disclosing)", outcome.status === "decision_not_found"));
  }

  // ---- create: duplicate (23505) reads back the existing row by governance_decision_id + user_id ----
  {
    const existingRow = approvalRequestRowFixture({ status: "pending" });
    // Same single-client-instance requirement as [direct misuse A] above —
    // this path also crosses the ensureGovernanceApprovalRequestForDecision
    // -> createGovernanceApprovalRequest boundary (two getClient() calls).
    const client = makeSequentialFakeClient([
      { data: decisionRowFixture(), error: null }, // decision read: verdict=APPROVAL_REQUIRED
      { data: null, error: { code: "23505", message: "duplicate key" } }, // insert loses the race
      { data: existingRow, error: null }, // re-read by governance_decision_id + user_id
    ]);
    const deps: GovernanceStoreDeps = { getClient: () => client };

    const outcome = await ensureGovernanceApprovalRequestForDecision("decision-1", "user-1", deps);

    results.push(check("create/duplicate: status already_exists, no idempotency_conflict concept for this table", outcome.status === "already_exists"));
    results.push(check("create/duplicate: returns the existing row, not a new one", outcome.status === "already_exists" && outcome.approvalRequest.id === "apr-1"));
  }

  // ---- [9] approve: pending -> approved (human resolver) ----
  {
    const approvedRow = approvalRequestRowFixture({ status: "approved", resolved_at: "2026-10-04T00:05:00.000Z", resolved_by_actor_kind: "human", resolved_by_actor_id: "approver-1" });
    const deps: GovernanceStoreDeps = { getClient: () => makeSequentialFakeClient([{ data: approvedRow, error: null }]) };

    const outcome = await approveGovernanceApprovalRequest("apr-1", "user-1", HUMAN_APPROVER, deps);

    results.push(check("[9] approve: status resolved", outcome.status === "resolved"));
    results.push(check("[9] approve: resulting status is approved with resolver identity recorded", outcome.status === "resolved" && outcome.approvalRequest.status === "approved" && outcome.approvalRequest.resolvedByActorId === "approver-1"));
  }

  // ---- [10] reject: pending -> rejected (human resolver) ----
  {
    const rejectedRow = approvalRequestRowFixture({ status: "rejected", resolved_at: "2026-10-04T00:05:00.000Z", resolved_by_actor_kind: "human", resolved_by_actor_id: "rejecter-1" });
    const deps: GovernanceStoreDeps = { getClient: () => makeSequentialFakeClient([{ data: rejectedRow, error: null }]) };

    const outcome = await rejectGovernanceApprovalRequest("apr-1", "user-1", { actorKind: "human", actorId: "rejecter-1" }, deps);

    results.push(check("[10] reject: status resolved", outcome.status === "resolved"));
    results.push(check("[10] reject: resulting status is rejected", outcome.status === "resolved" && outcome.approvalRequest.status === "rejected"));
  }

  // ---- [11] (store half) race-loser view ----
  {
    const alreadyApprovedRow = approvalRequestRowFixture({ status: "approved", resolved_at: "2026-10-04T00:05:00.000Z", resolved_by_actor_kind: "human", resolved_by_actor_id: "winner" });
    const deps: GovernanceStoreDeps = {
      getClient: () => makeSequentialFakeClient([
        { data: null, error: null },
        { data: alreadyApprovedRow, error: null },
      ]),
    };

    const outcome = await rejectGovernanceApprovalRequest("apr-1", "user-1", { actorKind: "human", actorId: "loser" }, deps);

    results.push(check("[11] loser's reject observes already_resolved, never an error", outcome.status === "already_resolved"));
    results.push(check(
      "[11] loser observes the WINNER's actual terminal status (approved) — never flips to rejected",
      outcome.status === "already_resolved" && outcome.approvalRequest.status === "approved" && outcome.approvalRequest.resolvedByActorId === "winner"
    ));
  }

  // ---- [12] repeated same terminal action: deterministic idempotent already_resolved ----
  {
    const alreadyApprovedRow = approvalRequestRowFixture({ status: "approved", resolved_at: "2026-10-04T00:05:00.000Z", resolved_by_actor_kind: "human", resolved_by_actor_id: "approver-1" });
    const deps: GovernanceStoreDeps = {
      getClient: () => makeSequentialFakeClient([
        { data: null, error: null },
        { data: alreadyApprovedRow, error: null },
      ]),
    };

    const outcome = await approveGovernanceApprovalRequest("apr-1", "user-1", HUMAN_APPROVER, deps);

    results.push(check("[12] repeated approve: already_resolved, not an error, not a second approved record", outcome.status === "already_resolved"));
    results.push(check("[12] repeated approve: same terminal status as before (approved)", outcome.status === "already_resolved" && outcome.approvalRequest.status === "approved"));
  }

  // ---- [13] cross-tenant: tenant B cannot resolve/read tenant A's request ----
  {
    const deps: GovernanceStoreDeps = {
      getClient: () => makeSequentialFakeClient([
        { data: null, error: null },
        { data: null, error: null },
      ]),
    };

    const outcome = await approveGovernanceApprovalRequest("apr-1", "user-b", { actorKind: "human", actorId: "intruder" }, deps);

    results.push(check("[13] cross-tenant approve attempt: not_found, never leaks or adopts tenant A's row", outcome.status === "not_found"));
  }

  // ---- [human resolver A] human succeeds (already proven by [9]/[10] above; this
  //      block covers the negative cases) ----

  // ---- [human resolver B] ai_agent is rejected before any write ----
  {
    const deps: GovernanceStoreDeps = { getClient: () => { throw new Error("must not be called when resolver is not human"); } };
    const outcome = await approveGovernanceApprovalRequest("apr-1", "user-1", { actorKind: "ai_agent", actorId: "agent-1" } as unknown as GovernanceApprovalResolver, deps);
    results.push(check("[human-resolver] ai_agent is rejected as invalid, never reaches the client", outcome.status === "invalid"));
  }

  // ---- [human resolver C] service is rejected before any write ----
  {
    const deps: GovernanceStoreDeps = { getClient: () => { throw new Error("must not be called when resolver is not human"); } };
    const outcome = await rejectGovernanceApprovalRequest("apr-1", "user-1", { actorKind: "service", actorId: "svc-1" } as unknown as GovernanceApprovalResolver, deps);
    results.push(check("[human-resolver] service is rejected as invalid, never reaches the client", outcome.status === "invalid"));
  }

  // ---- [human resolver D] connector is rejected before any write ----
  {
    const deps: GovernanceStoreDeps = { getClient: () => { throw new Error("must not be called when resolver is not human"); } };
    const outcome = await approveGovernanceApprovalRequest("apr-1", "user-1", { actorKind: "connector", actorId: "conn-1" } as unknown as GovernanceApprovalResolver, deps);
    results.push(check("[human-resolver] connector is rejected as invalid, never reaches the client", outcome.status === "invalid"));
  }

  // ---- [human resolver E] system is rejected before any write ----
  {
    const deps: GovernanceStoreDeps = { getClient: () => { throw new Error("must not be called when resolver is not human"); } };
    const outcome = await rejectGovernanceApprovalRequest("apr-1", "user-1", { actorKind: "system", actorId: "sys-1" } as unknown as GovernanceApprovalResolver, deps);
    results.push(check("[human-resolver] system is rejected as invalid, never reaches the client", outcome.status === "invalid"));
  }

  // ---- [human resolver F] blank (empty) resolver id is rejected before any write ----
  {
    const deps: GovernanceStoreDeps = { getClient: () => { throw new Error("must not be called when resolver id is blank"); } };
    const outcome = await approveGovernanceApprovalRequest("apr-1", "user-1", { actorKind: "human", actorId: "" }, deps);
    results.push(check("[human-resolver] empty actorId is rejected as invalid, never reaches the client", outcome.status === "invalid"));
  }

  // ---- [human resolver G] whitespace-only resolver id is rejected before any write ----
  {
    const deps: GovernanceStoreDeps = { getClient: () => { throw new Error("must not be called when resolver id is whitespace-only"); } };
    const outcome = await rejectGovernanceApprovalRequest("apr-1", "user-1", { actorKind: "human", actorId: "   " }, deps);
    results.push(check("[human-resolver] whitespace-only actorId is rejected as invalid, never reaches the client", outcome.status === "invalid"));
  }

  // ---- getClient() returns null -> unavailable, for every function ----
  {
    const deps: GovernanceStoreDeps = { getClient: () => null };

    const createOutcome = await ensureGovernanceApprovalRequestForDecision("decision-1", "user-1", deps);
    results.push(check("ensureGovernanceApprovalRequestForDecision: unavailable when getClient() returns null", createOutcome.status === "unavailable"));

    const approveOutcome = await approveGovernanceApprovalRequest("apr-1", "user-1", HUMAN_APPROVER, deps);
    results.push(check("approve: unavailable when getClient() returns null", approveOutcome.status === "unavailable"));
  }

  return summarize("SOR-138 Slice 2A — GovernanceApprovalRequest store CAS regression", results);

}
