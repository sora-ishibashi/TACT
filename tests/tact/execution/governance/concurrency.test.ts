// =========================
// SOR-138 Slice 1 — First-decision concurrency (Human Owner security re-review, Blocker B)
// =========================
//
// Problem this proves closed: the real schema has no UNIQUE(invocation_id,
// user_id) on tact_governance_decisions. Without a migration, two callers
// that both see "no decision exists yet" for the same invocation and then
// both evaluate+append could, in principle, each persist their own
// decision row — violating "one first effective decision per invocation".
//
// Fix under test (packages/runs-core/tact-execution/governance/
// contract.ts's preflight()): the FIRST decision attempt always uses a
// deterministic id derived from (userId, invocationId), not a random one.
// This turns the already-existing PRIMARY KEY on tact_governance_decisions
// into the sole concurrency-safety mechanism — no migration, no advisory
// lock, no mutex. This file proves that mechanism against a genuinely
// interleaved race, not merely a sequential retry (sequential retries are
// already covered by contract.test.ts's own idempotency/policy-change
// tests).
//
// Honesty about what this test can and cannot prove (Slice 1 explicitly
// has no real DB access): this exercises a real interleaved JS Promise
// race against the SAME in-memory store instance via
// governanceContractFakes.ts's `artificialRaceYield` option, which forces
// two calls to both pass their "does a row already exist?" read before
// either call's "write" — the same TOCTOU window two real concurrent
// Postgres connections would hit. The actual cross-connection atomicity
// guarantee comes from Postgres' own PRIMARY KEY uniqueness (already
// relied upon everywhere else in this repository's governance/store.ts
// and permission/registryStore.ts); this test proves the APPLICATION
// logic built on top of that primitive reacts correctly when the
// constraint is hit, including on the losing side.

import { preflight, type PreflightDeps } from "@tact/runs-core/tact-execution/governance/contract";
import type { PreflightRequest } from "@tact/execution-contract";
import { makeFakeGovernanceStore, makeFakeRule } from "./governanceContractFakes";
import { check, summarize, type CheckResult } from "../../lib/check";

