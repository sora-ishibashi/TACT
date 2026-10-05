// =========================
// SOR-138 Slice 3A-2 — GovernanceInvocation attemptedAt idempotency correction
// =========================
//
// Exercises the REAL governance/store.ts createGovernanceInvocation()
// (not the in-memory fake used by contract.test.ts — see
// governanceContractFakes.ts's own matching fix) against a fake Supabase
// client, same convention as approvalRequestStore.test.ts. Proves the
// store's own invocationComparablePayload() correctly excludes
// attemptedAt from idempotency comparison while still treating every
// other authorization-relevant field as identity.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createGovernanceInvocation,
  type GovernanceStoreDeps,
} from "@tact/runs-core/tact-execution/governance/store";
import type { GovernanceInvocationInput } from "@tact/runs-core/tact-execution/governance/types";
import { check, summarize, type CheckResult } from "../../lib/check";

const DUPLICATE_ERROR = { code: "23505", message: "duplicate key value violates unique constraint" };

// Sequential fake client — same shape as approvalRequestStore.test.ts's
// own makeSequentialFakeClient(): each `.single()`/`.maybeSingle()` call
// consumes the next entry in call order. createGovernanceInvocation()'s
// duplicate-PK path makes exactly two calls: the failed insert attempt
// (.single()), then the recovery read (.maybeSingle()).
function makeSequentialFakeClient(singleResults: Array<{ data: unknown; error: unknown }>) {
  let callIndex = 0;
  const builder = {
    from: () => builder,
    insert: () => builder,
    select: () => builder,
    eq: () => builder,
    single: async () => singleResults[callIndex++],
    maybeSingle: async () => singleResults[callIndex++],
  };
  return builder as unknown as SupabaseClient;
}

function invocationRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    user_id: "user-1",
    organization_id: null,
    workspace_id: null,
    work_id: "work-1",
    connection_id: "conn-1",
    actor_kind: "ai_agent",
    actor_id: null,
    agent_id: null,
    on_behalf_of_actor_kind: null,
    on_behalf_of_actor_id: null,
    action_category: "read",
    operation: "list_channels",
    resource_type: null,
    resource_identifier: null,
    target_provider: "slack",
    attempted_at: "2026-10-05T00:00:00.000Z",
    created_at: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

