// =========================
// TACT Governance — Provider-neutral Preflight / Complete Contract (SOR-138 Slice 1)
// =========================
//
// Human Owner approval (SOR-138 Slice 1, 2026-10-04): thin orchestration
// only. This file does not reimplement the Permission Registry evaluator
// (SOR-47, ../permission/registryEvaluate.ts) or the Governance Decision
// model (SOR-8B, ./evaluate.ts, ./store.ts) — it only sequences the
// already-landed primitives behind the wire shapes declared in
// @tact/execution-contract.
//
// Absolute conditions carried over from the approved Slice 1 scope:
//
//   - decisionSource stays "runs_permission_registry" and
//     trustLevelSnapshot stays "INTERNAL" (validateGovernanceDecisionInput
//     already rejects any other value). This module does not widen
//     governance decision source and does not add a provider_native
//     variant.
//
//   - RegistryUnavailableError (../permission/registryStore.ts) is never
//     caught here and is never turned into a silent UNKNOWN/ALLOW — it
//     propagates to the caller untouched, the same absolute rule
//     ../permission/registryEvaluate.ts's own evaluatePermissionWithRules()
//     already applies.
//
//   - complete() never treats a caller-supplied CompleteRequest as
//     authoritative execution evidence by itself, and has NO default
//     `deps` parameter — `complete(request, userId)` alone does not
//     compile. A caller must explicitly construct and pass a
//     `CompleteDeps` (named `trustedDeps` at the call site) that supplies
//     its own `capture` function. There is deliberately no exported
//     "the" production deps object in this file either — wiring a real,
//     authenticated adapter's own `capture`/`observationProvenance` is a
//     decision for whatever trusted boundary calls complete() (a future
//     slice's server-only adapter, or a test's own synthetic trusted
//     capture), never an implicit default here. Trust/provenance is never
//     carried as a field on the wire `CompleteRequest` — see
//     @tact/execution-contract's own header comment on this.
//
//   - observationMode/preExecutionVisible on the resulting
//     CanonicalExecution are never inferred from "a Preflight happened
//     for this invocation". Those two fields answer a narrower, different
//     question than Governance history does (../types.ts's own header
//     comment on ExecutionObservationMode: whether Runs was actually on
//     the provider dispatch path and observed the action synchronously,
//     and whether the Execution row itself existed before the provider
//     action completed) — a prior GovernanceInvocation/GovernanceDecision
//     proves neither of those things by itself. complete() therefore only
//     ever uses an optional, trusted-adapter-supplied
//     `observationProvenance` and otherwise defaults to the same honest
//     "not known" values every other adapter uses (null / false). The
//     fact that a Preflight preceded this Execution is recorded
//     exclusively through GovernanceInvocation -> GovernanceDecision ->
//     GovernanceExecutionLink -> CanonicalExecution (the explicit join),
//     never by overloading CanonicalExecution's own observation columns.
//
//   - un-preflighted Execution capture is completely unaffected: nothing
//     here changes ../store.ts's captureExecution() or the existing
//     ingest route. complete() is an additional, optional path a caller
//     may use after a successful preflight() — it is never required, and
//     an Execution captured without ever calling preflight() remains a
//     fully valid, un-preflighted observation (GovernanceExecutionLink
//     simply never exists for it).
//
//   - preflight() retry semantics: resubmitting the identical invocation
//     claim (same invocationId + identical content) returns the existing
//     effective GovernanceDecision for that invocation when one already
//     exists, rather than silently running a fresh Permission Registry
//     evaluation. A policy change between the first call and a retry must
//     never change the retry's own answer — that would make "idempotent"
//     a lie. A deliberate re-evaluation (reusing the same invocation with
//     a materially different verdict) is out of this slice's scope
//     (tracked conceptually against SOR-164's future transaction-bound
//     authorization work, not implemented here).
//
//   - preflight() tenant identity (Human Owner correction, second
//     security re-review): the acting user's id is NEVER read from the
//     wire PreflightRequest — there is no such field on that type at all
//     (@tact/execution-contract's own header comment on PreflightRequest).
//     preflight() takes it as its own separate, trusted `userId` function
//     argument, exactly mirroring complete()'s existing `userId`
//     argument. A caller cannot choose, escalate to, or read another
//     tenant's Governance state merely by putting a different value
//     somewhere in the request body — there is nowhere on that body for
//     such a value to go.
//
//   - preflight() first-decision concurrency (Human Owner correction,
//     second security re-review): the FIRST GovernanceDecision for a
//     given invocation always uses a deterministic id derived from
//     (userId, invocationId) — see deterministicFirstDecisionId() below —
//     never a fresh random one, specifically so the already-existing,
//     already-relied-upon atomic
//     "INSERT, detect 23505, read back and compare" claim pattern
//     (identical to the one governance/store.ts's own
//     createGovernanceInvocation/appendGovernanceDecision already use,
//     and to the one this repository's every other idempotent store
//     function uses) is sufficient, BY ITSELF, to guarantee that at most
//     one first-decision row can ever be persisted for one invocation —
//     even if two callers race past the "does a decision already exist?"
//     read at the same instant. No new UNIQUE constraint and no advisory
//     lock is needed for this guarantee; it falls out of the existing
//     `tact_governance_decisions.id` primary key once the id stops being
//     random for this one specific case. The rare case where two truly
//     concurrent evaluations would have produced DIFFERENT content (e.g.
//     a registry edit landed in between the two evaluations) still
//     surfaces as the store's existing `idempotency_conflict` outcome;
//     preflight() reacts to that by re-reading the invocation's decisions
//     and returning whichever one actually won the race — it never
//     fabricates a second row, never guesses, and never reports a raw
//     conflict for what is, from the caller's perspective, a perfectly
//     valid invocation.

