// =========================
// Yolna Runs Standalone — Governance Caller Auth Regression (SOR-138 Slice 3A-1)
// =========================
//
// Tests lib/governance/runsGovernanceAuth.ts's verifyGovernanceSignedRequest()
// against requests this file signs itself with raw node:crypto calls —
// deliberately NOT importing core/tact-integration/runsGovernance.ts (the
// root Yolna signer), which this standalone product must never import (see
// scripts/verify/standaloneForbiddenImports.ts). The mirror-image proof —
// that the root signer itself produces a correct signature — lives in
// tests/tact/execution/governanceTransport/rootClient.test.ts at the repo
// root, which independently re-derives the expected signature instead of
// importing this file. Together the two prove both ends of the boundary
// without either product importing the other's source tree.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  buildGovernanceSignatureCanonicalString,
  GOVERNANCE_HEADER_CALLER_ID,
  GOVERNANCE_HEADER_CONTENT_SHA256,
  GOVERNANCE_HEADER_KEY_ID,
  GOVERNANCE_HEADER_SIGNATURE,
  GOVERNANCE_HEADER_TIMESTAMP,
} from "@tact/execution-contract";
import {
  verifyGovernanceSignedRequest,
  exceedsDeclaredContentLength,
  GOVERNANCE_MAX_BODY_BYTES,
} from "../lib/governance/runsGovernanceAuth";

const checks: string[] = [];
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); };

const CALLER_ID = "yolna-root";
const KEY_ID = "k1";
const KEY_B64 = Buffer.alloc(32, 9).toString("base64");
const SECOND_KEY_ID = "k2";
const SECOND_KEY_B64 = Buffer.alloc(32, 5).toString("base64");

function signedHeaders(opts: {
  method: string;
  pathname: string;
  body: Buffer;
  timestamp: string;
  callerId: string;
  keyId: string;
  keyB64: string;
}): Record<string, string> {
  const bodySha256Hex = createHash("sha256").update(opts.body).digest("hex");
  const canonical = buildGovernanceSignatureCanonicalString({
    method: opts.method,
    pathname: opts.pathname,
    callerId: opts.callerId,
    keyId: opts.keyId,
    timestamp: opts.timestamp,
    bodySha256Hex,
  });
  const key = Buffer.from(opts.keyB64, "base64");
  const signature = createHmac("sha256", key).update(canonical, "utf8").digest("hex");
  return {
    [GOVERNANCE_HEADER_CALLER_ID]: opts.callerId,
    [GOVERNANCE_HEADER_KEY_ID]: opts.keyId,
    [GOVERNANCE_HEADER_TIMESTAMP]: opts.timestamp,
    [GOVERNANCE_HEADER_CONTENT_SHA256]: bodySha256Hex,
    [GOVERNANCE_HEADER_SIGNATURE]: signature,
  };
}

