// =========================
// Yolna Runs Standalone — Governance Caller Auth Seam (SOR-138 Slice 3A-1)
// =========================
//
// Authentication for POST /api/tact/runs/governance/{preflight,complete}.
// This is a DIFFERENT trust shape from both existing S2S mechanisms in
// this codebase, deliberately:
//
//   - lib/projection/ingestionAuth.ts: single global shared bearer secret,
//     no signature, no tenant scoping (caller-supplied userId trusted at
//     face value). Wrong shape for a governance decision gate — this file
//     never reads or compares against RUNS_PROJECTION_INGESTION_TOKEN.
//   - lib/telemetry/executionTelemetry.ts: HMAC-signed, but each
//     `tact_telemetry_sources` row is bound to exactly one user_id —
//     "one source = one fixed tenant". Governance needs one registered
//     caller (a root Yolna deployment) acting on behalf of MANY different
//     tenant userIds, one per request.
//
// This file generalizes signed-telemetry's HMAC pattern (HMAC-SHA256,
// content digest, freshness window, constant-time compare) without reusing
// its DB table or its single-tenant-per-source assumption. There is no new
// migration in this slice (SOR-138 Slice 3A-1 scope: transport/auth
// foundation only) — the caller/key registry is a single env var,
// RUNS_GOVERNANCE_HMAC_KEYS_JSON, shaped as { "<callerId>:<keyId>":
// "<base64-key>" }, supporting multiple concurrent key ids for rotation.
// A persistent DB-backed caller registry, revocation, or replay-receipt
// table remains future SOR-158 (Root of Trust) work if operationally
// required — not invented here.
//
// Why no nonce/replay-receipt table in this slice (SOR-138 Slice 3 design
// audit, "WHY NO NONCE TABLE"): both Preflight and Complete are already
// idempotent at the Core contract level (Preflight via invocationId;
// Complete via its decision/invocation + Canonical externalEventId/link
// semantics). Neither route itself executes a provider action. A replay of
// an already-signed request inside the freshness window therefore cannot
// generate new authority or a second provider effect — it can only
// re-request an answer the Core contract already knows how to answer
// idempotently. This file does not silently add nonce persistence; if a
// stronger replay guarantee becomes operationally necessary, that is a
// deliberate, reviewed SOR-158 decision, not a default assumed here.
//
// Server auth-config failure vs. client auth failure (absolute condition):
// a missing or malformed RUNS_GOVERNANCE_HMAC_KEYS_JSON, or a configured
// key entry that fails to decode / is too short, is THIS DEPLOYMENT's
// configuration problem — it must never be reported or treated as "the
// caller failed to authenticate". Every return path below is tagged with
// which of the two categories it belongs to; callers (the two governance
// routes) map "client" to 401 and "server" to 503, never the reverse.

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import {
  buildGovernanceSignatureCanonicalString,
  GOVERNANCE_HEADER_CALLER_ID,
  GOVERNANCE_HEADER_CONTENT_SHA256,
  GOVERNANCE_HEADER_KEY_ID,
  GOVERNANCE_HEADER_SIGNATURE,
  GOVERNANCE_HEADER_TIMESTAMP,
} from "@tact/execution-contract";

const CALLER_OR_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const TIMESTAMP_DIGITS = /^\d{1,12}$/;

// Matches the existing signed-telemetry freshness window
// (lib/telemetry/executionTelemetry.ts's FRESHNESS_SECONDS) — same
// operational posture, independent constant (deliberately not imported
// from that file; this boundary must remain free to diverge from
// telemetry's own tuning without a cross-module coupling).
const FRESHNESS_SECONDS = 300;

// 64 KiB — a conservative fixed v1 limit for a Preflight/Complete request
// body, which carries only small structured JSON (no business payload, no
// prompt text — see @tact/execution-contract's own data-minimization
// comments). Exported so route handlers can apply the identical limit as a
// cheap Content-Length pre-check (see exceedsDeclaredContentLength below)
// before ever reading the body — this constant itself is also still the
// authoritative check, applied to the actual raw byte length read, inside
// verifyGovernanceSignedRequest below.
export const GOVERNANCE_MAX_BODY_BYTES = 64 * 1024;

export type GovernanceAuthFailureKind = "client" | "server";

export type GovernanceAuthFailureReason =
  // client
  | "payload_too_large"
  | "missing_headers"
  | "malformed_headers"
  | "content_digest_mismatch"
  | "unknown_caller_key"
  | "signature_invalid"
  | "timestamp_stale"
  | "timestamp_future"
  // server
  | "keyring_not_configured"
  | "keyring_malformed"
  | "key_invalid";

export interface GovernanceAuthFailure {
  ok: false;
  kind: GovernanceAuthFailureKind;
  reason: GovernanceAuthFailureReason;
}

export interface GovernanceAuthSuccess {
  ok: true;
  callerId: string;
  keyId: string;
}

export type GovernanceAuthResult = GovernanceAuthFailure | GovernanceAuthSuccess;

function constantTimeHexEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    // Touch timingSafeEqual on same-length buffers even on the length
    // mismatch path, so a short-circuit length check is never the only
    // timing signal available to a caller probing this boundary.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

type ResolveKeyResult =
  | { ok: true; key: Buffer }
  | { ok: false; kind: GovernanceAuthFailureKind; reason: GovernanceAuthFailureReason };

