// =========================
// Yolna Runs Standalone — Governance Preflight Route Regression (SOR-138 Slice 3A-1, SOR-260 Phase 1)
// =========================
//
// Exercises the real exported handleGovernancePreflightRequest() directly
// against constructed Request objects. preflight() and
// resolveOrCreateExternalPrincipal() are both injected as fakes (their own
// behavior is covered by tests/tact/execution/governance/contract.test.ts
// and tests/tact/execution/principal/principalStore.test.ts at the repo
// root respectively) — this file only proves the ROUTE correctly sequences
// auth -> parse -> validate -> principal resolution -> trusted-argument-
// passing -> HTTP status mapping. Two tests (unsigned body, tampered
// onBehalfOfUserId) use the REAL verifyGovernanceSignedRequest instead of a
// fake, specifically to prove the transport boundary itself — not just this
// route's own logic — rejects those cases.
//
// SOR-260 Phase 1: preflight() now receives the RESOLVED principal.id, not
// the raw signed onBehalfOfUserId directly. Every test below that reaches
// preflight() asserts this explicitly (see resolvedPrincipalId()) so a
// regression that silently reverts to passing onBehalfOfUserId straight
// through would fail loudly here, not just in production against a real
// tact_runs_principals FK.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import {
  buildGovernanceSignatureCanonicalString,
  GOVERNANCE_HEADER_CALLER_ID,
  GOVERNANCE_HEADER_CONTENT_SHA256,
  GOVERNANCE_HEADER_KEY_ID,
  GOVERNANCE_HEADER_SIGNATURE,
  GOVERNANCE_HEADER_TIMESTAMP,
  type GovernancePreflightEnvelope,
} from "@tact/execution-contract";
import {
  handleGovernancePreflightRequest,
  type GovernancePreflightRouteDeps,
} from "../app/api/tact/runs/governance/preflight/route";
import { verifyGovernanceSignedRequest, type GovernanceAuthResult } from "../lib/governance/runsGovernanceAuth";
import type { PreflightOutcome, ResolveOrCreateExternalPrincipalOutcome } from "@tact/runs-core/tact-execution";

const checks: string[] = [];
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); };

const PATHNAME = "/api/tact/runs/governance/preflight";
const CALLER_ID = "yolna-root";
const KEY_ID = "k1";
const KEY = Buffer.alloc(32, 9);

// Fixed instant used for every signed-request test below, including the
// three that exercise the REAL verifyGovernanceSignedRequest (tests [3],
// [4], [10]) rather than a faked auth result — those three wrap it with
// this fixed `now` so the signed timestamp is always inside the freshness
// window regardless of how long this suite takes to actually run.
const FIXED_NOW = new Date("2026-10-05T00:00:00.000Z");
const FIXED_TIMESTAMP = Math.floor(FIXED_NOW.getTime() / 1000).toString();
const verifyWithFixedNow: typeof verifyGovernanceSignedRequest = (request, rawBody) =>
  verifyGovernanceSignedRequest(request, rawBody, FIXED_NOW);

function sign(body: Buffer, timestamp: string, overrides: Partial<{ callerId: string; keyId: string; key: Buffer }> = {}): Record<string, string> {
  const callerId = overrides.callerId ?? CALLER_ID;
  const keyId = overrides.keyId ?? KEY_ID;
  const key = overrides.key ?? KEY;
  const bodySha256Hex = createHash("sha256").update(body).digest("hex");
  const canonical = buildGovernanceSignatureCanonicalString({ method: "POST", pathname: PATHNAME, callerId, keyId, timestamp, bodySha256Hex });
  const signature = createHmac("sha256", key).update(canonical, "utf8").digest("hex");
  return {
    [GOVERNANCE_HEADER_CALLER_ID]: callerId,
    [GOVERNANCE_HEADER_KEY_ID]: keyId,
    [GOVERNANCE_HEADER_TIMESTAMP]: timestamp,
    [GOVERNANCE_HEADER_CONTENT_SHA256]: bodySha256Hex,
    [GOVERNANCE_HEADER_SIGNATURE]: signature,
    "content-type": "application/json",
  };
}