import { createHash } from "node:crypto";
import type {
  PreflightRequest,
  PreflightResponse,
  CompleteRequest,
  CompleteResult,
  CompleteResultStatus,
} from "@tact/execution-contract";
import {
  EXECUTION_ACTOR_KINDS,
  EXECUTION_ACTION_CATEGORIES,
  EXECUTION_PROVIDERS,
  EXECUTION_SOURCE_TYPES,
  EXECUTION_STATUSES,
  type ExecutionActorKind,
  type ExecutionActionCategory,
  type ExecutionProvider,
  type ExecutionSourceType,
  type ExecutionStatus,
  type ExecutionObservationMode,
  type CaptureExecutionInput,
} from "../types";
import { captureExecution } from "../store";
import {
  assertExecutionOutcome,
  EXECUTION_OUTCOME_STATUSES,
  EXECUTION_OUTCOME_METHODS,
  type ExecutionOutcomeStatus,
  type ExecutionOutcomeMethod,
} from "../outcome";
import { listActivePermissionRulesForMatching } from "../permission/registryStore";
import { buildGovernanceDecisionFromRegistry } from "./evaluate";
import {
  createGovernanceInvocation,
  appendGovernanceDecision,
  listGovernanceDecisionsForInvocation,
} from "./store";
import type { GovernanceInvocation, GovernanceInvocationInput, GovernanceDecision, GovernanceExecutionLink, GovernanceExecutionLinkInput } from "./types";

// =========================
// Narrow local return types for the governance store's own `Promise<any>`
// signatures (governance/store.ts's terse one-liner functions are outside
// this slice's approved change scope — CLAUDE.md A章 forbids widening
// unrelated existing `any` usage, so this file narrows at its own
// boundary instead of editing that file).
// =========================

type CreateGovernanceInvocationOutcome =
  | { status: "created"; invocation: GovernanceInvocation }
  | { status: "already_exists"; invocation: GovernanceInvocation }
  | { status: "idempotency_conflict" }
  | { status: "invalid"; errors: string[] }
  | { status: "unavailable" }
  | { status: "error"; message: string };

type AppendGovernanceDecisionOutcome =
  | { status: "created"; decision: GovernanceDecision }
  | { status: "already_exists"; decision: GovernanceDecision }
  | { status: "idempotency_conflict" }
  | { status: "invalid"; errors: string[] }
  | { status: "unavailable" }
  | { status: "error"; message: string };

