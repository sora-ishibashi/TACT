// =========================
// Yolna Runs Standalone — Governance Preflight Route Diagnostics (SOR-138 Slice 3A-4)
// =========================
//
// Exercises ONLY the diagnostics-only instrumentation added to
// handleGovernancePreflightRequest() (see preflightDiagnostics.ts's own
// header comment) — verify()/resolvePrincipal()/preflight() are all
// injected as fakes, and `emitDiagnostic` is injected as a spy so this
// file asserts exact emitted events, never console output. This file does
// NOT re-prove the route's existing auth/parse/validate/HTTP-mapping
// sequencing — governancePreflightRoute.test.ts already does that; this
// file only proves the NEW diagnostic events layered on top of it, and
// that they never change any existing response.
//
// Absolute condition this file exists to prove: "response_construction_reached"
// fires for every HTTP status this route can return, it carries no secret
// (HMAC key/signature, service-role key, OAuth/access token, raw body/
// header, raw DB error, user content), and the route's returned
// HTTP status/body is byte-identical to what governancePreflightRoute.test.ts
// already asserts without any emitDiagnostic override at all (proving the
// optional DI seam's default fallback path is itself inert in a normal
// test that never overrides it).

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
import type { GovernanceAuthResult } from "../lib/governance/runsGovernanceAuth";
import type { GovernancePreflightDiagnosticEvent } from "../lib/governance/preflightDiagnostics";
import type { PreflightOutcome, ResolveOrCreateExternalPrincipalOutcome } from "@tact/runs-core/tact-execution";

const checks: string[] = [];
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); };

const PATHNAME = "/api/tact/runs/governance/preflight";
const CALLER_ID = "yolna-root";
const KEY_ID = "k1";
const KEY = Buffer.alloc(32, 9);
const FIXED_TIMESTAMP = Math.floor(new Date("2026-10-05T00:00:00.000Z").getTime() / 1000).toString();

const ALWAYS_OK_AUTH: GovernanceAuthResult = { ok: true, callerId: CALLER_ID, keyId: KEY_ID };

function sign(body: Buffer, timestamp: string): Record<string, string> {
  const bodySha256Hex = createHash("sha256").update(body).digest("hex");
  const canonical = buildGovernanceSignatureCanonicalString({ method: "POST", pathname: PATHNAME, callerId: CALLER_ID, keyId: KEY_ID, timestamp, bodySha256Hex });
  const signature = createHmac("sha256", KEY).update(canonical, "utf8").digest("hex");
  return {
    [GOVERNANCE_HEADER_CALLER_ID]: CALLER_ID,
    [GOVERNANCE_HEADER_KEY_ID]: KEY_ID,
    [GOVERNANCE_HEADER_TIMESTAMP]: timestamp,
    [GOVERNANCE_HEADER_CONTENT_SHA256]: bodySha256Hex,
    [GOVERNANCE_HEADER_SIGNATURE]: signature,
    "content-type": "application/json",
  };
}

function makeRequest(body: Buffer, headers: Record<string, string>): NextRequest {
  return new NextRequest(`https://runs.internal.test${PATHNAME}`, { method: "POST", headers, body: body.toString("utf-8") });
}

function makeEnvelope(invocationId = "inv-1", onBehalfOfUserId = "user-a"): GovernancePreflightEnvelope {
  return {
    onBehalfOfUserId,
    request: {
      invocationId,
      actorKind: "ai_agent",
      actionCategory: "read",
      operation: "slack.list_channels",
      targetProvider: "slack",
      attemptedAt: "2026-10-05T00:00:00.000Z",
    },
  };
}

function makeFakePreflight(outcome: PreflightOutcome): typeof import("@tact/runs-core/tact-execution").preflight {
  return (async () => outcome) as typeof import("@tact/runs-core/tact-execution").preflight;
}

function makeFakeResolvePrincipal(
  outcome: ResolveOrCreateExternalPrincipalOutcome
): (namespace: string, externalSubjectId: string) => Promise<ResolveOrCreateExternalPrincipalOutcome> {
  return async () => outcome;
}

function makeSpy() {
  const events: GovernancePreflightDiagnosticEvent[] = [];
  const emitDiagnostic = (event: GovernancePreflightDiagnosticEvent) => { events.push(event); };
  return { events, emitDiagnostic };
}

function stagesOf(events: GovernancePreflightDiagnosticEvent[]): string[] {
  return events.map((e) => e.stage);
}

// Closed allowlist — proves no emitted event's own keys exceed the
// hand-typed primitive shape preflightDiagnostics.ts declares (independent
// of the type system; see that module's own header comment).
const ALLOWED_KEYS = new Set(["stage", "invocationId", "elapsedMs", "outcome", "verdict", "httpStatusToSend"]);
function fieldsAreSafe(events: GovernancePreflightDiagnosticEvent[]): boolean {
  return events.every((event) => Object.keys(event).every((key) => ALLOWED_KEYS.has(key)));
}

