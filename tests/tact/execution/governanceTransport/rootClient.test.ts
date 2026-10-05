// =========================
// SOR-138 Slice 3A-1 — Root Yolna Governance Client
// =========================
//
// Tests core/tact-integration/runsGovernance.ts entirely against a fake
// fetch (no real network, no standalone Runs process). This file ALSO
// independently re-derives the expected HMAC-SHA256 signature using
// node:crypto directly (never importing the standalone verifier — root
// code must never import products/yolna-runs/**, see
// scripts/verify/rootForbiddenStandaloneImport.ts) to prove the signer
// itself produces a byte-for-byte correct, reproducible signature. The
// standalone verifier's own accept/reject behavior (tampering, rotation,
// stale timestamps, malformed keyring, ...) is covered independently in
// products/yolna-runs/scripts/runsGovernanceAuth.test.ts, which performs
// the mirror-image check: constructing signed requests from raw
// node:crypto calls (never importing this root client) and feeding them
// to the real verifier. Together the two files fully exercise both ends
// of the signature without either side importing the other's product
// tree — exactly the isolation boundary SOR-135 requires.

import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  buildGovernanceSignatureCanonicalString,
  GOVERNANCE_HEADER_CALLER_ID,
  GOVERNANCE_HEADER_CONTENT_SHA256,
  GOVERNANCE_HEADER_KEY_ID,
  GOVERNANCE_HEADER_SIGNATURE,
  GOVERNANCE_HEADER_TIMESTAMP,
  type GovernancePreflightEnvelope,
  type GovernanceCompleteEnvelope,
  type PreflightRequest,
  type CompleteRequest,
} from "@tact/execution-contract";
import {
  callRunsGovernancePreflight,
  callRunsGovernanceComplete,
  type RunsGovernanceClientDeps,
  type RunsGovernanceConfigResult,
} from "../../../../core/tact-integration/runsGovernance";
import { check, summarize, type CheckResult } from "../../lib/check";

const HMAC_KEY = Buffer.alloc(32, 7);
const CONFIG: RunsGovernanceConfigResult = {
  ok: true,
  config: { baseUrl: "https://runs.internal.test", callerId: "yolna-root", keyId: "k1", hmacKey: HMAC_KEY },
};

function makePreflightRequest(overrides: Partial<PreflightRequest> = {}): PreflightRequest {
  return {
    invocationId: randomUUID(),
    actorKind: "ai_agent",
    actionCategory: "read",
    operation: "slack.list_channels",
    targetProvider: "slack",
    attemptedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

function makeCompleteRequest(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    decisionId: randomUUID(),
    invocationId: randomUUID(),
    execution: {
      provider: "slack",
      sourceType: "sdk_callback",
      externalEventId: randomUUID(),
      adapterVersion: "test-adapter@1",
      status: "succeeded",
    },
    ...overrides,
  };
}

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

interface FakeFetchBehavior {
  response?: { status: number; body?: unknown; malformedJson?: boolean };
  throwError?: Error;
  abortOnSignal?: boolean;
}

function makeFakeFetch(behavior: FakeFetchBehavior) {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });

    if (behavior.abortOnSignal) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }

    if (behavior.throwError) {
      throw behavior.throwError;
    }

    const status = behavior.response?.status ?? 200;
    return {
      status,
      json: async () => {
        if (behavior.response?.malformedJson) {
          throw new Error("not json");
        }
        return behavior.response?.body;
      },
    } as unknown as Response;
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function makeDeps(
  behavior: FakeFetchBehavior,
  overrides: Partial<RunsGovernanceClientDeps> = {}
): { deps: RunsGovernanceClientDeps; calls: FakeFetchCall[] } {
  const { fetchImpl, calls } = makeFakeFetch(behavior);
  return {
    deps: {
      fetchImpl,
      now: () => new Date("2026-10-05T00:00:00.000Z"),
      timeoutMs: 50,
      loadConfig: () => CONFIG,
      ...overrides,
    },
    calls,
  };
}

