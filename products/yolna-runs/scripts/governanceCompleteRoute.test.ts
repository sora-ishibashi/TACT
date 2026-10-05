// =========================
// Yolna Runs Standalone — Governance Complete Route Regression (SOR-138 Slice 3A-1)
// =========================
//
// Exercises the real exported handleGovernanceCompleteRequest() directly.
// complete() itself is injected as a fake spy (its own Core behavior is
// already covered by tests/tact/execution/governance/contract.test.ts at
// the repo root) so this file can inspect exactly what trustedDeps the
// route constructed — the only way to prove the route, not the caller,
// owns observationMode/preExecutionVisible.

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
  type GovernanceCompleteEnvelope,
  type CompleteResult,
} from "@tact/execution-contract";
import {
  handleGovernanceCompleteRequest,
  buildDefaultTrustedDeps,
  type GovernanceCompleteRouteDeps,
} from "../app/api/tact/runs/governance/complete/route";
import type { CompleteDeps } from "@tact/runs-core/tact-execution";
import type { GovernanceAuthResult } from "../lib/governance/runsGovernanceAuth";

const checks: string[] = [];
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); };

const PATHNAME = "/api/tact/runs/governance/complete";
const CALLER_ID = "yolna-root";
const KEY_ID = "k1";
const KEY = Buffer.alloc(32, 9);

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
  // See the matching comment in governancePreflightRoute.test.ts — a UTF-8
  // string round-trips to the identical bytes through request.arrayBuffer().
  return new NextRequest(`https://runs.internal.test${PATHNAME}`, { method: "POST", headers, body: body.toString("utf-8") });
}

const ALWAYS_OK_AUTH: GovernanceAuthResult = { ok: true, callerId: CALLER_ID, keyId: KEY_ID };

function makeEnvelope(onBehalfOfUserId = "user-a", extraRequestFields: Record<string, unknown> = {}): GovernanceCompleteEnvelope {
  return {
    onBehalfOfUserId,
    request: {
      decisionId: "dec-1",
      invocationId: "inv-1",
      execution: {
        provider: "slack",
        sourceType: "sdk_callback",
        externalEventId: "run-1",
        adapterVersion: "test-adapter@1",
        status: "succeeded",
      },
      // Deliberately stuffing fields a malicious/sloppy caller might try —
      // CompleteRequest has no such fields at the type level, but the
      // route must also not read them off a loosely-typed JSON body at
      // runtime. See test [3] below.
      ...extraRequestFields,
    } as GovernanceCompleteEnvelope["request"],
  };
}

interface SpyComplete {
  calls: Array<{ request: unknown; userId: string; trustedDeps: CompleteDeps }>;
  result: CompleteResult;
}

function makeFakeComplete(result: CompleteResult): { fn: typeof import("@tact/runs-core/tact-execution").complete; spy: SpyComplete } {
  const spy: SpyComplete = { calls: [], result };
  const fn = (async (request: unknown, userId: string, trustedDeps: CompleteDeps) => {
    spy.calls.push({ request, userId: userId as string, trustedDeps });
    return spy.result;
  }) as typeof import("@tact/runs-core/tact-execution").complete;
  return { fn, spy };
}

// The route always constructs trustedDeps before calling complete() —
// even when complete() itself is faked (as it is in every test below
// except [1]-[5]), so this factory must return a real, well-shaped
// CompleteDeps rather than throw. Its contents are never actually invoked
// by these tests (the fake complete() never calls capture/link/
// assertExecutionOutcome itself), so stub functions that would fail loudly
// if ever actually called are intentional — only this factory's own return
// shape matters here.
function stubTrustedDepsFactory(): CompleteDeps {
  const neverCall = () => { throw new Error("this stub dep must never actually be invoked — complete() is faked in this test"); };
  return {
    getGovernanceInvocation: neverCall as unknown as CompleteDeps["getGovernanceInvocation"],
    listGovernanceDecisionsForInvocation: neverCall as unknown as CompleteDeps["listGovernanceDecisionsForInvocation"],
    capture: neverCall as unknown as CompleteDeps["capture"],
    linkInvocationExecution: neverCall as unknown as CompleteDeps["linkInvocationExecution"],
    assertExecutionOutcome: neverCall as unknown as CompleteDeps["assertExecutionOutcome"],
  };
}

