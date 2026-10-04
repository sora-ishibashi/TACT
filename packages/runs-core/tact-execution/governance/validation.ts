import { findSuspiciousExecutionMetadataKeys } from "../validation";
import { EXECUTION_ACTOR_KINDS, EXECUTION_ACTION_CATEGORIES, EXECUTION_PROVIDERS } from "../types";
import { GOVERNANCE_DECISION_VERDICTS, type GovernanceDecisionInput, type GovernanceInvocationInput, type GovernanceApprovalRequestInput, type GovernanceApprovalResolver } from "./types";
const timestamp = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
export function validateGovernanceInvocationInput(input: GovernanceInvocationInput): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!text(input.id, 255) || !text(input.userId, 255)) errors.push("id and userId are required");
  if (!EXECUTION_ACTOR_KINDS.includes(input.actorKind)) errors.push("invalid actorKind");
  if (input.onBehalfOfActorKind && !EXECUTION_ACTOR_KINDS.includes(input.onBehalfOfActorKind)) errors.push("invalid onBehalfOfActorKind");
  if (!EXECUTION_ACTION_CATEGORIES.includes(input.actionCategory)) errors.push("invalid actionCategory");
  if (!text(input.operation, 255)) errors.push("operation is required");
  if (input.targetProvider && !EXECUTION_PROVIDERS.includes(input.targetProvider)) errors.push("invalid targetProvider");
  if (!timestamp(input.attemptedAt)) errors.push("attemptedAt must be an ISO timestamp with an explicit timezone offset");
  return errors.length ? { ok: false, errors } : { ok: true };
}
export function validateGovernanceDecisionInput(input: GovernanceDecisionInput): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!text(input.id, 255) || !text(input.userId, 255) || !text(input.invocationId, 255)) errors.push("id, userId and invocationId are required");
  if (!GOVERNANCE_DECISION_VERDICTS.includes(input.verdict)) errors.push("invalid verdict");
  if (!text(input.reasonCode, 255) || !text(input.evaluatorVersion, 100)) errors.push("reasonCode and evaluatorVersion are required");
  if (input.decisionSource !== "runs_permission_registry" || input.trustLevelSnapshot !== "INTERNAL") errors.push("untruthful decision provenance");
  if (!/^[a-f0-9]{64}$/.test(input.policySetFingerprint)) errors.push("policySetFingerprint must be a SHA-256 hex digest");
  if (!timestamp(input.evaluatedAt)) errors.push("evaluatedAt must be an ISO timestamp with an explicit timezone offset");
  if (JSON.stringify(input.runsPermissionSnapshot).length > 4096) errors.push("runsPermissionSnapshot must serialize to at most 4096 characters");
  const suspicious = findSuspiciousExecutionMetadataKeys(input.runsPermissionSnapshot);
  if (suspicious.length) errors.push(`runsPermissionSnapshot contains suspicious keys: ${suspicious.join(", ")}`);
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateGovernanceApprovalRequestInput(input: GovernanceApprovalRequestInput): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!text(input.userId, 255)) errors.push("userId is required");
  if (!text(input.governanceDecisionId, 255)) errors.push("governanceDecisionId is required");
  return errors.length ? { ok: false, errors } : { ok: true };
}

// Human-only resolver (SOR-138 Slice 2A, Human Owner correction 1):
// GovernanceApprovalRequest is a HUMAN approval record — approved/rejected
// with any other ExecutionActorKind (ai_agent/service/connector/system),
// or with an unknown/empty/whitespace-only actorId, is rejected BEFORE any
// write is attempted. This is one of three enforcement layers (the others:
// GovernanceApprovalResolver's type itself only has the "human" literal to
// offer, and the Slice 2A migration's CHECK constraint at the DB layer) —
// this function is the one that actually runs at the application boundary,
// so it must not silently accept anything the type signature alone would
// reject only by convention.
//
// Takes an untyped `{ actorKind, actorId }`-shaped value rather than
// `GovernanceApprovalResolver` itself: the whole point is to validate
// values a caller claims are a GovernanceApprovalResolver before trusting
// that claim (e.g. anything arriving across a boundary where TypeScript's
// own compile-time guarantee no longer applies), so the parameter type
// must not already assume what this function exists to prove.
export function validateGovernanceApprovalResolver(
  candidate: { actorKind?: string | null; actorId?: string | null } | null | undefined
): { ok: true; resolver: GovernanceApprovalResolver } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (candidate?.actorKind !== "human") {
    errors.push(
      candidate?.actorKind && EXECUTION_ACTOR_KINDS.includes(candidate.actorKind as (typeof EXECUTION_ACTOR_KINDS)[number])
        ? `resolvedByActorKind must be "human" — "${candidate.actorKind}" cannot resolve a GovernanceApprovalRequest`
        : "resolvedByActorKind is required and must be \"human\""
    );
  }

  const actorId = typeof candidate?.actorId === "string" ? candidate.actorId.trim() : "";
  if (actorId.length === 0 || actorId.length > 255) {
    errors.push("resolvedByActorId is required and must not be empty or whitespace-only");
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, resolver: { actorKind: "human", actorId } };
}