function makeRequest(body: Buffer, headers: Record<string, string>): NextRequest {
  // NextRequest's BodyInit type does not structurally accept a Node Buffer
  // directly; a UTF-8 string round-trips through request.arrayBuffer() on
  // the server side to the identical bytes, which is all this test's
  // byte-exact signature verification actually depends on.
  return new NextRequest(`https://runs.internal.test${PATHNAME}`, { method: "POST", headers, body: body.toString("utf-8") });
}

const ALWAYS_OK_AUTH: GovernanceAuthResult = { ok: true, callerId: CALLER_ID, keyId: KEY_ID };

function makeEnvelope(onBehalfOfUserId = "user-a"): GovernancePreflightEnvelope {
  return {
    onBehalfOfUserId,
    request: {
      invocationId: "inv-1",
      actorKind: "ai_agent",
      actionCategory: "read",
      operation: "slack.list_channels",
      targetProvider: "slack",
      attemptedAt: "2026-10-05T00:00:00.000Z",
    },
  };
}

interface SpyPreflight {
  calls: Array<{ request: unknown; userId: string }>;
  outcome: PreflightOutcome;
}

function makeFakePreflight(outcome: PreflightOutcome): { fn: typeof import("@tact/runs-core/tact-execution").preflight; spy: SpyPreflight } {
  const spy: SpyPreflight = { calls: [], outcome };
  const fn = (async (request: unknown, userId: string) => {
    spy.calls.push({ request, userId: userId as string });
    return spy.outcome;
  }) as typeof import("@tact/runs-core/tact-execution").preflight;
  return { fn, spy };
}

// SOR-260 Phase 1: a deterministic, observable resolver fake. The returned
// principal.id is DERIVED FROM (namespace, externalSubjectId) rather than
// a fixed constant, specifically so a test can assert preflight() received
// THIS value (proving resolution actually ran and its output was threaded
// through) rather than merely proving *some* string was passed.
function resolvedPrincipalId(namespace: string, externalSubjectId: string): string {
  return `principal::${namespace}::${externalSubjectId}`;
}

interface SpyResolvePrincipal {
  calls: Array<{ namespace: string; externalSubjectId: string }>;
}

function makeFakeResolvePrincipal(
  outcomeOverride?: ResolveOrCreateExternalPrincipalOutcome
): { fn: (namespace: string, externalSubjectId: string) => Promise<ResolveOrCreateExternalPrincipalOutcome>; spy: SpyResolvePrincipal } {
  const spy: SpyResolvePrincipal = { calls: [] };
  const fn = async (namespace: string, externalSubjectId: string): Promise<ResolveOrCreateExternalPrincipalOutcome> => {
    spy.calls.push({ namespace, externalSubjectId });
    if (outcomeOverride) return outcomeOverride;
    return {
      status: "resolved",
      principal: {
        id: resolvedPrincipalId(namespace, externalSubjectId),
        namespace,
        externalSubjectId,
        localAuthUserId: null,
        principalKind: "external_subject",
        createdAt: "2026-10-05T00:00:00.000Z",
      },
    };
  };
  return { fn, spy };
}