const TRUSTED_USER_ID = "user-race";

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

  // ---- Genuine race, identical content: both racers would compute the SAME verdict ----
  {
    const store = makeFakeGovernanceStore({ artificialRaceYield: true });
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed", reasonCode: "race_allow" });
    const deps: PreflightDeps = {
      createGovernanceInvocation: store.createGovernanceInvocation,
      listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
      appendGovernanceDecision: store.appendGovernanceDecision,
      listActivePermissionRulesForMatching: async () => [rule],
      now: () => new Date("2026-10-04T00:00:01.000Z"),
    };

    const invocationId = "11111111-1111-4111-8111-111111111111";
    const request = makeRequest(invocationId);

    // Promise.all starts both calls before either resolves — with
    // artificialRaceYield both calls pass their own invocation-claim AND
    // decision-existence checks before either call's write lands, exactly
    // reproducing the race window described above.
    const [outcomeA, outcomeB] = await Promise.all([
      preflight(request, TRUSTED_USER_ID, deps),
      preflight(request, TRUSTED_USER_ID, deps),
    ]);

    results.push(check(
      "[race/identical-content] both racing calls resolve to status=decided, never a raw conflict for a benign race",
      outcomeA.status === "decided" && outcomeB.status === "decided"
    ));

    results.push(check(
      "[race/identical-content] exactly one GovernanceInvocation row persisted despite the race",
      store.invocations.size === 1
    ));

    results.push(check(
      "[race/identical-content] exactly one GovernanceDecision row persisted despite the race — the core invariant this test exists for",
      store.decisions.size === 1
    ));

    results.push(check(
      "[race/identical-content] both callers observe the SAME decisionId and verdict (one winner, one reader of the winner)",
      outcomeA.status === "decided" && outcomeB.status === "decided" &&
      outcomeA.response.decisionId === outcomeB.response.decisionId &&
      outcomeA.response.verdict === "ALLOW" && outcomeB.response.verdict === "ALLOW"
    ));
  }

  // ---- Genuine race, a mid-race registry edit makes the two evaluations compute DIFFERENT content ----
  {
    const store = makeFakeGovernanceStore({ artificialRaceYield: true });
    const allowRule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed", reasonCode: "race_allow_variant" });
    const denyRule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "denied", reasonCode: "race_deny_variant" });

    // Alternates which rule set each call to listActivePermissionRulesForMatching
    // sees, so the two racing evaluations genuinely disagree on content —
    // the rare sub-case the header comment calls out explicitly.
    let callCount = 0;
    const deps: PreflightDeps = {
      createGovernanceInvocation: store.createGovernanceInvocation,
      listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
      appendGovernanceDecision: store.appendGovernanceDecision,
      listActivePermissionRulesForMatching: async () => {
        callCount += 1;
        return callCount === 1 ? [allowRule] : [denyRule];
      },
      now: () => new Date("2026-10-04T00:00:01.000Z"),
    };

    const invocationId = "22222222-2222-4222-8222-222222222222";
    const request = makeRequest(invocationId);

    const [outcomeA, outcomeB] = await Promise.all([
      preflight(request, TRUSTED_USER_ID, deps),
      preflight(request, TRUSTED_USER_ID, deps),
    ]);

    results.push(check(
      "[race/content-diverged] still exactly one GovernanceDecision row — the invariant holds even when the two evaluations genuinely disagreed",
      store.decisions.size === 1
    ));

    results.push(check(
      "[race/content-diverged] the losing call gracefully adopts the winner's actual persisted decision instead of erroring or fabricating a second row",
      outcomeA.status === "decided" && outcomeB.status === "decided" &&
      outcomeA.response.decisionId === outcomeB.response.decisionId &&
      outcomeA.response.verdict === outcomeB.response.verdict &&
      (outcomeA.response.verdict === "ALLOW" || outcomeA.response.verdict === "DENY")
    ));
  }

  // ---- Cross-tenant race on the SAME invocationId: must never collide with each other ----
  {
    const store = makeFakeGovernanceStore({ artificialRaceYield: true });
    const ruleForA = makeFakeRule({ userId: "user-race-a", targetProvider: "slack", actionCategory: "send", decision: "allowed", reasonCode: "a_allow" });
    const ruleForB = makeFakeRule({ userId: "user-race-b", targetProvider: "slack", actionCategory: "send", decision: "denied", reasonCode: "b_deny" });
    const allRules = [ruleForA, ruleForB];

    const deps: PreflightDeps = {
      createGovernanceInvocation: store.createGovernanceInvocation,
      listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
      appendGovernanceDecision: store.appendGovernanceDecision,
      listActivePermissionRulesForMatching: async (userId) => allRules.filter((r) => r.userId === userId || r.userId === null),
      now: () => new Date("2026-10-04T00:00:01.000Z"),
    };

    const sharedInvocationId = "33333333-3333-4333-8333-333333333333";
    const request = makeRequest(sharedInvocationId);

    const [outcomeA, outcomeB] = await Promise.all([
      preflight(request, "user-race-a", deps),
      preflight(request, "user-race-b", deps),
    ]);

    results.push(check(
      "[race/cross-tenant] two different tenants racing on the identical invocationId each get their OWN decision, never each other's",
      outcomeA.status === "decided" && outcomeB.status === "decided" &&
      outcomeA.response.verdict === "ALLOW" && outcomeB.response.verdict === "DENY" &&
      outcomeA.response.decisionId !== outcomeB.response.decisionId
    ));

    results.push(check(
      "[race/cross-tenant] two separate GovernanceDecision rows exist — one per tenant, the deterministic claim is tenant-scoped",
      store.decisions.size === 2
    ));
  }

  return summarize("SOR-138 Slice 1 — Preflight first-decision concurrency safety", results);

}
