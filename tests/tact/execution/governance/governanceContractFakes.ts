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
function sameExcludingCreatedAt(a: unknown, b: unknown): boolean {
  const strip = (value: unknown) => {
    const record = { ...(value as Record<string, unknown>) };
    delete record.createdAt;
    return record;
  };
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

export type FakeCreateInvocationOutcome =
  | { status: "created"; invocation: GovernanceInvocation }
  | { status: "already_exists"; invocation: GovernanceInvocation }
  | { status: "idempotency_conflict" };

export type FakeAppendDecisionOutcome =
  | { status: "created"; decision: GovernanceDecision }
  | { status: "already_exists"; decision: GovernanceDecision }
  | { status: "idempotency_conflict" };

export type FakeLinkOutcome =
  | { status: "created"; link: GovernanceExecutionLink }
  | { status: "already_exists"; link: GovernanceExecutionLink }
  | { status: "execution_already_linked" };

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

  // Mirrors the real schema's unique(id, user_id) on
  // tact_governance_invocations (products/yolna-runs/supabase/migrations/
  // 20270101000013...sql): the SAME invocationId string may legitimately
  // belong to two different tenants as two separate rows. Keying this
  // fake by id alone would wrongly make one tenant's invocation collide
  // with another's.
  const invocations = new Map<string, GovernanceInvocation>();
  // tact_governance_decisions.id is a GLOBAL primary key — correctly
  // keyed by id alone.
  const decisions = new Map<string, GovernanceDecision>();
  const linksByExecutionId = new Map<string, GovernanceExecutionLink>();
  let linkIdCounter = 0;

  const invocationKey = (userId: string, id: string) => `${userId}\u001f${id}`;

  async function maybeYield(): Promise<void> {
    if (artificialRaceYield) {
      await Promise.resolve();
    }
  }

  async function createGovernanceInvocation(input: GovernanceInvocationInput): Promise<FakeCreateInvocationOutcome> {

    await maybeYield();

    const key = invocationKey(input.userId, input.id);
    const existing = invocations.get(key);

    if (!existing) {
      const invocation: GovernanceInvocation = { ...input, createdAt: new Date().toISOString() };
      invocations.set(key, invocation);
      return { status: "created", invocation };
    }

    return sameExcludingCreatedAt(existing, input)
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

    return sameExcludingCreatedAt(existing, input)
      ? { status: "already_exists", decision: existing }
      : { status: "idempotency_conflict" };

  }

  async function getGovernanceInvocation(id: string, userId: string): Promise<GovernanceInvocation | undefined> {
    return invocations.get(invocationKey(userId, id));
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

  return {
    invocations,
    decisions,
    linksByExecutionId,
    createGovernanceInvocation,
    appendGovernanceDecision,
    getGovernanceInvocation,
    listGovernanceDecisionsForInvocation,
    linkInvocationExecution,
  };

}

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
