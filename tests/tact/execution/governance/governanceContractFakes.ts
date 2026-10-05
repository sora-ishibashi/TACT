// =========================
// SOR-138 Slice 1 — Shared in-memory fakes for Preflight/Complete contract tests
// =========================
//
// Zero real Supabase/DB access (same convention as registryStore.test.ts's
// own in-memory fake client). Zero Composio/Slack SDK/Notion SDK/LLM SDK
// dependency — these fakes only move plain data through the same shapes
// the real stores persist, so the two contract test files can exercise
// preflight()/complete() against deterministic, inspectable state instead
// of a live database.

import type {
  GovernanceInvocation,
  GovernanceInvocationInput,
  GovernanceDecision,
  GovernanceDecisionInput,
  GovernanceExecutionLink,
  GovernanceExecutionLinkInput,
  GovernanceApprovalRequest,
  GovernanceApprovalRequestInput,
  GovernanceApprovalRequestStatus,
  GovernanceApprovalResolver,
} from "@tact/runs-core/tact-execution/governance/types";
import type {
  CanonicalExecution,
  CaptureExecutionInput,
  CaptureExecutionOutcome,
} from "@tact/runs-core/tact-execution";
import type { AssertExecutionOutcomeInput, AssertExecutionOutcomeResult } from "@tact/runs-core/tact-execution";
import type { PermissionRegistryRule } from "@tact/runs-core/tact-execution/permission/types";

function canonicalJson(value: unknown): string {

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;

  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;

}

