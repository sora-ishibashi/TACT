// =========================
// SOR-138 Slice 1 — Preflight / Complete Contract Regression
// =========================
//
// 対象: packages/runs-core/tact-execution/governance/contract.tsの
// preflight()/complete()(DIされた既存Governance primitiveのthin
// orchestrationのみ、評価器/store自体は再実装しない)。実Supabase接続
// は一切行わない——governanceContractFakes.tsのin-memory fakeをdeps
// 注入する、既存registryStore.test.ts等と同じ既存pattern。
//
// Human Owner re-review (2026-10-04) corrections covered here:
//   - complete() has no default `trustedDeps` — every call site below
//     constructs one explicitly, and there is no module-level "default
//     production capture" to accidentally fall back to.
//   - observationMode/preExecutionVisible default to null/false unless a
//     trusted adapter explicitly asserts otherwise via
//     CompleteDeps.observationProvenance — never inferred from "a
//     Preflight happened".
//   - preflight() retry of an identical invocation returns the FIRST
//     decision ever computed for it, even if the Permission Registry's
//     rules changed in between — never a silent re-evaluation.

import { randomUUID } from "node:crypto";
import { preflight, complete, type PreflightDeps, type CompleteDeps } from "@tact/runs-core/tact-execution/governance/contract";
import { RegistryUnavailableError } from "@tact/runs-core/tact-execution/permission/registryStore";
import type { PreflightRequest, CompleteRequest } from "@tact/execution-contract";
import {
  makeFakeGovernanceStore,
  makeFakeCapture,
  fakeAssertExecutionOutcome,
  makeFakeRule,
} from "./governanceContractFakes";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeRequest(overrides: Partial<PreflightRequest> = {}): PreflightRequest {
  return {
    invocationId: randomUUID(),
    userId: "user-1",
    actorKind: "ai_agent",
    agentId: "agent-1",
    actionCategory: "send",
    operation: "slack.send_message",
    targetProvider: "slack",
    attemptedAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

// Every test below builds its own PreflightDeps explicitly (store methods
// vary per test's fake, but the "now"/"newDecisionId" shape is shared) —
// this helper only removes that boilerplate, it never hides a default.
function makePreflightDeps(
  store: ReturnType<typeof makeFakeGovernanceStore>,
  listActivePermissionRulesForMatching: PreflightDeps["listActivePermissionRulesForMatching"],
  now: Date = new Date("2026-10-04T00:00:01.000Z")
): PreflightDeps {
  return {
    createGovernanceInvocation: store.createGovernanceInvocation,
    listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
    appendGovernanceDecision: store.appendGovernanceDecision,
    listActivePermissionRulesForMatching,
    newDecisionId: () => randomUUID(),
    now: () => now,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- ALLOW ----
  {
    const store = makeFakeGovernanceStore();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed", reasonCode: "allow_rule" });
    const deps = makePreflightDeps(store, async () => [rule]);
    const outcome = await preflight(makeRequest(), deps);
    results.push(check("[ALLOW] verdict=ALLOW", outcome.status === "decided" && outcome.response.verdict === "ALLOW"));
    results.push(check("[ALLOW] reasonCode carries matched rule", outcome.status === "decided" && outcome.response.reasonCode === "allow_rule"));
  }

  // ---- DENY ----
  {
    const store = makeFakeGovernanceStore();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "denied", reasonCode: "deny_rule" });
    const deps = makePreflightDeps(store, async () => [rule]);
    const outcome = await preflight(makeRequest(), deps);
    results.push(check("[DENY] verdict=DENY", outcome.status === "decided" && outcome.response.verdict === "DENY"));
  }

  // ---- APPROVAL_REQUIRED ----
  {
    const store = makeFakeGovernanceStore();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "approval_required", reasonCode: "approval_rule" });
    const deps = makePreflightDeps(store, async () => [rule]);
    const outcome = await preflight(makeRequest(), deps);
    results.push(check("[APPROVAL_REQUIRED] verdict=APPROVAL_REQUIRED", outcome.status === "decided" && outcome.response.verdict === "APPROVAL_REQUIRED"));
    results.push(check(
      "[APPROVAL_REQUIRED] approval fields are present but unresolved in Slice 1",
      outcome.status === "decided" && outcome.response.approval.approvalId === null && outcome.response.approval.status === null
    ));
  }

  // ---- no-match => UNKNOWN (never silently ALLOW) ----
  {
    const store = makeFakeGovernanceStore();
    const deps = makePreflightDeps(store, async () => []);
    const outcome = await preflight(makeRequest(), deps);
    results.push(check(
      "[no-match] verdict=UNKNOWN, reasonCode=no_matching_registry_rule, never ALLOW",
      outcome.status === "decided" && outcome.response.verdict === "UNKNOWN" && outcome.response.reasonCode === "no_matching_registry_rule"
    ));
  }

  // ---- ambiguous => UNKNOWN (never silently pick one) ----
  {
    const store = makeFakeGovernanceStore();
    const ruleA = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed", priority: 0 });
    const ruleB = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed", priority: 0 });
    const deps = makePreflightDeps(store, async () => [ruleA, ruleB]);
    const outcome = await preflight(makeRequest(), deps);
    results.push(check(
      "[ambiguous] verdict=UNKNOWN, reasonCode=ambiguous_registry_rules even though both candidates agree on \"allowed\"",
      outcome.status === "decided" && outcome.response.verdict === "UNKNOWN" && outcome.response.reasonCode === "ambiguous_registry_rules"
    ));
  }

  // ---- invocation idempotency: identical resubmission returns the SAME decision, not a fresh one ----
  {
    const store = makeFakeGovernanceStore();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed" });
    const deps = makePreflightDeps(store, async () => [rule]);
    const request = makeRequest();
    const first = await preflight(request, deps);
    const second = await preflight(request, deps);
    results.push(check(
      "[idempotency] identical resubmission is answered twice without duplicating the invocation row",
      first.status === "decided" && second.status === "decided" && store.invocations.size === 1
    ));
    results.push(check(
      "[idempotency] identical resubmission returns the exact same decisionId (first decision, not a fresh evaluation)",
      first.status === "decided" && second.status === "decided" && first.response.decisionId === second.response.decisionId
    ));
    results.push(check(
      "[idempotency] identical resubmission never appends a second GovernanceDecision row",
      store.decisions.size === 1
    ));
  }

  // ---- policy change between retries must not change the retry's own answer ----
  {
    const store = makeFakeGovernanceStore();
    const allowRule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed", reasonCode: "was_allowed" });
    const denyRule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "denied", reasonCode: "now_denied" });

    let activeRules = [allowRule];
    const deps = makePreflightDeps(store, async () => activeRules);

    const request = makeRequest();
    const first = await preflight(request, deps);

    // The Permission Registry changes in between — a real tenant editing
    // their rules, not a test artifact.
    activeRules = [denyRule];

    const retry = await preflight(request, deps);

    results.push(check(
      "[policy-change-retry] a retry of the identical invocation keeps the ORIGINAL verdict even though the registry now disagrees",
      first.status === "decided" && retry.status === "decided" &&
      first.response.verdict === "ALLOW" && retry.response.verdict === "ALLOW" &&
      first.response.reasonCode === "was_allowed" && retry.response.reasonCode === "was_allowed"
    ));

    results.push(check(
      "[policy-change-retry] still exactly one GovernanceDecision row — no silent re-evaluation under the \"idempotent\" label",
      store.decisions.size === 1
    ));

    // A genuinely NEW invocation against the same (now-changed) registry
    // must see the new rule — proving the retry guard is scoped to the
    // specific invocationId, not a global freeze of the registry.
    const freshInvocationOutcome = await preflight(makeRequest(), deps);
    results.push(check(
      "[policy-change-retry] a different invocationId is still evaluated against the CURRENT registry",
      freshInvocationOutcome.status === "decided" && freshInvocationOutcome.response.verdict === "DENY"
    ));
  }

  // ---- invocation ID conflict: same id, different content ----
  {
    const store = makeFakeGovernanceStore();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed" });
    const deps = makePreflightDeps(store, async () => [rule]);
    const invocationId = randomUUID();
    const first = await preflight(makeRequest({ invocationId, operation: "slack.send_message" }), deps);
    const second = await preflight(makeRequest({ invocationId, operation: "slack.delete_message" }), deps);
    results.push(check(
      "[conflict] reusing an invocationId with different content is rejected explicitly, never silently overwritten",
      first.status === "decided" && second.status === "invocation_conflict"
    ));
  }

  // ---- RegistryUnavailableError propagates uncaught (fail-closed) ----
  {
    const store = makeFakeGovernanceStore();
    const deps = makePreflightDeps(store, async () => {
      throw new RegistryUnavailableError("registry unreachable");
    });
    let threw = false;
    try {
      await preflight(makeRequest(), deps);
    } catch (error) {
      threw = error instanceof RegistryUnavailableError;
    }
    results.push(check(
      "[fail-closed] a registry read failure is a thrown RegistryUnavailableError, never a resolved UNKNOWN/ALLOW outcome",
      threw
    ));
  }

  // ---- invalid request is rejected before touching any store ----
  {
    const store = makeFakeGovernanceStore();
    const deps = makePreflightDeps(store, async () => []);
    const outcome = await preflight(makeRequest({ actorKind: "not_a_real_actor_kind" }), deps);
    results.push(check(
      "[invalid] an unrecognized actorKind is rejected with status=invalid and never reaches the store",
      outcome.status === "invalid" && store.invocations.size === 0
    ));
  }

  // ---- complete(): has no default trustedDeps; every call site below is explicit ----
  {
    const store = makeFakeGovernanceStore();
    const capture = makeFakeCapture();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed" });
    const preflightDeps = makePreflightDeps(store, async () => [rule]);
    const request = makeRequest({ operation: "slack.send_message", resourceIdentifier: "C123" });
    const decided = await preflight(request, preflightDeps);

    if (decided.status !== "decided") {
      results.push(check("[complete setup] preflight must decide before complete() can be exercised", false, decided.status));
    } else {

      const trustedDeps: CompleteDeps = {
        getGovernanceInvocation: store.getGovernanceInvocation,
        listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
        capture: capture.capture,
        linkInvocationExecution: store.linkInvocationExecution,
        assertExecutionOutcome: fakeAssertExecutionOutcome,
        // Deliberately omitted: observationProvenance. complete() must
        // default to null/false, never to "inline"/true just because a
        // Preflight preceded it.
      };

      const completeRequest: CompleteRequest = {
        decisionId: decided.response.decisionId,
        invocationId: decided.response.invocationId,
        execution: {
          provider: "slack",
          sourceType: "sdk_callback",
          externalEventId: "evt-1",
          adapterVersion: "test-v1",
          status: "succeeded",
        },
        outcome: { status: "asserted", outcomeKind: "message_sent", summary: "sent" },
      };

      const result = await complete(completeRequest, request.userId, trustedDeps);
      const receivedInput = capture.receivedInputs[0];

      results.push(check("[complete] links the Execution", result.status === "linked" && Boolean(result.executionId)));
      results.push(check("[complete] GovernanceExecutionLink is explicit", store.linksByExecutionId.size === 1));
      results.push(check(
        "[complete] without an explicit observationProvenance, observationMode stays null and preExecutionVisible stays false — never inferred from \"a Preflight happened\"",
        receivedInput?.observationMode === null && receivedInput?.preExecutionVisible === false
      ));
      results.push(check(
        "[complete] attempted action/actor are the Invocation's own snapshot, not re-decided from the completion request",
        receivedInput?.actionCategory === "send" && receivedInput?.operation === "slack.send_message" && receivedInput?.agentId === "agent-1"
      ));
      results.push(check("[complete] outcome recorded via the existing ExecutionOutcome model, no second outcome concept", result.outcomeRecorded === true));

    }
  }

  // ---- complete(): a trusted adapter that CAN truthfully prove inline/pre-execution-visible may assert it explicitly ----
  {
    const store = makeFakeGovernanceStore();
    const capture = makeFakeCapture();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed" });
    const preflightDeps = makePreflightDeps(store, async () => [rule]);
    const decided = await preflight(makeRequest(), preflightDeps);

    if (decided.status !== "decided") {
      results.push(check("[provenance setup] preflight must decide before complete() can be exercised", false, decided.status));
    } else {

      const trustedDeps: CompleteDeps = {
        getGovernanceInvocation: store.getGovernanceInvocation,
        listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
        capture: capture.capture,
        linkInvocationExecution: store.linkInvocationExecution,
        assertExecutionOutcome: fakeAssertExecutionOutcome,
        // This specific synthetic adapter stands in for a genuine inline
        // dispatch-path adapter that can truthfully make this claim — the
        // claim comes from the trusted adapter context, never from the
        // wire CompleteRequest.
        observationProvenance: { observationMode: "inline", preExecutionVisible: true },
      };

      await complete(
        {
          decisionId: decided.response.decisionId,
          invocationId: decided.response.invocationId,
          execution: { provider: "slack", sourceType: "sdk_callback", externalEventId: "evt-inline", adapterVersion: "test-v1" },
        },
        "user-1",
        trustedDeps
      );

      const receivedInput = capture.receivedInputs[0];

      results.push(check(
        "[provenance] a trusted adapter's explicit observationProvenance is honored verbatim",
        receivedInput?.observationMode === "inline" && receivedInput?.preExecutionVisible === true
      ));

    }
  }

  // ---- complete(): un-preflighted Execution capture remains valid and is never required to call complete() ----
  {
    const capture = makeFakeCapture();
    const outcome = await capture.capture({
      userId: "user-1",
      actorKind: "human",
      provider: "slack",
      sourceType: "webhook",
      externalEventId: "evt-standalone",
      adapterVersion: "test-v1",
      actionCategory: "create",
      operation: "slack.app_mention",
    });
    results.push(check(
      "[un-preflighted] an Execution captured without ever calling preflight()/complete() is still a valid observation",
      outcome.status === "captured"
    ));
  }

  // ---- complete(): decision/invocation must exist first ----
  {
    const store = makeFakeGovernanceStore();
    const capture = makeFakeCapture();
    const trustedDeps: CompleteDeps = {
      getGovernanceInvocation: store.getGovernanceInvocation,
      listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
      capture: capture.capture,
      linkInvocationExecution: store.linkInvocationExecution,
      assertExecutionOutcome: fakeAssertExecutionOutcome,
    };
    const result = await complete(
      {
        decisionId: randomUUID(),
        invocationId: randomUUID(),
        execution: { provider: "slack", sourceType: "sdk_callback", externalEventId: "evt-none", adapterVersion: "test-v1" },
      },
      "user-1",
      trustedDeps
    );
    results.push(check("[complete] a decisionId/invocationId that was never preflighted resolves to invocation_not_found, not a fabricated link", result.status === "invocation_not_found"));
  }

  // ---- complete(): execution_already_linked surfaces as an explicit conflict ----
  {
    const store = makeFakeGovernanceStore();
    const capture = makeFakeCapture();
    const rule = makeFakeRule({ targetProvider: "slack", actionCategory: "send", decision: "allowed" });
    const preflightDeps = makePreflightDeps(store, async () => [rule]);
    const trustedDeps: CompleteDeps = {
      getGovernanceInvocation: store.getGovernanceInvocation,
      listGovernanceDecisionsForInvocation: store.listGovernanceDecisionsForInvocation,
      capture: capture.capture,
      linkInvocationExecution: store.linkInvocationExecution,
      assertExecutionOutcome: fakeAssertExecutionOutcome,
    };

    const decidedA = await preflight(makeRequest(), preflightDeps);
    const decidedB = await preflight(makeRequest(), preflightDeps);

    if (decidedA.status !== "decided" || decidedB.status !== "decided") {
      results.push(check("[link_conflict setup] both preflights must decide", false));
    } else {

      // Deliberately reuse the same externalEventId so the fake capture's
      // own idempotency dedup hands back the SAME execution id for a
      // second, unrelated invocation — exactly the scenario the real
      // execution_id UNIQUE constraint on tact_governance_invocation_
      // execution_links guards against.
      const sharedExecutionEvidence = {
        provider: "slack",
        sourceType: "sdk_callback" as const,
        externalEventId: "evt-shared",
        adapterVersion: "test-v1",
      };

      const firstComplete = await complete(
        { decisionId: decidedA.response.decisionId, invocationId: decidedA.response.invocationId, execution: sharedExecutionEvidence },
        "user-1",
        trustedDeps
      );
      const secondComplete = await complete(
        { decisionId: decidedB.response.decisionId, invocationId: decidedB.response.invocationId, execution: sharedExecutionEvidence },
        "user-1",
        trustedDeps
      );

      results.push(check(
        "[link_conflict] the same Execution cannot be silently re-attributed to a second Invocation",
        firstComplete.status === "linked" && secondComplete.status === "link_conflict"
      ));

    }
  }

  return summarize("SOR-138 Slice 1 — governance/contract (preflight/complete)", results);

}