type LinkInvocationExecutionOutcome =
  | { status: "created"; link: GovernanceExecutionLink }
  | { status: "already_exists"; link: GovernanceExecutionLink }
  | { status: "execution_already_linked" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

// =========================
// Preflight
// =========================

export type PreflightOutcome =
  | { status: "decided"; response: PreflightResponse }
  | { status: "invalid"; errors: string[] }
  | { status: "invocation_conflict" }
  | { status: "unavailable"; reason: string };

export interface PreflightDeps {

  createGovernanceInvocation: (input: GovernanceInvocationInput) => Promise<CreateGovernanceInvocationOutcome>;

  // Read-only lookup against Runs' own Governance store — used only to
  // detect "this exact invocation was already decided" on retry (see
  // header comment on preflight() retry semantics). Safe to default to
  // the real store function: it asserts no new trust, it only reads rows
  // already scoped to the invocation's own userId.
  listGovernanceDecisionsForInvocation: (id: string, userId: string) => Promise<GovernanceDecision[]>;

  // May throw RegistryUnavailableError (../permission/registryStore.ts) —
  // preflight() deliberately never catches it, see header comment.
  listActivePermissionRulesForMatching: typeof listActivePermissionRulesForMatching;

  appendGovernanceDecision: (input: ReturnType<typeof buildGovernanceDecisionFromRegistry>) => Promise<AppendGovernanceDecisionOutcome>;

  now: () => Date;

}

const defaultPreflightDeps: PreflightDeps = {
  createGovernanceInvocation,
  listGovernanceDecisionsForInvocation,
  listActivePermissionRulesForMatching,
  appendGovernanceDecision,
  now: () => new Date(),
};

// The identical-retry answer is "the first decision ever computed for
// this invocation", deterministically — not "the most recent", which
// would only differ from "first" if something already violated the "no
// silent re-evaluation" rule. Sorting is still explicit (never relies on
// insertion order) so a future, deliberately-distinct re-evaluation
// operation has an unambiguous existing value to compare against.
function pickEffectiveDecision(decisions: readonly GovernanceDecision[]): GovernanceDecision | undefined {
  return [...decisions].sort((a, b) => Date.parse(a.evaluatedAt) - Date.parse(b.evaluatedAt))[0];
}

// Deterministic, SHA-256-derived, formatted as a syntactically valid uuid
// (version/variant bits set so the "uuid" column type accepts it).
//
// Correction (repository-reality re-review): GovernanceInvocation.id is
// "id uuid primary key" on tact_governance_invocations — GLOBALLY
// unique, not scoped per tenant. The accompanying unique(id, user_id)
// exists only to support composite FK references from
// tact_governance_decisions / tact_governance_invocation_execution_links;
// it does not relax id's own global uniqueness, and the same
// invocationId string can never belong to two different tenants as two
// separate rows (a second tenant's attempt to claim an already-existing
// id fails closed — see createGovernanceInvocation()'s duplicate-PK
// recovery in governance/store.ts, which cannot read back a row owned by
// a different user_id). Including userId in this hash is therefore NOT
// required for cross-tenant collision-safety (invocation.id alone
// already guarantees that structurally) — it is deliberate, explicit
// domain separation / tenant binding for the decision id namespace, kept
// as defense-in-depth rather than as a correctness necessity.
function deterministicFirstDecisionId(userId: string, invocationId: string): string {

  const digest = createHash("sha256").update(`${userId}\u001fgovernance-decision\u001f${invocationId}`, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

}

function toPreflightResponse(decision: GovernanceDecision): PreflightResponse {
  return {
    decisionId: decision.id,
    invocationId: decision.invocationId,
    verdict: decision.verdict,
    reasonCode: decision.reasonCode,
    evaluatorVersion: decision.evaluatorVersion,
    policyVersion: decision.policySetFingerprint,
    matchedRuleIdentifier: decision.policyIdentifierSnapshot,
    approval: { approvalId: decision.approvalId, status: decision.approvalStatus },
  };
}

function requireClosedField<T extends string>(
  errors: string[],
  fieldName: string,
  value: string | null | undefined,
  allowed: readonly T[]
): T | null {

  if (value === null || value === undefined || value.length === 0) {
    errors.push(`${fieldName} is required`);
    return null;
  }

  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }

  errors.push(`${fieldName} must be one of ${allowed.join(", ")}`);
  return null;

}

function optionalClosedField<T extends string>(
  errors: string[],
  fieldName: string,
  value: string | null | undefined,
  allowed: readonly T[]
): T | null {

  if (value === null || value === undefined) {
    return null;
  }

  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }

  errors.push(`${fieldName} must be one of ${allowed.join(", ")} or omitted`);
  return null;

}