function makeRequest(method: string, pathname: string, headers: Record<string, string>): Request {
  return new Request(`https://runs.internal.test${pathname}`, { method, headers });
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    original[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
}

async function run(): Promise<void> {

  const keyring = JSON.stringify({
    [`${CALLER_ID}:${KEY_ID}`]: KEY_B64,
    [`${CALLER_ID}:${SECOND_KEY_ID}`]: SECOND_KEY_B64,
  });

  const body = Buffer.from(JSON.stringify({ onBehalfOfUserId: "user-a", request: { invocationId: "inv-1" } }));
  const method = "POST";
  const pathname = "/api/tact/runs/governance/preflight";
  const now = new Date("2026-10-05T00:00:00.000Z");
  const timestamp = Math.floor(now.getTime() / 1000).toString();

  await withEnv({ RUNS_GOVERNANCE_HMAC_KEYS_JSON: keyring }, async () => {

    // [1] valid signature accepted
    {
      const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
      const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
      check("[1] a validly signed request is accepted", result.ok === true && result.ok && result.callerId === CALLER_ID && result.keyId === KEY_ID);
    }

    // [2] body byte changed -> rejected
    {
      const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
      const tamperedBody = Buffer.from(JSON.stringify({ onBehalfOfUserId: "user-b", request: { invocationId: "inv-1" } }));
      const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), tamperedBody, now);
      check("[2] a changed request body is rejected (content digest mismatch)", !result.ok && result.kind === "client" && result.reason === "content_digest_mismatch");
    }

    // [3] callerId changed -> rejected
    {
      const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
      headers[GOVERNANCE_HEADER_CALLER_ID] = "yolna-impostor";
      const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
      check("[3] a changed callerId invalidates the signature", !result.ok && result.kind === "client" && (result.reason === "unknown_caller_key" || result.reason === "signature_invalid"));
    }

    // [4] keyId changed -> rejected
    {
      const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
      headers[GOVERNANCE_HEADER_KEY_ID] = SECOND_KEY_ID;
      const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
      check("[4] a changed keyId (without re-signing with that key) invalidates the signature", !result.ok && result.kind === "client" && result.reason === "signature_invalid");
    }

    // [5] path changed -> rejected
    {
      const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
      const result = verifyGovernanceSignedRequest(makeRequest(method, "/api/tact/runs/governance/complete", headers), body, now);
      check("[5] a changed request path invalidates the signature", !result.ok && result.kind === "client" && result.reason === "signature_invalid");
    }

    // [6] method changed -> rejected
    {
      const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
      const result = verifyGovernanceSignedRequest(makeRequest("GET", pathname, headers), body, now);
      check("[6] a changed HTTP method invalidates the signature", !result.ok && result.kind === "client" && result.reason === "signature_invalid");
    }

    // [7] timestamp changed without re-sign -> rejected
    {
      const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
      headers[GOVERNANCE_HEADER_TIMESTAMP] = (Number(timestamp) + 1).toString();
      const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
      check("[7] a changed timestamp (without re-signing) invalidates the signature", !result.ok && result.kind === "client" && result.reason === "signature_invalid");
    }

    // [8] stale timestamp -> rejected
    {
      const staleTimestamp = Math.floor(now.getTime() / 1000 - 301).toString();
      const headers = signedHeaders({ method, pathname, body, timestamp: staleTimestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
      const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
      check("[8] a timestamp older than the freshness window is rejected", !result.ok && result.kind === "client" && result.reason === "timestamp_stale");
    }

    // [9] future timestamp -> rejected
    {
      const futureTimestamp = Math.floor(now.getTime() / 1000 + 301).toString();
      const headers = signedHeaders({ method, pathname, body, timestamp: futureTimestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
      const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
      check("[9] a timestamp further ahead than the freshness window is rejected", !result.ok && result.kind === "client" && result.reason === "timestamp_future");
    }

    // [10] malformed signature -> rejected
    {
      const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
      headers[GOVERNANCE_HEADER_SIGNATURE] = "not-hex!!";
      const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
      check("[10] a malformed (non-hex) signature header is rejected", !result.ok && result.kind === "client" && result.reason === "malformed_headers");
    }

    // [11] unknown caller/key -> rejected
    {
      const headers = signedHeaders({ method, pathname, body, timestamp, callerId: "unregistered-caller", keyId: KEY_ID, keyB64: KEY_B64 });
      const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
      check("[11] an unregistered caller/key pair is rejected as a client failure", !result.ok && result.kind === "client" && result.reason === "unknown_caller_key");
    }

    // [15] second key ID accepted for rotation
    {
      const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: SECOND_KEY_ID, keyB64: SECOND_KEY_B64 });
      const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
      check("[15] a second, concurrently-registered keyId is accepted (rotation support)", result.ok === true && result.ok && result.keyId === SECOND_KEY_ID);
    }

  });

  // [12] malformed keyring -> server unavailable
  await withEnv({ RUNS_GOVERNANCE_HMAC_KEYS_JSON: "{not valid json" }, async () => {
    const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
    const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
    check("[12] a malformed keyring is a server-config failure, never a client auth failure", !result.ok && result.kind === "server" && result.reason === "keyring_malformed");
  });

  // [13] missing keyring -> server unavailable
  await withEnv({ RUNS_GOVERNANCE_HMAC_KEYS_JSON: undefined }, async () => {
    const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
    const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
    check("[13] a missing keyring is a server-config failure, never a client auth failure", !result.ok && result.kind === "server" && result.reason === "keyring_not_configured");
  });

  // [14] base64 key decoding / minimum length enforced
  await withEnv({ RUNS_GOVERNANCE_HMAC_KEYS_JSON: JSON.stringify({ [`${CALLER_ID}:${KEY_ID}`]: Buffer.alloc(16, 1).toString("base64") }) }, async () => {
    const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: Buffer.alloc(16, 1).toString("base64") });
    const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
    check("[14] a configured key shorter than 32 bytes is a server-config failure", !result.ok && result.kind === "server" && result.reason === "key_invalid");
  });

  // [16] no secret appears in any returned error/result
  await withEnv({ RUNS_GOVERNANCE_HMAC_KEYS_JSON: keyring }, async () => {
    const headers = signedHeaders({ method, pathname, body, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
    headers[GOVERNANCE_HEADER_SIGNATURE] = "f".repeat(64);
    const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), body, now);
    const serialized = JSON.stringify(result);
    check(
      "[16] no secret key material appears in the verifier's returned result",
      !result.ok && !serialized.includes(KEY_B64) && !serialized.includes(SECOND_KEY_B64)
    );
  });

  // [17] body size: a request whose actual bytes exceed the limit is
  // rejected with payload_too_large, independent of any Content-Length
  // header (the post-read check is authoritative, not advisory).
  await withEnv({ RUNS_GOVERNANCE_HMAC_KEYS_JSON: keyring }, async () => {
    const oversizedBody = Buffer.alloc(GOVERNANCE_MAX_BODY_BYTES + 1, 0x41);
    const headers = signedHeaders({ method, pathname, body: oversizedBody, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
    const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), oversizedBody, now);
    check("[17] an oversized actual body is rejected as payload_too_large", !result.ok && result.kind === "client" && result.reason === "payload_too_large");
  });

  // [18] body size: a body exactly at the limit still verifies normally —
  // the limit rejects strictly-greater-than, not greater-or-equal.
  await withEnv({ RUNS_GOVERNANCE_HMAC_KEYS_JSON: keyring }, async () => {
    const paddedBody = Buffer.concat([body, Buffer.alloc(GOVERNANCE_MAX_BODY_BYTES - body.length, 0x20)]);
    const headers = signedHeaders({ method, pathname, body: paddedBody, timestamp, callerId: CALLER_ID, keyId: KEY_ID, keyB64: KEY_B64 });
    const result = verifyGovernanceSignedRequest(makeRequest(method, pathname, headers), paddedBody, now);
    check(
      "[18] a body exactly at the 64 KiB limit still verifies normally",
      result.ok === true && paddedBody.length === GOVERNANCE_MAX_BODY_BYTES
    );
  });

  // [19] Content-Length pre-check: a declared length over the limit is
  // flagged by exceedsDeclaredContentLength() regardless of the actual body
  // (this is the pure pre-read function routes call before ever reading the
  // body — see governancePreflightRoute.test.ts / governanceCompleteRoute.test.ts
  // for the route-level proof that this actually short-circuits before
  // deps.verify() is reached).
  {
    const oversizedDeclared = makeRequest(method, pathname, { "content-length": String(GOVERNANCE_MAX_BODY_BYTES + 1) });
    check("[19] a declared Content-Length over the limit is flagged by the pre-read check", exceedsDeclaredContentLength(oversizedDeclared));

    const withinDeclared = makeRequest(method, pathname, { "content-length": String(GOVERNANCE_MAX_BODY_BYTES) });
    check("[19] a declared Content-Length at or under the limit is not flagged", !exceedsDeclaredContentLength(withinDeclared));

    const absentDeclared = makeRequest(method, pathname, {});
    check("[19] an absent Content-Length is not flagged by the pre-read check (it is advisory, not authoritative)", !exceedsDeclaredContentLength(absentDeclared));
  }

  console.log(`RUNS_GOVERNANCE_AUTH_TESTS=${checks.length}/${checks.length}`);

}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