// Idempotency comparison ignores the server-assigned createdAt, the same
// relaxation governance/store.ts's own real `same()` helper needs for
// evaluatedAt/approvedAt instant-rendering differences — here there is no
// instant-rendering difference (everything stays as the caller's own ISO
// string), so a plain field-drop is enough.
//
// SOR-138 Slice 3A-2 correction: also excludes attemptedAt, mirroring the
// real governance/store.ts's own invocationComparablePayload() fix — a
// GovernanceInvocation retry with the same invocationId and otherwise
// identical fields legitimately carries a different attemptedAt (it is
// informational metadata about the first accepted claim, not part of
// invocation identity or authorization — see that file's own comment).
// This key is simply absent on GovernanceDecision objects, so stripping it
// here is a no-op for appendGovernanceDecision()'s own use of this same
// helper.
function sameExcludingVolatileFields(a: unknown, b: unknown): boolean {
  const strip = (value: unknown) => {
    const record = { ...(value as Record<string, unknown>) };
    delete record.createdAt;
    delete record.attemptedAt;
    return record;
  };
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

export type FakeCreateInvocationOutcome =
  | { status: "created"; invocation: GovernanceInvocation }
  | { status: "already_exists"; invocation: GovernanceInvocation }
  | { status: "idempotency_conflict" }
  | { status: "error"; message: string };

export type FakeAppendDecisionOutcome =
  | { status: "created"; decision: GovernanceDecision }
  | { status: "already_exists"; decision: GovernanceDecision }
  | { status: "idempotency_conflict" };

export type FakeLinkOutcome =
  | { status: "created"; link: GovernanceExecutionLink }
  | { status: "already_exists"; link: GovernanceExecutionLink }
  | { status: "execution_already_linked" };

export type FakeEnsureApprovalRequestOutcome =
  | { status: "created"; approvalRequest: GovernanceApprovalRequest }
  | { status: "already_exists"; approvalRequest: GovernanceApprovalRequest }
  | { status: "decision_not_found" }
  | { status: "verdict_not_approval_required" }
  | { status: "invalid"; errors: string[] };

export type FakeResolveApprovalRequestOutcome =
  | { status: "resolved"; approvalRequest: GovernanceApprovalRequest }
  | { status: "already_resolved"; approvalRequest: GovernanceApprovalRequest }
  | { status: "not_found" }
  | { status: "invalid"; errors: string[] };

export interface FakeGovernanceStoreOptions {

  // Inserts one microtask yield before each store function's own
  // check-then-write step, so two calls issued back-to-back via
  // Promise.all genuinely interleave at the same point two truly
  // concurrent requests against real Postgres connections would — used
  // only by the concurrency-focused test file. Default false: every
  // other test in this suite relies on fully synchronous, deterministic
  // single-caller ordering and must not be affected by this.
  artificialRaceYield?: boolean;

}

export function makeFakeGovernanceStore(options: FakeGovernanceStoreOptions = {}) {

  const { artificialRaceYield = false } = options;

  // tact_governance_invocations.id is "id uuid primary key" — GLOBALLY
  // unique, not scoped per tenant (products/yolna-runs/supabase/
  // migrations/20270101000013...sql). The accompanying
  // unique(id, user_id) exists only to let tact_governance_decisions /
  // tact_governance_invocation_execution_links reference the composite
  // (invocation_id, user_id) pair as a foreign key — it does not relax
  // id's own global uniqueness, and it does NOT mean the same
  // invocationId string can belong to two different tenants as two
  // separate rows. Keyed here by id alone, exactly mirroring the real PK.
  const invocations = new Map<string, GovernanceInvocation>();
  // tact_governance_decisions.id is also a GLOBAL primary key — likewise
  // keyed by id alone.
  const decisions = new Map<string, GovernanceDecision>();
  const linksByExecutionId = new Map<string, GovernanceExecutionLink>();
  let linkIdCounter = 0;
  // Keyed by governance_decision_id, mirroring the real table's
  // UNIQUE(governance_decision_id) constraint — the sole concurrency
  // boundary for this table (see store.ts's own comment).
  const approvalRequestsByDecisionId = new Map<string, GovernanceApprovalRequest>();
  const approvalRequestsById = new Map<string, GovernanceApprovalRequest>();
  let approvalRequestIdCounter = 0;

  async function maybeYield(): Promise<void> {
    if (artificialRaceYield) {
      await Promise.resolve();
    }
  }

  async function createGovernanceInvocation(input: GovernanceInvocationInput): Promise<FakeCreateInvocationOutcome> {

    await maybeYield();

    const existing = invocations.get(input.id);

    if (!existing) {
      const invocation: GovernanceInvocation = { ...input, createdAt: new Date().toISOString() };
      invocations.set(input.id, invocation);
      return { status: "created", invocation };
    }

    // Mirrors governance/store.ts's own createGovernanceInvocation()
    // duplicate-PK recovery exactly: the recovery read is scoped by BOTH
    // id AND user_id (`.eq("id", input.id).eq("user_id", input.userId)`).
    // When the PK collision is against a row owned by a DIFFERENT
    // tenant, that scoped read finds nothing — it can never read, leak,
    // or adopt another tenant's row. The real store then reports
    // "duplicate claim could not be read" rather than already_exists or
    // idempotency_conflict (those two statuses are reserved for a
    // same-tenant row this caller is actually allowed to read back).
    if (existing.userId !== input.userId) {
      return { status: "error", message: "duplicate claim could not be read" };
    }

    return sameExcludingVolatileFields(existing, input)
      ? { status: "already_exists", invocation: existing }
      : { status: "idempotency_conflict" };

  }

  async function appendGovernanceDecision(input: GovernanceDecisionInput): Promise<FakeAppendDecisionOutcome> {

    await maybeYield();

    const existing = decisions.get(input.id);

    if (!existing) {
      const decision: GovernanceDecision = { ...input, createdAt: new Date().toISOString() };
      decisions.set(input.id, decision);
      return { status: "created", decision };
    }

    return sameExcludingVolatileFields(existing, input)
      ? { status: "already_exists", decision: existing }
      : { status: "idempotency_conflict" };

  }

  async function getGovernanceInvocation(id: string, userId: string): Promise<GovernanceInvocation | undefined> {
    const invocation = invocations.get(id);
    return invocation && invocation.userId === userId ? invocation : undefined;
  }

  async function listGovernanceDecisionsForInvocation(id: string, userId: string): Promise<GovernanceDecision[]> {
    return Array.from(decisions.values()).filter((decision) => decision.invocationId === id && decision.userId === userId);
  }

  async function linkInvocationExecution(input: GovernanceExecutionLinkInput): Promise<FakeLinkOutcome> {

    const existing = linksByExecutionId.get(input.executionId);

    if (!existing) {
      linkIdCounter += 1;
      const link: GovernanceExecutionLink = {
        id: `link-${linkIdCounter}`,
        userId: input.userId,
        invocationId: input.invocationId,
        effectiveGovernanceDecisionId: input.effectiveGovernanceDecisionId ?? null,
        executionId: input.executionId,
        linkedAt: new Date().toISOString(),
      };
      linksByExecutionId.set(input.executionId, link);
      return { status: "created", link };
    }

    const matches =
      existing.invocationId === input.invocationId &&
      existing.effectiveGovernanceDecisionId === (input.effectiveGovernanceDecisionId ?? null);

    return matches ? { status: "already_exists", link: existing } : { status: "execution_already_linked" };

  }

  // Private helper — mirrors store.ts's own non-exported
  // createGovernanceApprovalRequest(): raw, non-verifying insert. Not
  // returned from this factory's public object, for the same reason the
  // real one isn't exported from the governance barrel (see store.ts's
  // comment) — the only path a test may call is
  // ensureGovernanceApprovalRequestForDecision() below.
  async function insertApprovalRequestRow(input: GovernanceApprovalRequestInput): Promise<FakeEnsureApprovalRequestOutcome> {

    if (!input.userId || !input.governanceDecisionId) {
      return { status: "invalid", errors: ["userId and governanceDecisionId are required"] };
    }

    const existing = approvalRequestsByDecisionId.get(input.governanceDecisionId);

    if (existing) {
      // No canonical-payload comparison here (unlike invocation/decision) —
      // there is nothing mutable to disagree on besides the decision id
      // itself, so a duplicate claim is unconditionally already_exists
      // (same simplification store.ts's own createGovernanceApprovalRequest
      // makes, see that function's comment).
      return { status: "already_exists", approvalRequest: existing };
    }

    approvalRequestIdCounter += 1;

    const approvalRequest: GovernanceApprovalRequest = {
      id: `apr-${approvalRequestIdCounter}`,
      userId: input.userId,
      governanceDecisionId: input.governanceDecisionId,
      status: "pending",
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedByActorKind: null,
      resolvedByActorId: null,
      createdAt: new Date().toISOString(),
    };

    approvalRequestsByDecisionId.set(input.governanceDecisionId, approvalRequest);
    approvalRequestsById.set(approvalRequest.id, approvalRequest);

    return { status: "created", approvalRequest };

  }

  // Mirrors store.ts's own ensureGovernanceApprovalRequestForDecision()
  // exactly (Human Owner correction 2): never trusts a caller-supplied
  // verdict — always re-reads the persisted decision from this fake's own
  // `decisions` map and verifies tenant + verdict before creating
  // anything. Missing decision and a different tenant's decision
  // deliberately collapse to the same decision_not_found outcome.
  async function ensureGovernanceApprovalRequestForDecision(governanceDecisionId: string, trustedUserId: string): Promise<FakeEnsureApprovalRequestOutcome> {

    await maybeYield();

    if (!governanceDecisionId || !trustedUserId) {
      return { status: "invalid", errors: ["governanceDecisionId and trustedUserId are required"] };
    }

    const decision = decisions.get(governanceDecisionId);

    if (!decision || decision.userId !== trustedUserId) {
      return { status: "decision_not_found" };
    }

    if (decision.verdict !== "APPROVAL_REQUIRED") {
      return { status: "verdict_not_approval_required" };
    }

    return insertApprovalRequestRow({ userId: trustedUserId, governanceDecisionId });

  }

  async function getGovernanceApprovalRequest(id: string, userId: string): Promise<GovernanceApprovalRequest | undefined> {
    const approvalRequest = approvalRequestsById.get(id);
    return approvalRequest && approvalRequest.userId === userId ? approvalRequest : undefined;
  }

  // Single-statement CAS equivalent: mirrors store.ts's
  // transitionGovernanceApprovalRequest() exactly — tenant ownership +
  // status === "pending" is the CAS predicate, re-checked synchronously
  // here (JS execution between the `maybeYield()` and the mutation below is
  // never preempted, so this still correctly serializes two "concurrent"
  // callers racing via Promise.all, exactly like the real single UPDATE
  // statement would under Postgres' row lock).
  async function resolveGovernanceApprovalRequest(
    id: string,
    userId: string,
    targetStatus: "approved" | "rejected",
    resolver: GovernanceApprovalResolver
  ): Promise<FakeResolveApprovalRequestOutcome> {

    await maybeYield();

    // Mirrors store.ts's validateGovernanceApprovalResolver() exactly
    // (Human Owner correction 1): "human" is the only legal actorKind, and
    // an empty/whitespace-only actorId is rejected before any mutation.
    const actorId = typeof resolver?.actorId === "string" ? resolver.actorId.trim() : "";
    if (resolver?.actorKind !== "human" || actorId.length === 0) {
      return { status: "invalid", errors: [`resolvedByActorKind must be "human" with a non-empty actorId (got actorKind=${JSON.stringify(resolver?.actorKind)})`] };
    }

    const current = approvalRequestsById.get(id);

    if (!current || current.userId !== userId) {
      return { status: "not_found" };
    }

    if (current.status !== "pending") {
      return { status: "already_resolved", approvalRequest: current };
    }

    const resolved: GovernanceApprovalRequest = {
      ...current,
      status: targetStatus,
      resolvedAt: new Date().toISOString(),
      resolvedByActorKind: "human",
      resolvedByActorId: actorId,
    };

    approvalRequestsById.set(id, resolved);
    approvalRequestsByDecisionId.set(resolved.governanceDecisionId, resolved);

    return { status: "resolved", approvalRequest: resolved };

  }

  async function approveGovernanceApprovalRequest(id: string, userId: string, resolver: GovernanceApprovalResolver): Promise<FakeResolveApprovalRequestOutcome> {
    return resolveGovernanceApprovalRequest(id, userId, "approved", resolver);
  }

  async function rejectGovernanceApprovalRequest(id: string, userId: string, resolver: GovernanceApprovalResolver): Promise<FakeResolveApprovalRequestOutcome> {
    return resolveGovernanceApprovalRequest(id, userId, "rejected", resolver);
  }

  return {
    invocations,
    decisions,
    linksByExecutionId,
    approvalRequestsByDecisionId,
    approvalRequestsById,
    createGovernanceInvocation,
    appendGovernanceDecision,
    getGovernanceInvocation,
    listGovernanceDecisionsForInvocation,
    linkInvocationExecution,
    ensureGovernanceApprovalRequestForDecision,
    getGovernanceApprovalRequest,
    approveGovernanceApprovalRequest,
    rejectGovernanceApprovalRequest,
  };

}

export type FakeApprovalRequestStatus = GovernanceApprovalRequestStatus;

export function makeFakeCapture() {

  const executions = new Map<string, CanonicalExecution>();
  const receivedInputs: CaptureExecutionInput[] = [];
  let counter = 0;

  async function capture(input: CaptureExecutionInput): Promise<CaptureExecutionOutcome> {

    receivedInputs.push(input);

    const key = `${input.userId}\u001f${input.provider}\u001f${input.externalEventId}`;
    const existing = executions.get(key);

    if (existing) {
      return { status: "duplicate", execution: existing };
    }

    counter += 1;

    const execution: CanonicalExecution = {
      id: `exec-${counter}`,
      schemaVersion: 1,
      userId: input.userId,
      organizationId: input.organizationId ?? null,
      workspaceId: input.workspaceId ?? null,
      workId: input.workId ?? null,
      correlationStatus: "pending",
      connectionId: input.connectionId ?? null,
      actorKind: input.actorKind,
      actorId: input.actorId ?? null,
      agentId: input.agentId ?? null,
      onBehalfOfActorKind: input.onBehalfOfActorKind ?? null,
      onBehalfOfActorId: input.onBehalfOfActorId ?? null,
      provider: input.provider,
      sourceType: input.sourceType,
      externalEventId: input.externalEventId,
      adapterVersion: input.adapterVersion,
      sourceMetadata: input.sourceMetadata ?? null,
      rawPayloadRef: input.rawPayloadRef ?? null,
      observationMode: input.observationMode ?? null,
      preExecutionVisible: input.preExecutionVisible ?? false,
      actionCategory: input.actionCategory,
      operation: input.operation,
      resourceType: input.resourceType ?? null,
      resourceIdentifier: input.resourceIdentifier ?? null,
      targetProvider: input.targetProvider ?? null,
      status: input.status ?? "observed",
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      permissionStatus: input.permissionStatus ?? "pending",
      permissionReasonCode: null,
      permissionEvaluatedAt: null,
      outcomeStatus: "unknown",
      outcomeKind: null,
      providerOccurredAt: input.providerOccurredAt ?? null,
      observedAt: input.observedAt ?? new Date().toISOString(),
      persistedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    executions.set(key, execution);

    return { status: "captured", execution };

  }

  return { capture, executions, receivedInputs };

}

export async function fakeAssertExecutionOutcome(
  input: AssertExecutionOutcomeInput,
  userId: string
): Promise<AssertExecutionOutcomeResult> {

  void userId;

  return {
    status: "persisted",
    outcome: {
      id: `outcome-${input.executionId}`,
      executionId: input.executionId,
      status: input.status,
      outcomeKind: input.outcomeKind ?? null,
      summary: input.summary ?? null,
      artifactId: input.artifactId ?? null,
      method: input.method,
      reasonCode: input.reasonCode ?? null,
      assertedByActorKind: input.assertedByActorKind ?? null,
      assertedByActorId: input.assertedByActorId ?? null,
      metadata: input.metadata ?? null,
      assertedAt: new Date().toISOString(),
    },
  };

}

let ruleIdCounter = 0;

export function makeFakeRule(overrides: Partial<PermissionRegistryRule> = {}): PermissionRegistryRule {

  ruleIdCounter += 1;

  return {
    id: `rule-${ruleIdCounter}`,
    userId: null,
    identifier: `test-rule-${ruleIdCounter}`,
    revision: 1,
    subjectKind: null,
    actorId: null,
    agentId: null,
    provider: null,
    targetProvider: null,
    resourceType: null,
    actionCategory: null,
    decision: "allowed",
    reasonCode: "test_reason",
    requiresKnownActorId: false,
    requiresKnownAgentId: false,
    connectionId: null,
    priority: 0,
    validFrom: null,
    validUntil: null,
    enabled: true,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };

}