async function run(): Promise<void> {

  // Tests [3]/[4]/[10] exercise the REAL verifyGovernanceSignedRequest,
  // which resolves CALLER_ID/KEY_ID against RUNS_GOVERNANCE_HMAC_KEYS_JSON.
  // [3] and [4] both fail closed before ever reaching that keyring lookup
  // (missing headers / content digest mismatch respectively), but [10]'s
  // validly-signed duplicate request needs the keyring actually configured
  // to reach a genuine `ok: true` — without it, every one of those three
  // would 503 as a server-config failure rather than exercising the
  // behavior each test is named for.
  const originalKeyring = process.env.RUNS_GOVERNANCE_HMAC_KEYS_JSON;
  process.env.RUNS_GOVERNANCE_HMAC_KEYS_JSON = JSON.stringify({ [`${CALLER_ID}:${KEY_ID}`]: KEY.toString("base64") });

  const decidedOutcome: PreflightOutcome = {
    status: "decided",
    response: {
      decisionId: "dec-1",
      invocationId: "inv-1",
      verdict: "ALLOW",
      reasonCode: "allow_rule",
      evaluatorVersion: "v1",
      policyVersion: "a".repeat(64),
      matchedRuleIdentifier: null,
      approval: { approvalId: null, status: null },
    },
  };

  // [1] valid signed request reaches preflight(), [2] preflight() receives
  // the RESOLVED principal.id — never the raw signed onBehalfOfUserId —
  // and the resolver itself was called with (auth.callerId,
  // envelope.onBehalfOfUserId), [6] core decided -> 200
  {
    const envelope = makeEnvelope("user-a");
    const body = Buffer.from(JSON.stringify(envelope));
    const { fn, spy } = makeFakePreflight(decidedOutcome);
    const { fn: resolveFn, spy: resolveSpy } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: () => ALWAYS_OK_AUTH, resolvePrincipal: resolveFn, preflight: fn };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    const json = await response.json();

    check("[1] a validly-authed request reaches preflight()", spy.calls.length === 1);
    check("[1b] the resolver was called exactly once, with (auth.callerId, envelope.onBehalfOfUserId)", resolveSpy.calls.length === 1 && resolveSpy.calls[0]?.namespace === CALLER_ID && resolveSpy.calls[0]?.externalSubjectId === "user-a");
    check(
      "[2] preflight() receives the RESOLVED principal.id, NOT the raw envelope.onBehalfOfUserId",
      spy.calls[0]?.userId === resolvedPrincipalId(CALLER_ID, "user-a") && spy.calls[0]?.userId !== "user-a"
    );
    check("[6] core status=decided maps to HTTP 200 with the decision in the body", response.status === 200 && json.success === true && json.decision.verdict === "ALLOW");
  }

  // [3] unsigned JSON body cannot select tenant (real verify, no signature headers at all)
  {
    const envelope = makeEnvelope("user-b");
    const body = Buffer.from(JSON.stringify(envelope));
    const { fn, spy } = makeFakePreflight(decidedOutcome);
    const { fn: resolveFn, spy: resolveSpy } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: verifyWithFixedNow, resolvePrincipal: resolveFn, preflight: fn };

    const unsignedRequest = new NextRequest(`https://runs.internal.test${PATHNAME}`, { method: "POST", headers: { "content-type": "application/json" }, body: body.toString("utf-8") });
    const response = await handleGovernancePreflightRequest(unsignedRequest, deps);

    check("[3] an unsigned request is rejected (401) and never reaches preflight()", response.status === 401 && spy.calls.length === 0);
    check("[3b] invalid HMAC never reaches the principal resolver either (resolver call count 0)", resolveSpy.calls.length === 0);
  }

  // [4] tampered onBehalfOfUserId invalidates signature (real verify)
  {
    const envelope = makeEnvelope("user-a");
    const body = Buffer.from(JSON.stringify(envelope));
    const headers = sign(body, FIXED_TIMESTAMP);
    const { fn, spy } = makeFakePreflight(decidedOutcome);
    const { fn: resolveFn, spy: resolveSpy } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: verifyWithFixedNow, resolvePrincipal: resolveFn, preflight: fn };

    const tamperedEnvelope = { ...envelope, onBehalfOfUserId: "user-b" };
    const tamperedBody = Buffer.from(JSON.stringify(tamperedEnvelope));
    const response = await handleGovernancePreflightRequest(makeRequest(tamperedBody, headers), deps);

    check("[4] a tampered onBehalfOfUserId invalidates the signature (401) and never reaches preflight()", response.status === 401 && spy.calls.length === 0);
    check("[4b] a tampered signature never reaches the principal resolver either (resolver call count 0)", resolveSpy.calls.length === 0);
  }

  // [5] malformed body after valid auth -> 400, never reaches the resolver or preflight()
  {
    const malformedBody = Buffer.from("not json");
    const { fn, spy } = makeFakePreflight(decidedOutcome);
    const { fn: resolveFn, spy: resolveSpy } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: () => ALWAYS_OK_AUTH, resolvePrincipal: resolveFn, preflight: fn };

    const response = await handleGovernancePreflightRequest(makeRequest(malformedBody, sign(malformedBody, FIXED_TIMESTAMP)), deps);
    check("[5] a malformed body after valid auth returns 400 and never reaches preflight()", response.status === 400 && spy.calls.length === 0);
    check("[5b] malformed JSON never reaches the principal resolver either (resolver call count 0)", resolveSpy.calls.length === 0);
  }

  // [5c] structurally invalid envelope (valid JSON, but missing onBehalfOfUserId) -> 400, never reaches the resolver or preflight()
  {
    const invalidEnvelopeBody = Buffer.from(JSON.stringify({ request: { invocationId: "inv-1" } }));
    const { fn, spy } = makeFakePreflight(decidedOutcome);
    const { fn: resolveFn, spy: resolveSpy } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: () => ALWAYS_OK_AUTH, resolvePrincipal: resolveFn, preflight: fn };

    const response = await handleGovernancePreflightRequest(makeRequest(invalidEnvelopeBody, sign(invalidEnvelopeBody, FIXED_TIMESTAMP)), deps);
    check("[5c] a structurally invalid envelope (no onBehalfOfUserId) returns 400 and never reaches preflight()", response.status === 400 && spy.calls.length === 0);
    check("[5c-b] an invalid envelope never reaches the principal resolver either (resolver call count 0)", resolveSpy.calls.length === 0);
  }

  // [7] core invalid -> 400
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn } = makeFakePreflight({ status: "invalid", errors: ["actorKind must be one of ..."] });
    const { fn: resolveFn } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: () => ALWAYS_OK_AUTH, resolvePrincipal: resolveFn, preflight: fn };
    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    const json = await response.json();
    check("[7] core status=invalid maps to HTTP 400", response.status === 400 && json.success === false && Array.isArray(json.details));
  }

  // [8] core unavailable/error -> 503
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn } = makeFakePreflight({ status: "unavailable", reason: "governance decision store unavailable" });
    const { fn: resolveFn } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: () => ALWAYS_OK_AUTH, resolvePrincipal: resolveFn, preflight: fn };
    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    check("[8] core status=unavailable maps to HTTP 503", response.status === 503);
  }

  // [8-conflict] core invocation_conflict -> 409 (deterministic idempotency/
  // caller conflict, never retryable, distinct from the retryable 503 above)
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn } = makeFakePreflight({ status: "invocation_conflict" });
    const { fn: resolveFn } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: () => ALWAYS_OK_AUTH, resolvePrincipal: resolveFn, preflight: fn };
    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    const json = await response.json();
    check("[8-conflict] core status=invocation_conflict maps to HTTP 409, not 503", response.status === 409 && json.success === false);
  }

  // [9] auth fail -> no resolver call, no preflight call
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn, spy } = makeFakePreflight(decidedOutcome);
    const { fn: resolveFn, spy: resolveSpy } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: () => ({ ok: false, kind: "client", reason: "signature_invalid" }), resolvePrincipal: resolveFn, preflight: fn };
    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    check("[9] an auth failure never reaches preflight()", response.status === 401 && spy.calls.length === 0);
    check("[9b] an auth failure never reaches the principal resolver either (resolver call count 0, confirms resolution never precedes authentication)", resolveSpy.calls.length === 0);
  }

  // [10] exact duplicate signed request reaches the idempotent contract without a transport-layer replay rejection
  {
    const envelope = makeEnvelope("user-a");
    const body = Buffer.from(JSON.stringify(envelope));
    const headers = sign(body, FIXED_TIMESTAMP);
    const { fn, spy } = makeFakePreflight(decidedOutcome);
    const { fn: resolveFn } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: verifyWithFixedNow, resolvePrincipal: resolveFn, preflight: fn };

    const first = await handleGovernancePreflightRequest(makeRequest(body, { ...headers }), deps);
    const second = await handleGovernancePreflightRequest(makeRequest(body, { ...headers }), deps);
    const firstJson = await first.json();
    const secondJson = await second.json();

    check(
      "[10] an exact duplicate signed request is not rejected as a replay at the transport layer (no nonce store, by design) and reaches the idempotent Preflight contract both times",
      first.status === 200 && second.status === 200 && spy.calls.length === 2 &&
      JSON.stringify(firstJson.decision) === JSON.stringify(secondJson.decision)
    );
  }

  // [11] a declared Content-Length over the limit is rejected before the
  // body is ever read/verified — proven by a tiny real body whose header
  // falsely declares an oversized length; if the route actually read and
  // verified the (tiny, validly-signed) body instead of short-circuiting
  // on the declared length, this would incorrectly reach preflight().
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const headers = sign(body, FIXED_TIMESTAMP);
    headers["content-length"] = String(64 * 1024 + 1);
    const { fn, spy } = makeFakePreflight(decidedOutcome);
    const { fn: resolveFn } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: () => ALWAYS_OK_AUTH, resolvePrincipal: resolveFn, preflight: fn };

    const response = await handleGovernancePreflightRequest(makeRequest(body, headers), deps);
    check(
      "[11] an oversized declared Content-Length is rejected (401) before the body is read, never reaching preflight()",
      response.status === 401 && spy.calls.length === 0
    );
  }

  // [12] SOR-260: principal resolver returns invalid -> 400, never reaches preflight()
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn, spy } = makeFakePreflight(decidedOutcome);
    const { fn: resolveFn } = makeFakeResolvePrincipal({ status: "invalid", errors: ["namespace \"runs-local-auth\" is reserved"] });
    const deps: GovernancePreflightRouteDeps = { verify: () => ALWAYS_OK_AUTH, resolvePrincipal: resolveFn, preflight: fn };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    const json = await response.json();
    check("[12] principal resolver status=invalid maps to HTTP 400 and never reaches preflight()", response.status === 400 && json.success === false && spy.calls.length === 0);
  }

  // [13] SOR-260: principal resolver returns unavailable -> 503, never reaches preflight()
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn, spy } = makeFakePreflight(decidedOutcome);
    const { fn: resolveFn } = makeFakeResolvePrincipal({ status: "unavailable" });
    const deps: GovernancePreflightRouteDeps = { verify: () => ALWAYS_OK_AUTH, resolvePrincipal: resolveFn, preflight: fn };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    check("[13] principal resolver status=unavailable maps to HTTP 503 and never reaches preflight()", response.status === 503 && spy.calls.length === 0);
  }

  // [14] SOR-260: the full existing Preflight verdict contract (ALLOW/DENY/
  // UNKNOWN/APPROVAL_REQUIRED) all reach HTTP 200 via "decided" once a
  // principal has been resolved — none of the four verdicts is special-
  // cased by this route, and every one of them receives the RESOLVED
  // principal.id. APPROVAL_REQUIRED's own ApprovalRequest persistence for
  // an external (non-auth.users) principal is proven at the store/
  // migration layer (tests/tact/execution/principal/principalStore.test.ts
  // and migrationContract.test.ts, plus the existing
  // tests/tact/execution/governance/approvalRequestStore.test.ts, which
  // already exercises ensureGovernanceApprovalRequestForDecision() with an
  // arbitrary trustedUserId string with no auth.users assumption) — this
  // route-level check only proves the HTTP sequencing/argument-passing
  // around whichever verdict Core returns.
  for (const verdict of ["ALLOW", "DENY", "UNKNOWN", "APPROVAL_REQUIRED"] as const) {
    const envelope = makeEnvelope("user-a");
    const body = Buffer.from(JSON.stringify(envelope));
    const verdictOutcome: PreflightOutcome = {
      status: "decided",
      response: { ...decidedOutcome.status === "decided" ? decidedOutcome.response : (() => { throw new Error("unreachable"); })(), verdict },
    };
    const { fn, spy } = makeFakePreflight(verdictOutcome);
    const { fn: resolveFn } = makeFakeResolvePrincipal();
    const deps: GovernancePreflightRouteDeps = { verify: () => ALWAYS_OK_AUTH, resolvePrincipal: resolveFn, preflight: fn };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    const json = await response.json();

    check(
      `[14-${verdict}] verdict=${verdict} reaches HTTP 200 and preflight() received the resolved principal.id`,
      response.status === 200 && json.decision.verdict === verdict &&
      spy.calls[0]?.userId === resolvedPrincipalId(CALLER_ID, "user-a")
    );
  }

  console.log(`GOVERNANCE_PREFLIGHT_ROUTE_TESTS=${checks.length}/${checks.length}`);

  if (originalKeyring === undefined) {
    delete process.env.RUNS_GOVERNANCE_HMAC_KEYS_JSON;
  } else {
    process.env.RUNS_GOVERNANCE_HMAC_KEYS_JSON = originalKeyring;
  }

}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