async function run(): Promise<void> {

  const linkedResult: CompleteResult = { status: "linked", executionId: "exec-1", governanceExecutionLinkId: "link-1", outcomeRecorded: false };

  // [1] valid signed request reaches complete(), [2] trusted userId is the signed envelope user,
  // [3] CompleteRequest cannot carry trust fields, [4] route injects inline/false provenance, [5] linked -> 200
  {
    const envelope = makeEnvelope("user-a", { observationMode: "reconciled", preExecutionVisible: true, trust: "full" });
    const body = Buffer.from(JSON.stringify(envelope));
    const { fn, spy } = makeFakeComplete(linkedResult);

    // buildTrustedDeps is the REAL production factory (buildDefaultTrustedDeps,
    // exported by the route specifically so this test can prove the DEFAULT
    // wiring injects inline/false, not just that dependency injection
    // itself works). capture()/linkInvocationExecution()/
    // assertExecutionOutcome() are never actually invoked below (complete()
    // itself is faked, see spy), so this never touches a real Supabase
    // client despite using the real factory.
    const deps: GovernanceCompleteRouteDeps = { verify: () => ALWAYS_OK_AUTH, complete: fn, buildTrustedDeps: buildDefaultTrustedDeps };

    const response = await handleGovernanceCompleteRequest(makeRequest(body, sign(body, "1759622400")), deps);
    const json = await response.json();

    check("[1] a validly-authed request reaches complete()", spy.calls.length === 1);
    check("[2] the trusted userId passed to complete() equals the signed envelope's onBehalfOfUserId", spy.calls[0]?.userId === "user-a");
    check(
      "[3] extra wire fields on the request (observationMode/preExecutionVisible/trust) never reach trustedDeps.observationProvenance",
      spy.calls[0]?.trustedDeps.observationProvenance?.observationMode === "inline" &&
      spy.calls[0]?.trustedDeps.observationProvenance?.preExecutionVisible === false
    );
    check(
      "[4] the route itself injects observationMode=inline, preExecutionVisible=false",
      spy.calls[0]?.trustedDeps.observationProvenance?.observationMode === "inline" &&
      spy.calls[0]?.trustedDeps.observationProvenance?.preExecutionVisible === false
    );
    check("[5] core status=linked maps to HTTP 200", response.status === 200 && json.success === true && json.result.status === "linked");
  }

  // [6] already_linked -> 200
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn } = makeFakeComplete({ status: "already_linked", executionId: "exec-1" });
    const deps: GovernanceCompleteRouteDeps = { verify: () => ALWAYS_OK_AUTH, complete: fn, buildTrustedDeps: stubTrustedDepsFactory };
    const response = await handleGovernanceCompleteRequest(makeRequest(body, sign(body, "1759622400")), deps);
    check("[6] core status=already_linked maps to HTTP 200", response.status === 200);
  }

  // [7] link_conflict -> 409
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn } = makeFakeComplete({ status: "link_conflict", executionId: "exec-1" });
    const deps: GovernanceCompleteRouteDeps = { verify: () => ALWAYS_OK_AUTH, complete: fn, buildTrustedDeps: stubTrustedDepsFactory };
    const response = await handleGovernanceCompleteRequest(makeRequest(body, sign(body, "1759622400")), deps);
    check("[7] core status=link_conflict maps to HTTP 409", response.status === 409);
  }

  // [8] invocation_not_found / decision_not_found -> 404
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn } = makeFakeComplete({ status: "invocation_not_found" });
    const deps: GovernanceCompleteRouteDeps = { verify: () => ALWAYS_OK_AUTH, complete: fn, buildTrustedDeps: stubTrustedDepsFactory };
    const response = await handleGovernanceCompleteRequest(makeRequest(body, sign(body, "1759622400")), deps);

    const body2 = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn: fn2 } = makeFakeComplete({ status: "decision_not_found" });
    const deps2: GovernanceCompleteRouteDeps = { verify: () => ALWAYS_OK_AUTH, complete: fn2, buildTrustedDeps: stubTrustedDepsFactory };
    const response2 = await handleGovernanceCompleteRequest(makeRequest(body2, sign(body2, "1759622400")), deps2);

    check("[8] core status=invocation_not_found/decision_not_found maps to HTTP 404", response.status === 404 && response2.status === 404);
  }

  // [9] invalid -> 400
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn } = makeFakeComplete({ status: "invalid", reason: "execution.provider must be one of ..." });
    const deps: GovernanceCompleteRouteDeps = { verify: () => ALWAYS_OK_AUTH, complete: fn, buildTrustedDeps: stubTrustedDepsFactory };
    const response = await handleGovernanceCompleteRequest(makeRequest(body, sign(body, "1759622400")), deps);
    check("[9] core status=invalid maps to HTTP 400", response.status === 400);
  }

  // [10] unavailable/error -> 503
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn } = makeFakeComplete({ status: "unavailable" });
    const deps: GovernanceCompleteRouteDeps = { verify: () => ALWAYS_OK_AUTH, complete: fn, buildTrustedDeps: stubTrustedDepsFactory };
    const response = await handleGovernanceCompleteRequest(makeRequest(body, sign(body, "1759622400")), deps);

    const body2 = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn: fn2 } = makeFakeComplete({ status: "error", reason: "db write failed" });
    const deps2: GovernanceCompleteRouteDeps = { verify: () => ALWAYS_OK_AUTH, complete: fn2, buildTrustedDeps: stubTrustedDepsFactory };
    const response2 = await handleGovernanceCompleteRequest(makeRequest(body2, sign(body2, "1759622400")), deps2);

    check("[10] core status=unavailable/error maps to HTTP 503", response.status === 503 && response2.status === 503);
  }

  // [11] auth failure -> complete() not called
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const { fn, spy } = makeFakeComplete(linkedResult);
    const deps: GovernanceCompleteRouteDeps = { verify: () => ({ ok: false, kind: "client", reason: "signature_invalid" }), complete: fn, buildTrustedDeps: stubTrustedDepsFactory };
    const response = await handleGovernanceCompleteRequest(makeRequest(body, sign(body, "1759622400")), deps);
    check("[11] an auth failure never reaches complete()", response.status === 401 && spy.calls.length === 0);
  }

  // [12] duplicate identical Complete remains idempotent at the application boundary
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const headers = sign(body, "1759622400");
    // A real Core complete() call for the identical request/decision/invocation
    // returns "already_linked" on the second call — modeled here by a spy
    // that returns "linked" once then "already_linked" thereafter, exactly
    // as the real store-backed implementation's own idempotency already
    // guarantees (see tests/tact/execution/governance/contract.test.ts).
    let callCount = 0;
    const fn = (async () => {
      callCount += 1;
      return callCount === 1
        ? { status: "linked" as const, executionId: "exec-1", governanceExecutionLinkId: "link-1", outcomeRecorded: false }
        : { status: "already_linked" as const, executionId: "exec-1", governanceExecutionLinkId: "link-1", outcomeRecorded: false };
    }) as typeof import("@tact/runs-core/tact-execution").complete;
    const deps: GovernanceCompleteRouteDeps = { verify: () => ALWAYS_OK_AUTH, complete: fn, buildTrustedDeps: stubTrustedDepsFactory };

    const first = await handleGovernanceCompleteRequest(makeRequest(body, { ...headers }), deps);
    const second = await handleGovernanceCompleteRequest(makeRequest(body, { ...headers }), deps);
    const firstJson = await first.json();
    const secondJson = await second.json();

    check(
      "[12] a duplicate identical Complete call is not rejected at the transport layer and resolves idempotently (linked, then already_linked) without a second Canonical Execution",
      first.status === 200 && second.status === 200 &&
      firstJson.result.status === "linked" && secondJson.result.status === "already_linked" &&
      firstJson.result.executionId === secondJson.result.executionId
    );
  }

  // [13] an oversized declared Content-Length is rejected before the body
  // is read, never reaching complete() — mirrors the matching Preflight
  // route test.
  {
    const body = Buffer.from(JSON.stringify(makeEnvelope()));
    const headers = sign(body, "1759622400");
    headers["content-length"] = String(64 * 1024 + 1);
    const { fn, spy } = makeFakeComplete(linkedResult);
    const deps: GovernanceCompleteRouteDeps = { verify: () => ALWAYS_OK_AUTH, complete: fn, buildTrustedDeps: stubTrustedDepsFactory };

    const response = await handleGovernanceCompleteRequest(makeRequest(body, headers), deps);
    check(
      "[13] an oversized declared Content-Length is rejected (401) before the body is read, never reaching complete()",
      response.status === 401 && spy.calls.length === 0
    );
  }

  console.log(`GOVERNANCE_COMPLETE_ROUTE_TESTS=${checks.length}/${checks.length}`);

}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
