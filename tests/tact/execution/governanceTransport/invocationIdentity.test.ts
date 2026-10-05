// =========================
// SOR-138 Slice 3A-2 — Governance Invocation Identity
// =========================
//
// Tests deriveGovernanceInvocationId() (core/tact-integration/
// runsGovernance.ts) in isolation — pure, synchronous, no network, no DB.
// This is a custom deterministic UUIDv8-style identifier (NOT UUIDv5 — see
// the function's own header comment); these tests verify the format
// contract directly rather than trusting the label.

import { deriveGovernanceInvocationId, type GovernanceInvocationIdentityInput } from "../../../../core/tact-integration/runsGovernance";
import { check, summarize, type CheckResult } from "../../lib/check";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeInput(overrides: Partial<GovernanceInvocationIdentityInput> = {}): GovernanceInvocationIdentityInput {
  return {
    userId: "user-a",
    workId: "work-1",
    taskId: "task-1",
    nextAttempt: 1,
    connectionId: "conn-1",
    service: "slack",
    operation: "list_channels",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const id = deriveGovernanceInvocationId(makeInput());

  // [1] UUID format valid
  results.push(check("[1] derived identity matches standard UUID string shape", UUID_SHAPE.test(id)));

  // [2] version nibble is 8
  {
    const versionNibble = id.split("-")[2][0];
    results.push(check("[2] version nibble is 8 (RFC 4122 §4.4 implementation-specific, not UUIDv5's 5)", versionNibble === "8"));
  }

  // [3] RFC variant valid (the first hex digit of the 4th group must be 8, 9, a, or b -> binary 10xx)
  {
    const variantNibble = id.split("-")[3][0];
    results.push(check("[3] RFC 4122 variant bits are valid (10xx)", ["8", "9", "a", "b"].includes(variantNibble)));
  }

  // [4] deterministic
  {
    const again = deriveGovernanceInvocationId(makeInput());
    results.push(check("[4] identical input derives the identical identity", id === again));
  }

  // [5] nextAttempt changes the identity
  {
    const changed = deriveGovernanceInvocationId(makeInput({ nextAttempt: 2 }));
    results.push(check("[5] a different nextAttempt derives a different identity", id !== changed));
  }

  // [6] connectionId changes the identity
  {
    const changed = deriveGovernanceInvocationId(makeInput({ connectionId: "conn-2" }));
    results.push(check("[6] a different connectionId derives a different identity", id !== changed));
  }

  // [7] operation changes the identity
  {
    const changed = deriveGovernanceInvocationId(makeInput({ operation: "send_message" }));
    results.push(check("[7] a different operation derives a different identity", id !== changed));
  }

  // [8] userId/taskId/workId each change the identity
  {
    const changedUser = deriveGovernanceInvocationId(makeInput({ userId: "user-b" }));
    const changedTask = deriveGovernanceInvocationId(makeInput({ taskId: "task-2" }));
    const changedWork = deriveGovernanceInvocationId(makeInput({ workId: "work-2" }));
    results.push(check(
      "[8] a different userId/taskId/workId each independently derives a different identity",
      id !== changedUser && id !== changedTask && id !== changedWork &&
      changedUser !== changedTask && changedTask !== changedWork
    ));
  }

  // [9] service changes the identity too (not required by the task's own
  // list, but directly implied by it — the function accepts service as an
  // input precisely so a future second governed action never collides
  // with slack.list_channels under the same connection/attempt).
  {
    const changed = deriveGovernanceInvocationId(makeInput({ service: "gmail" }));
    results.push(check("[9] a different service derives a different identity", id !== changed));
  }

  return summarize("execution/governanceTransport/invocationIdentity", results);

}