function toGovernanceInvocationInput(
  request: PreflightRequest,
  trustedUserId: string
): { ok: true; input: GovernanceInvocationInput } | { ok: false; errors: string[] } {

  const errors: string[] = [];

  const actorKind = requireClosedField(errors, "actorKind", request.actorKind, EXECUTION_ACTOR_KINDS);
  const actionCategory = requireClosedField(errors, "actionCategory", request.actionCategory, EXECUTION_ACTION_CATEGORIES);
  const onBehalfOfActorKind = optionalClosedField(errors, "onBehalfOfActorKind", request.onBehalfOfActorKind, EXECUTION_ACTOR_KINDS);
  const targetProvider = optionalClosedField(errors, "targetProvider", request.targetProvider, EXECUTION_PROVIDERS);

  if (!request.invocationId) errors.push("invocationId is required");
  if (!trustedUserId) errors.push("a trusted userId argument is required");
  if (!request.operation) errors.push("operation is required");
  if (!request.attemptedAt) errors.push("attemptedAt is required");

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    input: {
      id: request.invocationId,
      // Trusted argument only — see this file's header comment on
      // "preflight() tenant identity". `request` itself has no userId
      // field to read even by mistake.
      userId: trustedUserId,
      organizationId: request.organizationId ?? null,
      workspaceId: request.workspaceId ?? null,
      workId: request.workId ?? null,
      connectionId: request.connectionId ?? null,
      actorKind: actorKind as ExecutionActorKind,
      actorId: request.actorId ?? null,
      agentId: request.agentId ?? null,
      onBehalfOfActorKind,
      onBehalfOfActorId: request.onBehalfOfActorId ?? null,
      actionCategory: actionCategory as ExecutionActionCategory,
      operation: request.operation,
      resourceType: request.resourceType ?? null,
      resourceIdentifier: request.resourceIdentifier ?? null,
      targetProvider,
      attemptedAt: request.attemptedAt,
    },
  };

}

export async function preflight(
  request: PreflightRequest,
  userId: string,
  deps: PreflightDeps = defaultPreflightDeps
): Promise<PreflightOutcome> {

  const mapped = toGovernanceInvocationInput(request, userId);

  if (!mapped.ok) {
    return { status: "invalid", errors: mapped.errors };
  }

  const invocationOutcome = await deps.createGovernanceInvocation(mapped.input);

  if (invocationOutcome.status === "invalid") {
    return { status: "invalid", errors: invocationOutcome.errors };
  }

  if (invocationOutcome.status === "idempotency_conflict") {
    return { status: "invocation_conflict" };
  }

  if (invocationOutcome.status === "unavailable" || invocationOutcome.status === "error") {
    return {
      status: "unavailable",
      reason: invocationOutcome.status === "error" ? invocationOutcome.message : "governance invocation store unavailable",
    };
  }

  const invocation: GovernanceInvocation = invocationOutcome.invocation;

  // Retry semantics (see header comment, Human Owner correction): an
  // identical resubmission of an invocation that was already claimed and
  // already decided must return that SAME decision, never a fresh
  // evaluation against whatever the Permission Registry looks like right
  // now. A policy change between the original call and a retry must never
  // change the retry's own answer.
  if (invocationOutcome.status === "already_exists") {

    const existingDecisions = await deps.listGovernanceDecisionsForInvocation(invocation.id, invocation.userId);
    const effective = pickEffectiveDecision(existingDecisions);

    if (effective) {
      return { status: "decided", response: toPreflightResponse(effective) };
    }

    // No decision was ever persisted for this invocation yet. This is
    // either (a) recovery of a never-completed first evaluation (a prior
    // call's process died between claiming the invocation and appending
    // its decision), or (b) the losing side of a genuine concurrent race
    // against another call that is *also* about to evaluate right now —
    // both fall through to the same evaluate-and-claim step below, which
    // is safe precisely because the claim that follows is deterministic
    // (see header comment on "first-decision concurrency").

  }

  // Absolute condition (see header comment): never caught here. A thrown
  // RegistryUnavailableError must reach the caller as a rejected promise,
  // never as a resolved UNKNOWN/ALLOW outcome.
  const rules = await deps.listActivePermissionRulesForMatching(invocation.userId);

  // Deterministic, not random (see header comment on "first-decision
  // concurrency" and deterministicFirstDecisionId()'s own comment): the
  // FIRST decision attempt's id turns the already-existing PRIMARY KEY on
  // tact_governance_decisions into the sole concurrency-safety mechanism
  // this needs — no new UNIQUE constraint, no advisory lock, no
  // migration. Two callers racing past the "no decision yet" check above
  // will attempt to insert the exact same row id; at most one of those
  // inserts can ever land.
  const decisionId = deterministicFirstDecisionId(invocation.userId, invocation.id);
  const decisionInput = buildGovernanceDecisionFromRegistry(invocation, decisionId, rules, deps.now());

  const decisionOutcome = await deps.appendGovernanceDecision(decisionInput);

  if (decisionOutcome.status === "invalid") {
    return { status: "invalid", errors: decisionOutcome.errors };
  }

  if (decisionOutcome.status === "idempotency_conflict") {

    // Lost a genuine race: another call's evaluation landed first with
    // DIFFERENT content for the same deterministic id (the only way this
    // specific store call can report a conflict here — see header
    // comment). The invocation itself is perfectly valid; re-read
    // whichever decision actually won and hand that back, exactly as the
    // sequential-retry path above already does. Never fabricate a second
    // row, never silently pick "the earliest" among rows this call
    // itself persisted (only the other call's single winning row can
    // exist here), and never surface a raw conflict for what is, from
    // this caller's perspective, a normal successful Preflight.
    const racedDecisions = await deps.listGovernanceDecisionsForInvocation(invocation.id, invocation.userId);
    const winner = pickEffectiveDecision(racedDecisions);

    if (winner) {
      return { status: "decided", response: toPreflightResponse(winner) };
    }

    // Structurally unreachable (an idempotency_conflict on this
    // deterministic id means a row with that id already exists for this
    // invocation), but never guess if the store ever disagrees with
    // itself between these two calls.
    return { status: "unavailable", reason: "governance decision race could not be resolved" };

  }

  if (decisionOutcome.status === "unavailable" || decisionOutcome.status === "error") {
    return {
      status: "unavailable",
      reason: decisionOutcome.status === "error" ? decisionOutcome.message : "governance decision store unavailable",
    };
  }

  return { status: "decided", response: toPreflightResponse(decisionOutcome.decision) };

}