function expectedSignature(method: string, pathname: string, bodyBuffer: Buffer, timestamp: string): { bodySha256Hex: string; signature: string } {
  const bodySha256Hex = createHash("sha256").update(bodyBuffer).digest("hex");
  const canonical = buildGovernanceSignatureCanonicalString({
    method,
    pathname,
    callerId: CONFIG.ok ? CONFIG.config.callerId : "",
    keyId: CONFIG.ok ? CONFIG.config.keyId : "",
    timestamp,
    bodySha256Hex,
  });
  const signature = createHmac("sha256", HMAC_KEY).update(canonical, "utf8").digest("hex");
  return { bodySha256Hex, signature };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const preflightResponseBody = {
    decisionId: "dec-1",
    invocationId: "inv-1",
    verdict: "ALLOW" as const,
    reasonCode: "allow_rule",
    evaluatorVersion: "v1",
    policyVersion: "a".repeat(64),
    matchedRuleIdentifier: "rule-1",
    approval: { approvalId: null, status: null },
  };

  const completeResultBody = {
    status: "linked" as const,
    executionId: "exec-1",
    governanceExecutionLinkId: "link-1",
    outcomeRecorded: false,
  };

  // [1] correct endpoint path, [2] correct signed envelope, [3] signed onBehalfOfUserId,
  // [4] no providerConnectionRef, [5] no Composio credential, [6] no Supabase service-role
  {
    const envelope: GovernancePreflightEnvelope = { onBehalfOfUserId: "user-a", request: makePreflightRequest() };
    const { deps, calls } = makeDeps({ response: { status: 200, body: { success: true, decision: preflightResponseBody } } });

    const result = await callRunsGovernancePreflight(envelope, deps);

    results.push(check("[1] correct endpoint path", calls.length === 1 && calls[0].url === "https://runs.internal.test/api/tact/runs/governance/preflight"));

    const sentBody = calls[0].init.body as Buffer;
    const sentEnvelope = JSON.parse(sentBody.toString("utf-8"));
    results.push(check(
      "[2] correct signed envelope shape (onBehalfOfUserId + request)",
      sentEnvelope.onBehalfOfUserId === "user-a" && sentEnvelope.request.invocationId === envelope.request.invocationId
    ));
    results.push(check("[3] signed onBehalfOfUserId equals what the caller supplied", sentEnvelope.onBehalfOfUserId === "user-a"));

    const serialized = JSON.stringify(sentEnvelope);
    results.push(check("[4] no providerConnectionRef ever appears in the envelope", !serialized.includes("providerConnectionRef")));
    results.push(check("[5] no Composio credential ever appears in the envelope", !/composio/i.test(serialized)));
    results.push(check("[6] no Supabase service-role value ever appears in the envelope", !/service[_-]?role/i.test(serialized)));

    results.push(check("[13] a valid Preflight response is preserved exactly", result.status === "decided" && JSON.stringify(result.response) === JSON.stringify(preflightResponseBody)));

    // Signer correctness: independently re-derive the expected signature
    // from the exact bytes sent and compare against what the client
    // actually sent as headers.
    const headers = calls[0].init.headers as Record<string, string>;
    const timestamp = headers[GOVERNANCE_HEADER_TIMESTAMP];
    const expected = expectedSignature("POST", "/api/tact/runs/governance/preflight", sentBody, timestamp);
    results.push(check(
      "[signer] body digest header matches the actual sent bytes",
      headers[GOVERNANCE_HEADER_CONTENT_SHA256] === expected.bodySha256Hex
    ));
    results.push(check(
      "[signer] signature header matches an independently-recomputed HMAC over the same canonical string",
      headers[GOVERNANCE_HEADER_SIGNATURE] === expected.signature
    ));
    results.push(check(
      "[signer] callerId/keyId headers match configured values",
      headers[GOVERNANCE_HEADER_CALLER_ID] === "yolna-root" && headers[GOVERNANCE_HEADER_KEY_ID] === "k1"
    ));
  }

  // [7] missing config -> unavailable
  {
    const { deps } = makeDeps({ response: { status: 200, body: {} } }, { loadConfig: () => ({ ok: false, reason: "missing_hmac_key" }) });
    const result = await callRunsGovernancePreflight({ onBehalfOfUserId: "user-a", request: makePreflightRequest() }, deps);
    results.push(check("[7] missing config produces status=unavailable, never a verdict", result.status === "unavailable" && result.reason === "unconfigured"));
  }

  // [8] timeout -> unavailable
  {
    const { deps } = makeDeps({ abortOnSignal: true }, { timeoutMs: 5 });
    const result = await callRunsGovernancePreflight({ onBehalfOfUserId: "user-a", request: makePreflightRequest() }, deps);
    results.push(check("[8] timeout produces status=unavailable, never a verdict", result.status === "unavailable" && result.reason === "timeout"));
  }

  // [9] network failure -> unavailable
  {
    const { deps } = makeDeps({ throwError: Object.assign(new Error("ECONNREFUSED"), { name: "FetchError" }) });
    const result = await callRunsGovernancePreflight({ onBehalfOfUserId: "user-a", request: makePreflightRequest() }, deps);
    results.push(check("[9] network failure produces status=unavailable, never a verdict", result.status === "unavailable" && result.reason === "network_error"));
  }

  // [10] malformed JSON response -> unavailable
  {
    const { deps } = makeDeps({ response: { status: 200, malformedJson: true } });
    const result = await callRunsGovernancePreflight({ onBehalfOfUserId: "user-a", request: makePreflightRequest() }, deps);
    results.push(check("[10] malformed JSON response produces status=unavailable, never a verdict", result.status === "unavailable" && result.reason === "malformed_response"));
  }

  // [11] invalid response shape -> unavailable
  {
    const { deps } = makeDeps({ response: { status: 200, body: { success: true, decision: { verdict: "ALLOW" } } } });
    const result = await callRunsGovernancePreflight({ onBehalfOfUserId: "user-a", request: makePreflightRequest() }, deps);
    results.push(check("[11] schema-mismatched response produces status=unavailable, never a verdict", result.status === "unavailable" && result.reason === "invalid_response_shape"));
  }

  // [12] non-2xx -> unavailable/error
  {
    const { deps } = makeDeps({ response: { status: 500, body: { success: false, error: "boom" } } });
    const result = await callRunsGovernancePreflight({ onBehalfOfUserId: "user-a", request: makePreflightRequest() }, deps);
    results.push(check("[12] non-2xx produces status=unavailable, never a verdict", result.status === "unavailable" && result.reason === "non_2xx" && result.httpStatus === 500));
  }

  // [12-conflict] a 409 (invocation_conflict) is treated as any other
  // non-2xx: a non-success, fail-closed result with no verdict exposed —
  // the client does not need a dedicated executable state for this status
  // (Human Owner pre-commit review, SOR-138 Slice 3A-1: "409 must NEVER
  // expose a verdict and must NEVER be interpreted as ALLOW").
  {
    const { deps } = makeDeps({ response: { status: 409, body: { success: false, error: "invocation_conflict" } } });
    const result = await callRunsGovernancePreflight({ onBehalfOfUserId: "user-a", request: makePreflightRequest() }, deps);
    results.push(check(
      "[12-conflict] HTTP 409 produces status=unavailable with no verdict field anywhere on the result, never ALLOW",
      result.status === "unavailable" && result.reason === "non_2xx" && result.httpStatus === 409 && !("response" in result)
    ));
  }

  // [14] valid Complete response preserved exactly
  {
    const envelope: GovernanceCompleteEnvelope = { onBehalfOfUserId: "user-a", request: makeCompleteRequest() };
    const { deps } = makeDeps({ response: { status: 200, body: { success: true, result: completeResultBody } } });
    const result = await callRunsGovernanceComplete(envelope, deps);
    results.push(check("[14] a valid Complete response is preserved exactly", result.status === "completed" && JSON.stringify(result.result) === JSON.stringify(completeResultBody)));
  }

  // Complete also accepts its documented non-200 "real result" statuses (400/404/409)
  {
    const envelope: GovernanceCompleteEnvelope = { onBehalfOfUserId: "user-a", request: makeCompleteRequest() };
    const invalidResult = { status: "invalid" as const, reason: "bad request" };
    const { deps } = makeDeps({ response: { status: 400, body: { success: true, result: invalidResult } } });
    const result = await callRunsGovernanceComplete(envelope, deps);
    results.push(check(
      "[complete mapping] HTTP 400 with a real CompleteResult is surfaced as status=completed, not unavailable",
      result.status === "completed" && result.result.status === "invalid"
    ));
  }

  // [15] no automatic retry
  {
    const { deps, calls } = makeDeps({ throwError: new Error("network down") });
    await callRunsGovernancePreflight({ onBehalfOfUserId: "user-a", request: makePreflightRequest() }, deps);
    results.push(check("[15] the client makes exactly one fetch call per Preflight — no automatic retry", calls.length === 1));
  }

  return summarize("execution/governanceTransport/rootClient", results);

}