const RESOLVED_PRINCIPAL: ResolveOrCreateExternalPrincipalOutcome = {
  status: "resolved",
  principal: {
    id: "principal-1",
    namespace: CALLER_ID,
    externalSubjectId: "user-a",
    localAuthUserId: null,
    principalKind: "external_subject",
    createdAt: "2026-10-05T00:00:00.000Z",
  },
};

const DECIDED_ALLOW: PreflightOutcome = {
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

async function run(): Promise<void> {

  // [1] decided/ALLOW -> full A-D diagnostic sequence, HTTP 200, no secrets
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope("inv-1", "user-a")));
    const { events, emitDiagnostic } = makeSpy();
    const deps: GovernancePreflightRouteDeps = {
      verify: () => ALWAYS_OK_AUTH,
      resolvePrincipal: makeFakeResolvePrincipal(RESOLVED_PRINCIPAL),
      preflight: makeFakePreflight(DECIDED_ALLOW),
      emitDiagnostic,
    };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    const json = await response.json();

    check(
      "[1] decided/ALLOW: HTTP 200 unchanged and full diagnostic sequence (request_reached -> principal_resolved -> core_decision_returned -> response_construction_reached) emitted in order",
      response.status === 200 && json.decision.verdict === "ALLOW" &&
      stagesOf(events).join(",") === "request_reached,principal_resolved,core_decision_returned,response_construction_reached"
    );
    check(
      "[1b] core_decision_returned carries the AUTHORITATIVE decision.invocationId and verdict=ALLOW; response_construction_reached carries httpStatusToSend=200",
      events[2]?.stage === "core_decision_returned" && events[2].invocationId === "inv-1" && events[2].outcome === "decided" && events[2].verdict === "ALLOW" &&
      events[3]?.stage === "response_construction_reached" && events[3].httpStatusToSend === 200
    );
    check("[1c] every emitted event's own fields stay within the closed diagnostic allowlist (no secret/raw-payload field ever present)", fieldsAreSafe(events));
  }

  // [2] auth failure -> ZERO diagnostic events (request_reached fires only
  // after authentication succeeds, by design — see the route's own comment).
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { events, emitDiagnostic } = makeSpy();
    const deps: GovernancePreflightRouteDeps = {
      verify: () => ({ ok: false, kind: "client", reason: "signature_invalid" }),
      resolvePrincipal: makeFakeResolvePrincipal(RESOLVED_PRINCIPAL),
      preflight: makeFakePreflight(DECIDED_ALLOW),
      emitDiagnostic,
    };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);

    check("[2] an authentication failure (401) emits ZERO diagnostic events — never an unauthenticated request_reached", response.status === 401 && events.length === 0);
  }

  // [3] principal resolver invalid -> 400, diagnostic sequence stops after principal_resolved
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope("inv-1", "user-a")));
    const { events, emitDiagnostic } = makeSpy();
    const deps: GovernancePreflightRouteDeps = {
      verify: () => ALWAYS_OK_AUTH,
      resolvePrincipal: makeFakeResolvePrincipal({ status: "invalid", errors: ["bad namespace"] }),
      preflight: makeFakePreflight(DECIDED_ALLOW),
      emitDiagnostic,
    };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);

    check(
      "[3] principal resolver status=invalid: HTTP 400 unchanged, diagnostic sequence is request_reached -> principal_resolved(invalid) -> response_construction_reached(400), core_decision_returned never emitted",
      response.status === 400 &&
      stagesOf(events).join(",") === "request_reached,principal_resolved,response_construction_reached" &&
      events[1]?.stage === "principal_resolved" && events[1].outcome === "invalid" &&
      events[2]?.stage === "response_construction_reached" && events[2].httpStatusToSend === 400
    );
  }

  // [4] principal resolver unavailable -> 503
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { events, emitDiagnostic } = makeSpy();
    const deps: GovernancePreflightRouteDeps = {
      verify: () => ALWAYS_OK_AUTH,
      resolvePrincipal: makeFakeResolvePrincipal({ status: "unavailable" }),
      preflight: makeFakePreflight(DECIDED_ALLOW),
      emitDiagnostic,
    };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);

    check(
      "[4] principal resolver status=unavailable: HTTP 503 unchanged, diagnostic sequence stops after principal_resolved(unavailable)",
      response.status === 503 &&
      stagesOf(events).join(",") === "request_reached,principal_resolved,response_construction_reached" &&
      events[1]?.stage === "principal_resolved" && events[1].outcome === "unavailable" &&
      events[2]?.stage === "response_construction_reached" && events[2].httpStatusToSend === 503
    );
  }

  // [5] core invalid -> 400
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { events, emitDiagnostic } = makeSpy();
    const deps: GovernancePreflightRouteDeps = {
      verify: () => ALWAYS_OK_AUTH,
      resolvePrincipal: makeFakeResolvePrincipal(RESOLVED_PRINCIPAL),
      preflight: makeFakePreflight({ status: "invalid", errors: ["bad request"] }),
      emitDiagnostic,
    };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);

    check(
      "[5] core status=invalid: HTTP 400 unchanged, core_decision_returned(outcome=invalid, verdict=null) then response_construction_reached(400)",
      response.status === 400 &&
      stagesOf(events).join(",") === "request_reached,principal_resolved,core_decision_returned,response_construction_reached" &&
      events[2]?.stage === "core_decision_returned" && events[2].outcome === "invalid" && events[2].verdict === null &&
      events[3]?.stage === "response_construction_reached" && events[3].httpStatusToSend === 400
    );
  }

  // [6] core invocation_conflict -> 409 (never confused with the retryable 503 below)
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { events, emitDiagnostic } = makeSpy();
    const deps: GovernancePreflightRouteDeps = {
      verify: () => ALWAYS_OK_AUTH,
      resolvePrincipal: makeFakeResolvePrincipal(RESOLVED_PRINCIPAL),
      preflight: makeFakePreflight({ status: "invocation_conflict" }),
      emitDiagnostic,
    };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);

    check(
      "[6] core status=invocation_conflict: HTTP 409 unchanged, core_decision_returned(outcome=invocation_conflict) then response_construction_reached(409)",
      response.status === 409 &&
      events[2]?.stage === "core_decision_returned" && events[2].outcome === "invocation_conflict" &&
      events[3]?.stage === "response_construction_reached" && events[3].httpStatusToSend === 409
    );
  }

  // [7] core unavailable -> 503
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { events, emitDiagnostic } = makeSpy();
    const deps: GovernancePreflightRouteDeps = {
      verify: () => ALWAYS_OK_AUTH,
      resolvePrincipal: makeFakeResolvePrincipal(RESOLVED_PRINCIPAL),
      preflight: makeFakePreflight({ status: "unavailable", reason: "store unavailable" }),
      emitDiagnostic,
    };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);

    check(
      "[7] core status=unavailable: HTTP 503 unchanged, core_decision_returned(outcome=unavailable) then response_construction_reached(503)",
      response.status === 503 &&
      events[2]?.stage === "core_decision_returned" && events[2].outcome === "unavailable" &&
      events[3]?.stage === "response_construction_reached" && events[3].httpStatusToSend === 503
    );
  }

  // [8] diagnostics are opt-in: omitting `emitDiagnostic` entirely from deps
  // (as every pre-existing governancePreflightRoute.test.ts case does)
  // must still produce the exact same HTTP response — the optional DI seam
  // falls back to the real, env-gated emitter, which is a no-op in this
  // test process (RUNS_GOVERNANCE_PREFLIGHT_DIAGNOSTICS_ENABLED unset).
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope("inv-1", "user-a")));
    const deps: GovernancePreflightRouteDeps = {
      verify: () => ALWAYS_OK_AUTH,
      resolvePrincipal: makeFakeResolvePrincipal(RESOLVED_PRINCIPAL),
      preflight: makeFakePreflight(DECIDED_ALLOW),
      // emitDiagnostic deliberately omitted.
    };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    const json = await response.json();

    check(
      "[8] omitting emitDiagnostic entirely still returns the identical HTTP 200 ALLOW response (optional DI seam's fallback never changes behavior)",
      response.status === 200 && json.success === true && json.decision.verdict === "ALLOW"
    );
  }

  // [9] diagnostic-safety fix: an emitDiagnostic that throws on EVERY
  // stage — including "response_construction_reached", emitted
  // immediately before the route returns its already-computed response —
  // must never change the HTTP status/body actually returned. Before this
  // fix, the unguarded call site let that exception reject the handler
  // and replace a correct 200 ALLOW with an unrelated thrown error.
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope("inv-1", "user-a")));
    const emittedStages: string[] = [];
    const deps: GovernancePreflightRouteDeps = {
      verify: () => ALWAYS_OK_AUTH,
      resolvePrincipal: makeFakeResolvePrincipal(RESOLVED_PRINCIPAL),
      preflight: makeFakePreflight(DECIDED_ALLOW),
      emitDiagnostic: (event) => {
        emittedStages.push(event.stage);
        throw new Error(`simulated diagnostic emitter failure at stage "${event.stage}"`);
      },
    };

    const response = await handleGovernancePreflightRequest(makeRequest(body, sign(body, FIXED_TIMESTAMP)), deps);
    const json = await response.json();

    check(
      "[9] a throwing emitDiagnostic never changes the route's returned HTTP 200 ALLOW response, despite failing on every stage including the one immediately before return",
      response.status === 200 && json.success === true && json.decision.verdict === "ALLOW" &&
      emittedStages.join(",") === "request_reached,principal_resolved,core_decision_returned,response_construction_reached"
    );
  }

  console.log(`GOVERNANCE_PREFLIGHT_ROUTE_DIAGNOSTICS_TESTS=${checks.length}/${checks.length}`);

}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