// =========================
// Complete
// =========================

export interface CompleteDeps {

  getGovernanceInvocation: (id: string, userId: string) => Promise<GovernanceInvocation | undefined>;

  listGovernanceDecisionsForInvocation: (id: string, userId: string) => Promise<GovernanceDecision[]>;

  // Trust boundary (see header comment, Human Owner correction): there is
  // NO default for this field and NO default for `CompleteDeps` as a
  // whole — a caller of complete() must explicitly construct and supply
  // its own trusted `capture`. complete() itself grants no trust; it only
  // decides whether the supplied trustedDeps' own capture result may be
  // linked to an existing, already-decided Governance Invocation/Decision
  // owned by this same userId.
  capture: typeof captureExecution;

  linkInvocationExecution: (input: GovernanceExecutionLinkInput) => Promise<LinkInvocationExecutionOutcome>;

  assertExecutionOutcome: typeof assertExecutionOutcome;

  // Observation provenance the TRUSTED adapter can truthfully assert
  // about THIS specific completion call (see header comment). Omitted
  // (the default applied inside complete(), never a module-level
  // default) means "not known" — observationMode stays null and
  // preExecutionVisible stays false, the same honest default every other
  // adapter already uses. Never derived from "a Preflight happened".
  observationProvenance?: {
    observationMode: ExecutionObservationMode | null;
    preExecutionVisible: boolean;
  };

}