// Reads RUNS_GOVERNANCE_HMAC_KEYS_JSON fresh on every call (same convention
// as executionTelemetry.ts's own keyFor()) rather than caching it in module
// state, so a rotated/updated env value takes effect without a process
// restart being load-bearing for this function's own correctness.
function resolveGovernanceCallerKey(callerId: string, keyId: string, env: NodeJS.ProcessEnv = process.env): ResolveKeyResult {

  const raw = env.RUNS_GOVERNANCE_HMAC_KEYS_JSON;
  if (!raw) {
    return { ok: false, kind: "server", reason: "keyring_not_configured" };
  }

  let keyring: Record<string, unknown>;
  try {
    keyring = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, kind: "server", reason: "keyring_malformed" };
  }

  if (typeof keyring !== "object" || keyring === null || Array.isArray(keyring)) {
    return { ok: false, kind: "server", reason: "keyring_malformed" };
  }

  const entry = keyring[`${callerId}:${keyId}`];
  if (typeof entry !== "string") {
    // The *pair* is simply not registered — a caller/key reference problem,
    // not a config problem with whatever entries DO exist in an otherwise
    // valid keyring.
    return { ok: false, kind: "client", reason: "unknown_caller_key" };
  }

  let key: Buffer;
  try {
    key = Buffer.from(entry, "base64");
  } catch {
    return { ok: false, kind: "server", reason: "key_invalid" };
  }

  if (key.length < 32) {
    return { ok: false, kind: "server", reason: "key_invalid" };
  }

  return { ok: true, key };

}

// Cheap pre-read defense (Human Owner pre-commit review, SOR-138 Slice
// 3A-1): a route handler calls this BEFORE reading the request body at
// all, so an oversized request never has its body buffered into memory in
// the first place. This is advisory-only, never authoritative — a
// Content-Length header can be absent or cannot be trusted (a client can
// declare any value regardless of what it actually sends) — so
// verifyGovernanceSignedRequest below still independently enforces
// GOVERNANCE_MAX_BODY_BYTES against the actual bytes read, every time, with
// or without this pre-check having run first.
export function exceedsDeclaredContentLength(request: Request, maxBytes: number = GOVERNANCE_MAX_BODY_BYTES): boolean {
  const declared = request.headers.get("content-length");
  if (!declared) {
    return false;
  }
  const declaredBytes = Number(declared);
  return Number.isFinite(declaredBytes) && declaredBytes > maxBytes;
}

// Verifies a governance-signed request. The caller (a route handler) must
// pass the RAW request body bytes read BEFORE any JSON.parse — signature
// verification happens over the exact bytes that were signed, never over a
// re-serialized/re-parsed representation of them.
//
// `now` is injectable for freshness-window tests; defaults to the real
// clock.
export function verifyGovernanceSignedRequest(
  request: Request,
  rawBody: Buffer,
  now: Date = new Date()
): GovernanceAuthResult {

  if (rawBody.length > GOVERNANCE_MAX_BODY_BYTES) {
    return { ok: false, kind: "client", reason: "payload_too_large" };
  }

  const callerId = request.headers.get(GOVERNANCE_HEADER_CALLER_ID);
  const keyId = request.headers.get(GOVERNANCE_HEADER_KEY_ID);
  const timestamp = request.headers.get(GOVERNANCE_HEADER_TIMESTAMP);
  const contentSha256 = request.headers.get(GOVERNANCE_HEADER_CONTENT_SHA256);
  const signature = request.headers.get(GOVERNANCE_HEADER_SIGNATURE);

  if (!callerId || !keyId || !timestamp || !contentSha256 || !signature) {
    return { ok: false, kind: "client", reason: "missing_headers" };
  }

  if (
    !CALLER_OR_KEY_ID.test(callerId) ||
    !CALLER_OR_KEY_ID.test(keyId) ||
    !TIMESTAMP_DIGITS.test(timestamp) ||
    !HEX_64.test(contentSha256) ||
    !HEX_64.test(signature)
  ) {
    return { ok: false, kind: "client", reason: "malformed_headers" };
  }

  const actualBodyHash = createHash("sha256").update(rawBody).digest("hex");
  if (!constantTimeHexEquals(actualBodyHash, contentSha256)) {
    return { ok: false, kind: "client", reason: "content_digest_mismatch" };
  }

  const resolved = resolveGovernanceCallerKey(callerId, keyId);
  if (!resolved.ok) {
    return { ok: false, kind: resolved.kind, reason: resolved.reason };
  }

  const canonical = buildGovernanceSignatureCanonicalString({
    method: request.method,
    pathname: new URL(request.url).pathname,
    callerId,
    keyId,
    timestamp,
    // The header value, not a re-derivation — already proven equal to the
    // actual body hash above, and this is the exact value the signer
    // folded into its own canonical string.
    bodySha256Hex: contentSha256,
  });

  const expectedSignature = createHmac("sha256", resolved.key).update(canonical, "utf8").digest("hex");
  if (!constantTimeHexEquals(expectedSignature, signature)) {
    return { ok: false, kind: "client", reason: "signature_invalid" };
  }

  const timestampMs = Number(timestamp) * 1000;
  const nowMs = now.getTime();

  if (timestampMs < nowMs - FRESHNESS_SECONDS * 1000) {
    return { ok: false, kind: "client", reason: "timestamp_stale" };
  }

  if (timestampMs > nowMs + FRESHNESS_SECONDS * 1000) {
    return { ok: false, kind: "client", reason: "timestamp_future" };
  }

  return { ok: true, callerId, keyId };

}
