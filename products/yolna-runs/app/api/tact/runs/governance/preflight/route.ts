// =========================
// Standalone Runs — Governance Preflight HTTP Route (SOR-138 Slice 3A-1)
// =========================
//
// Transport/authentication foundation ONLY. No live caller is wired to
// this route yet (SOR-138 Slice 3A-2's job). This route's only job is to
// turn an authenticated, signed GovernancePreflightEnvelope into a call to
// the already-landed Core preflight() (packages/runs-core/tact-execution/
// governance/contract.ts, SOR-138 Slice 1/2A) — it does not reimplement
// any governance decision logic itself.
//
// Sequence (absolute order, do not reorder): read the bounded raw body ->
// verify the governance HMAC over those exact bytes -> only then parse
// JSON -> validate the envelope shape -> resolve/create the external
// Principal from (auth.callerId, envelope.onBehalfOfUserId) -> call
// preflight(envelope.request, principal.id). The trusted subject id is
// NEVER read from envelope.request (that type has no such field at all —
// see @tact/execution-contract's own header comment), and principal
// resolution is NEVER attempted before verifyGovernanceSignedRequest
// succeeds (SOR-260 Human Owner decision 9).
//
// SOR-260 Phase 1: Core (preflight()) now receives the RESOLVED
// principal.id, never the raw caller-asserted onBehalfOfUserId directly —
// this is the one thing that changed about this route's own sequence.
// auth.callerId (the registered deployment's stable logical namespace,
// e.g. "yolna-root-staging" — distinct from auth.keyId, the rotatable
// credential used only to select the HMAC verification key) becomes the
// Principal's namespace; envelope.onBehalfOfUserId becomes its
// externalSubjectId. Principal resolution proves only that an
// authenticated source asserted a subject identifier within its own
// namespace — it does NOT independently prove that subject exists in the
// source product (design audit §12; preserve this exact claim boundary).
//
// HTTP mapping (Human Owner pre-commit review, SOR-138 Slice 3A-1, extended
// SOR-260 Phase 1):
//   decided              -> 200
//   invalid              -> 400 (request-level OR principal-input-level)
//   invocation_conflict  -> 409 (deterministic idempotency/caller conflict,
//                           same invocationId claimed with different
//                           content — never retryable, never a decision)
//   unavailable          -> 503 (store/registry unavailable — retryable)
//   auth failure (client) -> 401
//   auth config failure (server) -> 503

import { NextRequest, NextResponse } from "next/server";
import {
  preflight,
  resolveOrCreateExternalPrincipal,
  type PreflightOutcome,
  type ResolveOrCreateExternalPrincipalOutcome,
} from "@tact/runs-core/tact-execution";
import type { GovernancePreflightEnvelope, PreflightRequest } from "@tact/execution-contract";
import { verifyGovernanceSignedRequest, exceedsDeclaredContentLength } from "@/lib/governance/runsGovernanceAuth";

export interface GovernancePreflightRouteDeps {
  verify: typeof verifyGovernanceSignedRequest;
  resolvePrincipal: typeof resolveOrCreateExternalPrincipal;
  preflight: typeof preflight;
}

const defaultDeps: GovernancePreflightRouteDeps = {
  verify: verifyGovernanceSignedRequest,
  resolvePrincipal: resolveOrCreateExternalPrincipal,
  preflight,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Minimal structural check only — preflight() itself (via
// toGovernanceInvocationInput) owns full field-level validation of
// envelope.request (actorKind/actionCategory vocabulary, required fields,
// etc.) and returns a typed "invalid" outcome for that. This function only
// confirms the envelope has the two top-level fields this route itself
// reads before handing off to Core, so a malformed body fails with a
// generic 400 rather than a thrown exception.
function isValidEnvelopeShape(value: unknown): value is GovernancePreflightEnvelope {
  if (!isPlainObject(value)) return false;
  if (typeof value.onBehalfOfUserId !== "string" || value.onBehalfOfUserId.length === 0) return false;
  if (!isPlainObject(value.request)) return false;
  return true;
}

function errorResponse(status: number, error: string, details?: string[]) {
  return NextResponse.json({ success: false, error, ...(details ? { details } : {}) }, { status });
}

export async function handleGovernancePreflightRequest(
  request: NextRequest,
  deps: GovernancePreflightRouteDeps = defaultDeps
): Promise<NextResponse> {

  // Cheap pre-read defense: reject before ever buffering the body if the
  // client declared an oversized Content-Length. Advisory only — a
  // declared length can be absent or untrustworthy, so the authoritative
  // check against the actual read bytes still runs unconditionally inside
  // deps.verify() below.
  if (exceedsDeclaredContentLength(request)) {
    return errorResponse(401, "unauthorized");
  }

  const rawBody = Buffer.from(await request.arrayBuffer());

  const auth = deps.verify(request, rawBody);
  if (!auth.ok) {
    return auth.kind === "server"
      ? errorResponse(503, "governance_unavailable")
      : errorResponse(401, "unauthorized");
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody.toString("utf-8"));
  } catch {
    return errorResponse(400, "malformed_json");
  }

  if (!isValidEnvelopeShape(parsedBody)) {
    return errorResponse(400, "invalid_envelope");
  }

  const envelope = parsedBody;

  // SOR-260 Phase 1: resolve/create the external Principal AFTER
  // authentication succeeds and BEFORE Core ever sees an identity. This
  // call never receives a raw envelope.onBehalfOfUserId as a trusted
  // user_id again past this point — only principalOutcome.principal.id
  // does, below.
  const principalOutcome: ResolveOrCreateExternalPrincipalOutcome = await deps.resolvePrincipal(
    auth.callerId,
    envelope.onBehalfOfUserId
  );

  if (principalOutcome.status === "invalid") {
    return errorResponse(400, "invalid_principal", principalOutcome.errors);
  }

  if (principalOutcome.status === "unavailable") {
    return errorResponse(503, "governance_unavailable");
  }

  const outcome: PreflightOutcome = await deps.preflight(
    envelope.request as PreflightRequest,
    principalOutcome.principal.id
  );

  if (outcome.status === "decided") {
    return NextResponse.json({ success: true, decision: outcome.response }, { status: 200 });
  }

  if (outcome.status === "invalid") {
    return errorResponse(400, "invalid_request", outcome.errors);
  }

  // invocation_conflict means "this exact invocationId was already claimed
  // with DIFFERENT content" — a deterministic idempotency/caller conflict,
  // not an outage. Retrying the identical bad request can never repair it,
  // so it gets its own status, distinct from the retryable 503 below (Human
  // Owner correction, SOR-138 Slice 3A-1 pre-commit review).
  if (outcome.status === "invocation_conflict") {
    return errorResponse(409, "invocation_conflict");
  }

  // Only "unavailable" remains here (governance decision/invocation store
  // unavailable, or an unexpected store error) — a genuinely retryable
  // condition, unlike invocation_conflict above.
  return errorResponse(503, "governance_unavailable");

}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleGovernancePreflightRequest(request);
}
