// =========================
// Standalone Runs — Governance Complete HTTP Route (SOR-138 Slice 3A-1)
// =========================
//
// Transport/authentication foundation ONLY. No live caller is wired to
// this route yet (SOR-138 Slice 3A-2's job). This route's only job is to
// turn an authenticated, signed GovernanceCompleteEnvelope into a call to
// the already-landed Core complete() (packages/runs-core/tact-execution/
// governance/contract.ts, SOR-138 Slice 1) — it does not reimplement
// Canonical Execution capture or outcome logic itself.
//
// Trust/provenance injection (Human Owner decision, SOR-138 Slice 3 design
// audit "COMPLETE ROUTE" / "OBSERVATION PROVENANCE"): complete()'s
// `trustedDeps` parameter has NO default (see contract.ts's own header
// comment — "complete(request, userId) alone does not compile") precisely
// so that whoever calls it must explicitly decide what it may truthfully
// assert about observation provenance. For this one specific caller (the
// direct, synchronous Yolna governance client this slice's transport
// serves — see core/tact-integration/runsGovernance.ts), this route is the
// trusted boundary that decides:
//
//     observationMode: "inline"
//     preExecutionVisible: false
//
// "inline" because Yolna calls Composio and reports the result through
// this same signed boundary immediately, with no telemetry round-trip or
// SaaS audit-log reconciliation in between. preExecutionVisible stays
// false regardless — Preflight renders a verdict BEFORE execution, it does
// not observe it; Canonical Execution capture still only happens here,
// after the fact, exactly like every other adapter. These two values are
// injected by this route itself, server-side, and are never read from the
// wire CompleteRequest (which has no such fields at all).

import { NextRequest, NextResponse } from "next/server";
import {
  complete,
  getGovernanceInvocation,
  listGovernanceDecisionsForInvocation,
  linkInvocationExecution,
  captureExecution,
  assertExecutionOutcome,
  resolveOrCreateExternalPrincipal,
  type CompleteDeps,
  type ResolveOrCreateExternalPrincipalOutcome,
} from "@tact/runs-core/tact-execution";
import type { CompleteRequest, GovernanceCompleteEnvelope } from "@tact/execution-contract";
import { verifyGovernanceSignedRequest, exceedsDeclaredContentLength } from "@/lib/governance/runsGovernanceAuth";

export interface GovernanceCompleteRouteDeps {
  verify: typeof verifyGovernanceSignedRequest;
  // SOR-260 Phase 1: resolves/creates the external Principal from
  // (auth.callerId, envelope.onBehalfOfUserId) AFTER authentication
  // succeeds and BEFORE complete() ever sees an identity — same
  // resolution path and same claim boundary as the Preflight route (see
  // that route's own header comment). complete() now receives the
  // resolved principal.id, never the raw onBehalfOfUserId directly.
  resolvePrincipal: typeof resolveOrCreateExternalPrincipal;
  complete: typeof complete;
  // Factory, not a plain object: production wiring must construct a fresh
  // CompleteDeps per call (mirrors complete()'s own "no module-level
  // default production deps" rule, see contract.ts) — a test overrides
  // this factory to inject fakes for capture/link/assertExecutionOutcome
  // while still exercising the real observationProvenance injection below.
  buildTrustedDeps: () => CompleteDeps;
}

// Exported so this route's own tests can prove the DEFAULT production
// factory injects observationMode=inline/preExecutionVisible=false,
// instead of only proving that *some* injected factory can (dependency
// injection correctness alone would not demonstrate that).
export function buildDefaultTrustedDeps(): CompleteDeps {
  return {
    getGovernanceInvocation,
    listGovernanceDecisionsForInvocation,
    capture: captureExecution,
    linkInvocationExecution,
    assertExecutionOutcome,
    observationProvenance: { observationMode: "inline", preExecutionVisible: false },
  };
}

const defaultDeps: GovernanceCompleteRouteDeps = {
  verify: verifyGovernanceSignedRequest,
  resolvePrincipal: resolveOrCreateExternalPrincipal,
  complete,
  buildTrustedDeps: buildDefaultTrustedDeps,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Minimal structural check only — complete() itself validates
// envelope.request's fields (execution.provider/sourceType/etc. vocabulary,
// required fields) and returns a typed "invalid" CompleteResult for that.
function isValidEnvelopeShape(value: unknown): value is GovernanceCompleteEnvelope {
  if (!isPlainObject(value)) return false;
  if (typeof value.onBehalfOfUserId !== "string" || value.onBehalfOfUserId.length === 0) return false;
  if (!isPlainObject(value.request)) return false;
  return true;
}

function errorResponse(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status });
}

export async function handleGovernanceCompleteRequest(
  request: NextRequest,
  deps: GovernanceCompleteRouteDeps = defaultDeps
): Promise<NextResponse> {

  // Cheap pre-read defense — see the matching comment in the Preflight
  // route. Advisory only; the authoritative check runs inside
  // deps.verify() against the actual bytes read.
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

  // SOR-260 Phase 1: same resolution path as the Preflight route — see
  // that route's header comment for the full rationale. complete() below
  // never receives the raw envelope.onBehalfOfUserId as a trusted
  // user_id again past this point, only principalOutcome.principal.id.
  const principalOutcome: ResolveOrCreateExternalPrincipalOutcome = await deps.resolvePrincipal(
    auth.callerId,
    envelope.onBehalfOfUserId
  );

  if (principalOutcome.status === "invalid") {
    return errorResponse(400, "invalid_principal");
  }

  if (principalOutcome.status === "unavailable") {
    return errorResponse(503, "governance_unavailable");
  }

  const result = await deps.complete(
    envelope.request as CompleteRequest,
    principalOutcome.principal.id,
    deps.buildTrustedDeps()
  );

  switch (result.status) {
    case "linked":
    case "already_linked":
      return NextResponse.json({ success: true, result }, { status: 200 });
    case "link_conflict":
      return NextResponse.json({ success: true, result }, { status: 409 });
    case "invocation_not_found":
    case "decision_not_found":
      return NextResponse.json({ success: true, result }, { status: 404 });
    case "invalid":
      return NextResponse.json({ success: true, result }, { status: 400 });
    case "unavailable":
    case "error":
      return errorResponse(503, "governance_unavailable");
    default: {
      // CompleteResult is a single flat interface (status: CompleteResultStatus),
      // not a discriminated union of distinct object shapes — switching on
      // result.status narrows that field's own type, not result's overall
      // type, so the exhaustiveness check below assigns the narrowed
      // *status* value (which the switch above has proven exhausts
      // CompleteResultStatus), not the whole `result` object.
      const exhaustive: never = result.status;
      void exhaustive;
      return errorResponse(503, "governance_unavailable");
    }
  }

}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleGovernanceCompleteRequest(request);
}