function invocationInput(overrides: Partial<GovernanceInvocationInput> = {}): GovernanceInvocationInput {
  return {
    id: "inv-1",
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: "work-1",
    connectionId: "conn-1",
    actorKind: "ai_agent",
    actorId: null,
    agentId: null,
    onBehalfOfActorKind: null,
    onBehalfOfActorId: null,
    actionCategory: "read",
    operation: "list_channels",
    resourceType: null,
    resourceIdentifier: null,
    targetProvider: "slack",
    attemptedAt: "2026-10-05T00:05:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // [1] same payload + different attemptedAt -> already_exists, no conflict
  {
    const client = makeSequentialFakeClient([
      { data: null, error: DUPLICATE_ERROR },
      { data: invocationRowFixture({ attempted_at: "2026-10-05T00:00:00.000Z" }), error: null },
    ]);
    const deps: GovernanceStoreDeps = { getClient: () => client };
    const outcome = await createGovernanceInvocation(invocationInput({ attemptedAt: "2026-10-05T00:05:00.000Z" }), deps);
    results.push(check(
      "[1] same invocation payload with a different attemptedAt resolves to already_exists, never idempotency_conflict",
      outcome.status === "already_exists"
    ));
  }

  // [2] stored first attemptedAt remains unchanged
  {
    const originalRow = invocationRowFixture({ attempted_at: "2026-10-05T00:00:00.000Z" });
    const client = makeSequentialFakeClient([
      { data: null, error: DUPLICATE_ERROR },
      { data: originalRow, error: null },
    ]);
    const deps: GovernanceStoreDeps = { getClient: () => client };
    const outcome = await createGovernanceInvocation(invocationInput({ attemptedAt: "2026-10-05T00:05:00.000Z" }), deps);
    results.push(check(
      "[2] the returned invocation carries the ORIGINALLY stored attemptedAt, not the retry's later timestamp",
      outcome.status === "already_exists" && outcome.invocation.attemptedAt === "2026-10-05T00:00:00.000Z"
    ));
  }

  // [3] changed workId -> idempotency_conflict
  {
    const client = makeSequentialFakeClient([
      { data: null, error: DUPLICATE_ERROR },
      { data: invocationRowFixture({ work_id: "work-1" }), error: null },
    ]);
    const deps: GovernanceStoreDeps = { getClient: () => client };
    const outcome = await createGovernanceInvocation(invocationInput({ workId: "work-2" }), deps);
    results.push(check("[3] a changed workId still conflicts", outcome.status === "idempotency_conflict"));
  }

  // [4] changed connectionId -> idempotency_conflict
  {
    const client = makeSequentialFakeClient([
      { data: null, error: DUPLICATE_ERROR },
      { data: invocationRowFixture({ connection_id: "conn-1" }), error: null },
    ]);
    const deps: GovernanceStoreDeps = { getClient: () => client };
    const outcome = await createGovernanceInvocation(invocationInput({ connectionId: "conn-2" }), deps);
    results.push(check("[4] a changed connectionId still conflicts", outcome.status === "idempotency_conflict"));
  }

  // [5] changed operation -> idempotency_conflict
  {
    const client = makeSequentialFakeClient([
      { data: null, error: DUPLICATE_ERROR },
      { data: invocationRowFixture({ operation: "list_channels" }), error: null },
    ]);
    const deps: GovernanceStoreDeps = { getClient: () => client };
    const outcome = await createGovernanceInvocation(invocationInput({ operation: "send_message" }), deps);
    results.push(check("[5] a changed operation still conflicts", outcome.status === "idempotency_conflict"));
  }

  // [6] changed actor/action/provider fields -> idempotency_conflict (sampled, not exhaustive)
  {
    const cases: Array<[string, Partial<GovernanceInvocationInput>]> = [
      ["actorKind", { actorKind: "service" }],
      ["agentId", { agentId: "agent-2" }],
      ["actionCategory", { actionCategory: "send" }],
      ["targetProvider", { targetProvider: "gmail" }],
      ["userId", { userId: "user-2" }],
      ["taskId placeholder (resourceIdentifier)", { resourceIdentifier: "channel-2" }],
    ];

    let allConflicted = true;

    for (const [, overrides] of cases) {
      const client = makeSequentialFakeClient([
        { data: null, error: DUPLICATE_ERROR },
        { data: invocationRowFixture(), error: null },
      ]);
      const deps: GovernanceStoreDeps = { getClient: () => client };
      const outcome = await createGovernanceInvocation(invocationInput(overrides), deps);
      if (outcome.status !== "idempotency_conflict") {
        allConflicted = false;
      }
    }

    results.push(check(
      "[6] a changed actorKind/agentId/actionCategory/targetProvider/userId/resourceIdentifier each still conflicts",
      allConflicted
    ));
  }

  // Sanity: a genuinely identical retry (same attemptedAt too) still
  // resolves to already_exists — confirms the fix did not accidentally
  // widen the conflict condition, only narrow out attemptedAt specifically.
  {
    const client = makeSequentialFakeClient([
      { data: null, error: DUPLICATE_ERROR },
      { data: invocationRowFixture({ attempted_at: "2026-10-05T00:05:00.000Z" }), error: null },
    ]);
    const deps: GovernanceStoreDeps = { getClient: () => client };
    const outcome = await createGovernanceInvocation(invocationInput({ attemptedAt: "2026-10-05T00:05:00.000Z" }), deps);
    results.push(check(
      "[sanity] a fully identical retry (including attemptedAt) still resolves to already_exists",
      outcome.status === "already_exists"
    ));
  }

  return summarize("execution/governance/invocationStore", results);

}