export async function complete(
  request: CompleteRequest,
  userId: string,
  trustedDeps: CompleteDeps
): Promise<CompleteResult> {

  const invocation = await trustedDeps.getGovernanceInvocation(request.invocationId, userId);

  if (!invocation) {
    return { status: "invocation_not_found" };
  }

  const decisions = await trustedDeps.listGovernanceDecisionsForInvocation(request.invocationId, userId);
  const decision = decisions.find((candidate) => candidate.id === request.decisionId);

  if (!decision) {
    return { status: "decision_not_found" };
  }

  const errors: string[] = [];

  const provider = requireClosedField(errors, "execution.provider", request.execution.provider, EXECUTION_PROVIDERS);
  const sourceType = requireClosedField(errors, "execution.sourceType", request.execution.sourceType, EXECUTION_SOURCE_TYPES);
  const status = optionalClosedField(errors, "execution.status", request.execution.status, EXECUTION_STATUSES);

  if (!request.execution.externalEventId) errors.push("execution.externalEventId is required");
  if (!request.execution.adapterVersion) errors.push("execution.adapterVersion is required");

  let outcomeStatus: ExecutionOutcomeStatus | null = null;
  let outcomeMethod: ExecutionOutcomeMethod | null = null;

  if (request.outcome) {
    outcomeStatus = requireClosedField(errors, "outcome.status", request.outcome.status, EXECUTION_OUTCOME_STATUSES);
    outcomeMethod = request.outcome.method
      ? optionalClosedField(errors, "outcome.method", request.outcome.method, EXECUTION_OUTCOME_METHODS)
      : "adapter_asserted";
  }

  if (errors.length > 0) {
    return { status: "invalid", reason: errors.join("; ") };
  }

  // The Governance Invocation's own snapshot is the attempted action;
  // execution evidence only supplies *observed* provenance (provider /
  // sourceType / externalEventId / adapterVersion / status / error) —
  // captureExecution() is never asked to re-decide what was attempted,
  // only to record what happened.
  const captureInput: CaptureExecutionInput = {
    userId: invocation.userId,
    organizationId: invocation.organizationId,
    workspaceId: invocation.workspaceId,
    workId: invocation.workId,
    connectionId: invocation.connectionId,
    actorKind: invocation.actorKind,
    actorId: invocation.actorId,
    agentId: invocation.agentId,
    onBehalfOfActorKind: invocation.onBehalfOfActorKind,
    onBehalfOfActorId: invocation.onBehalfOfActorId,
    provider: provider as ExecutionProvider,
    sourceType: sourceType as ExecutionSourceType,
    externalEventId: request.execution.externalEventId,
    adapterVersion: request.execution.adapterVersion,
    // SOR-45 fields (../types.ts): deliberately NOT inferred from "a
    // Governance Decision/Invocation existed for this attempt" — that
    // fact is already fully represented by GovernanceExecutionLink below
    // and must not also be smuggled into CanonicalExecution's own
    // observation columns (Human Owner correction). Only a trusted
    // adapter that can truthfully prove it was on the dispatch path may
    // override these; the default is the same "not known" null/false
    // every other adapter already uses.
    observationMode: trustedDeps.observationProvenance?.observationMode ?? null,
    preExecutionVisible: trustedDeps.observationProvenance?.preExecutionVisible ?? false,
    actionCategory: invocation.actionCategory,
    operation: invocation.operation,
    resourceType: request.execution.resourceType ?? invocation.resourceType,
    resourceIdentifier: request.execution.resourceIdentifier ?? invocation.resourceIdentifier,
    targetProvider: invocation.targetProvider,
    ...(status ? { status: status as ExecutionStatus } : {}),
    errorCode: request.execution.errorCode ?? null,
    errorMessage: request.execution.errorMessage ?? null,
    providerOccurredAt: request.execution.providerOccurredAt ?? null,
  };

  const captureOutcome = await trustedDeps.capture(captureInput);

  if (captureOutcome.status === "invalid") {
    return { status: "invalid", reason: captureOutcome.errors.join("; ") };
  }

  if (captureOutcome.status === "unavailable") {
    return { status: "unavailable" };
  }

  if (captureOutcome.status === "error") {
    return { status: "error", reason: captureOutcome.message };
  }

  const execution = captureOutcome.execution;

  const linkOutcome = await trustedDeps.linkInvocationExecution({
    userId,
    invocationId: invocation.id,
    effectiveGovernanceDecisionId: decision.id,
    executionId: execution.id,
  });

  if (linkOutcome.status === "unavailable") {
    return { status: "unavailable", executionId: execution.id };
  }

  if (linkOutcome.status === "error") {
    return { status: "error", reason: linkOutcome.message, executionId: execution.id };
  }

  if (linkOutcome.status === "execution_already_linked") {
    return { status: "link_conflict", executionId: execution.id };
  }

  const governanceExecutionLinkId = linkOutcome.link.id;
  let outcomeRecorded = false;

  if (request.outcome && outcomeStatus) {

    const outcomeOutcome = await trustedDeps.assertExecutionOutcome(
      {
        executionId: execution.id,
        status: outcomeStatus,
        outcomeKind: request.outcome.outcomeKind ?? null,
        summary: request.outcome.summary ?? null,
        method: outcomeMethod ?? "adapter_asserted",
      },
      userId
    );

    outcomeRecorded = outcomeOutcome.status === "persisted";

  }

  const resultStatus: CompleteResultStatus = linkOutcome.status === "created" ? "linked" : "already_linked";

  return {
    status: resultStatus,
    executionId: execution.id,
    governanceExecutionLinkId,
    outcomeRecorded,
  };

}
