// =========================
// Root Yolna — Runs Governance HTTP Client (SOR-138 Slice 3A-1)
// =========================
//
// Transport/authentication foundation ONLY. This file is not called from
// anywhere in the live Integration execution path yet (that is SOR-138
// Slice 3A-2's job, wiring it into core/tact-integration/execution.ts's
// validateReadExecutionPreconditions). Until then this module is dead,
// unreferenced production infrastructure except through its own tests and
// the standalone Runs HTTP routes it talks to.
//
// Scope boundary (absolute condition, SOR-135): this file may import
// @tact/execution-contract and Node crypto/fetch only. It must NOT import
// Runs DB/store code (packages/runs-core/**'s store/database modules), and
// it must NOT live under core/tact-integration/providers/composio — a
// provider adapter must remain unaware that Runs governance exists at all.
// The dependency direction is core/tact-integration/execution.ts -> {this
// file, ./gateway.ts} as siblings; neither sibling may import the other.
//
// Why a new S2S mechanism instead of reusing an existing one (SOR-138
// Slice 3 design audit, "S2S AUTH AUDIT"):
//   - RUNS_PROJECTION_INGESTION_TOKEN (products/yolna-runs/lib/projection/
//     ingestionAuth.ts) is a single global shared bearer secret with no
//     per-request signature and no tenant scoping at all — the caller
//     supplies userId as a free body field, unchecked against the token.
//     Exactly the "unauthenticated body chooses the tenant" shape this
//     governance boundary must never have.
//   - The existing signed-telemetry HMAC mechanism (products/yolna-runs/
//     lib/telemetry/executionTelemetry.ts) has the right crypto properties
//     (HMAC-SHA256, content digest, freshness window) but the wrong
//     cardinality: one tact_telemetry_sources row is structurally bound to
//     exactly one user_id. Governance Preflight/Complete needs one
//     deployment-level caller acting on behalf of MANY different tenant
//     userIds, one per call — the opposite shape.
// This module generalizes the signed-telemetry HMAC *pattern* (canonical
// string, content digest, freshness window, constant-time compare) without
// reusing its table or its single-tenant-per-source assumption. The
// trusted tenant userId travels as a field INSIDE the signed envelope
// body (GovernancePreflightEnvelope.onBehalfOfUserId /
// GovernanceCompleteEnvelope.onBehalfOfUserId) — integrity-protected by
// the signature covering the whole body, never read before that signature
// is verified (see products/yolna-runs/lib/governance/
// runsGovernanceAuth.ts, the only verifier, and @tact/execution-contract's
// own header comment on this envelope shape).
//
// No retries in this client (absolute condition). A caller that wants
// application-level idempotent retry may add it deliberately later, at a
// layer that understands the difference between "safe to retry" (Preflight,
// Complete — both are idempotent at the Core contract level) and "never
// retry a provider action" — this file must never be the thing that makes
// that distinction blurry by retrying transparently underneath a caller
// who did not ask for it.

import { createHash, createHmac } from "node:crypto";
import {
  buildGovernanceSignatureCanonicalString,
  GOVERNANCE_HEADER_CALLER_ID,
  GOVERNANCE_HEADER_CONTENT_SHA256,
  GOVERNANCE_HEADER_KEY_ID,
  GOVERNANCE_HEADER_SIGNATURE,
  GOVERNANCE_HEADER_TIMESTAMP,
  type CompleteResult,
  type CompleteResultStatus,
  type GovernanceCompleteEnvelope,
  type GovernancePreflightEnvelope,
  type PreflightResponse,
  type PreflightVerdict,
} from "@tact/execution-contract";

// =========================
// Config
// =========================

export interface RunsGovernanceSigningConfig {
  baseUrl: string;
  callerId: string;
  keyId: string;
  // Decoded key material (>= 32 bytes, enforced by loadRunsGovernanceConfig).
  hmacKey: Buffer;
}

export type RunsGovernanceConfigResult =
  | { ok: true; config: RunsGovernanceSigningConfig }
  | { ok: false; reason: "missing_base_url" | "missing_caller_id" | "missing_key_id" | "missing_hmac_key" | "hmac_key_not_base64" | "hmac_key_too_short" };

const MIN_HMAC_KEY_BYTES = 32;

// Reads RUNS_GOVERNANCE_BASE_URL / RUNS_GOVERNANCE_CALLER_ID /
// RUNS_GOVERNANCE_KEY_ID / RUNS_GOVERNANCE_HMAC_KEY from process.env.
// Never logs the decoded key, and never throws — every failure mode
// returns a typed `ok: false` result so a caller can fail closed to an
// "unconfigured" client result instead of crashing.
export function loadRunsGovernanceConfig(env: NodeJS.ProcessEnv = process.env): RunsGovernanceConfigResult {

  const baseUrl = env.RUNS_GOVERNANCE_BASE_URL;
  if (!baseUrl) return { ok: false, reason: "missing_base_url" };

  const callerId = env.RUNS_GOVERNANCE_CALLER_ID;
  if (!callerId) return { ok: false, reason: "missing_caller_id" };

  const keyId = env.RUNS_GOVERNANCE_KEY_ID;
  if (!keyId) return { ok: false, reason: "missing_key_id" };

  const rawKey = env.RUNS_GOVERNANCE_HMAC_KEY;
  if (!rawKey) return { ok: false, reason: "missing_hmac_key" };

  let hmacKey: Buffer;
  try {
    hmacKey = Buffer.from(rawKey, "base64");
  } catch {
    return { ok: false, reason: "hmac_key_not_base64" };
  }

  // Buffer.from(..., "base64") does not throw on non-base64 input; it
  // silently drops invalid characters, which can produce a short buffer
  // from garbage input. The length floor below is this function's actual
  // validity check, not the try/catch above.
  if (hmacKey.length < MIN_HMAC_KEY_BYTES) {
    return { ok: false, reason: "hmac_key_too_short" };
  }

  return { ok: true, config: { baseUrl, callerId, keyId, hmacKey } };

}

// =========================
// Signing
// =========================

// Plain Record, not a named-property interface: an interface with these
// computed property names has no index signature, so TypeScript refuses to
// assign it to fetch()'s HeadersInit (Record<string, string>) even though
// every value here is a string. The literal header-name constants above
// are still the single source of truth for the actual key strings used
// below — this type only needs to carry "a string-keyed, string-valued
// object" to the fetch call site.
type SignedRequestHeaders = Record<string, string>;

// Exported for the root client's own tests (which inspect exactly what a
// fake fetch received) — not for use outside this module's own HTTP calls.
export function signGovernanceRequestBody(
  config: RunsGovernanceSigningConfig,
  method: string,
  pathname: string,
  bodyBuffer: Buffer,
  now: () => Date = () => new Date()
): SignedRequestHeaders {

  const timestamp = Math.floor(now().getTime() / 1000).toString();
  const bodySha256Hex = createHash("sha256").update(bodyBuffer).digest("hex");

  const canonical = buildGovernanceSignatureCanonicalString({
    method,
    pathname,
    callerId: config.callerId,
    keyId: config.keyId,
    timestamp,
    bodySha256Hex,
  });

  const signature = createHmac("sha256", config.hmacKey).update(canonical, "utf8").digest("hex");

  return {
    [GOVERNANCE_HEADER_CALLER_ID]: config.callerId,
    [GOVERNANCE_HEADER_KEY_ID]: config.keyId,
    [GOVERNANCE_HEADER_TIMESTAMP]: timestamp,
    [GOVERNANCE_HEADER_CONTENT_SHA256]: bodySha256Hex,
    [GOVERNANCE_HEADER_SIGNATURE]: signature,
    "content-type": "application/json",
  };

}

// =========================
// Runtime response-shape validation
// =========================
//
// A non-2xx, malformed, or schema-mismatched HTTP response must never be
// interpreted as a decision. These functions are the only place a raw
// `unknown` JSON body is allowed to become a typed PreflightResponse /
// CompleteResult — every call site below routes through them rather than
// an `as` cast.

const PREFLIGHT_VERDICTS: readonly PreflightVerdict[] = ["ALLOW", "DENY", "APPROVAL_REQUIRED", "UNKNOWN"];
const COMPLETE_RESULT_STATUSES: readonly CompleteResultStatus[] = [
  "linked",
  "already_linked",
  "link_conflict",
  "invocation_not_found",
  "decision_not_found",
  "invalid",
  "unavailable",
  "error",
];

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isValidPreflightResponseShape(value: unknown): value is PreflightResponse {

  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;

  if (typeof v.decisionId !== "string" || v.decisionId.length === 0) return false;
  if (typeof v.invocationId !== "string" || v.invocationId.length === 0) return false;
  if (typeof v.verdict !== "string" || !PREFLIGHT_VERDICTS.includes(v.verdict as PreflightVerdict)) return false;
  if (typeof v.reasonCode !== "string") return false;
  if (typeof v.evaluatorVersion !== "string") return false;
  if (typeof v.policyVersion !== "string") return false;
  if (!isNullableString(v.matchedRuleIdentifier)) return false;

  if (typeof v.approval !== "object" || v.approval === null) return false;
  const approval = v.approval as Record<string, unknown>;
  if (!isNullableString(approval.approvalId)) return false;
  if (approval.status !== null && approval.status !== "approved" && approval.status !== "rejected") return false;

  return true;

}

function isValidCompleteResultShape(value: unknown): value is CompleteResult {

  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;

  if (typeof v.status !== "string" || !COMPLETE_RESULT_STATUSES.includes(v.status as CompleteResultStatus)) return false;
  if (v.executionId !== undefined && typeof v.executionId !== "string") return false;
  if (v.governanceExecutionLinkId !== undefined && typeof v.governanceExecutionLinkId !== "string") return false;
  if (v.outcomeRecorded !== undefined && typeof v.outcomeRecorded !== "boolean") return false;
  if (v.reason !== undefined && typeof v.reason !== "string") return false;

  return true;

}

// =========================
// Client results — discriminated unions, intentionally narrow
// =========================
//
// Absolute condition (SOR-138 Slice 3A-1 instructions): only a
// successfully authenticated/validated HTTP 200 containing a valid
// PreflightResponse may expose a verdict. Config-missing, timeout, network
// error, malformed response, non-2xx, and schema-mismatch ALL collapse
// into the single `unavailable` branch below — there is no field on that
// branch a careless future caller could mistake for a verdict. Do not add
// one. A later caller (SOR-138 Slice 3A-2) must still separately check
// `response.verdict === "ALLOW"` even within the `decided` branch — this
// client does not make that decision either.

export type GovernanceClientUnavailableReason =
  | "unconfigured"
  | "network_error"
  | "timeout"
  | "malformed_response"
  | "invalid_response_shape"
  | "non_2xx";

export interface GovernanceClientUnavailable {
  status: "unavailable";
  reason: GovernanceClientUnavailableReason;
  httpStatus?: number;
}

export type PreflightClientResult =
  | { status: "decided"; response: PreflightResponse }
  | GovernanceClientUnavailable;

export type CompleteClientResult =
  | { status: "completed"; result: CompleteResult }
  | GovernanceClientUnavailable;

// =========================
// HTTP calls
// =========================

const DEFAULT_TIMEOUT_MS = 5_000;

export interface RunsGovernanceClientDeps {
  fetchImpl: typeof fetch;
  now: () => Date;
  timeoutMs: number;
  loadConfig: typeof loadRunsGovernanceConfig;
}

const defaultDeps: RunsGovernanceClientDeps = {
  fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => new Date(),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  loadConfig: loadRunsGovernanceConfig,
};

async function postSignedJson(
  pathname: string,
  bodyObject: unknown,
  deps: RunsGovernanceClientDeps
): Promise<{ ok: true; httpStatus: number; json: unknown } | { ok: false; result: GovernanceClientUnavailable }> {

  const configResult = deps.loadConfig();
  if (!configResult.ok) {
    return { ok: false, result: { status: "unavailable", reason: "unconfigured" } };
  }

  const bodyBuffer = Buffer.from(JSON.stringify(bodyObject), "utf-8");
  const headers = signGovernanceRequestBody(configResult.config, "POST", pathname, bodyBuffer, deps.now);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), deps.timeoutMs);

  let response: Response;
  try {
    response = await deps.fetchImpl(`${configResult.config.baseUrl}${pathname}`, {
      method: "POST",
      headers,
      body: bodyBuffer,
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return { ok: false, result: { status: "unavailable", reason: isAbort ? "timeout" : "network_error" } };
  } finally {
    clearTimeout(timeoutHandle);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, result: { status: "unavailable", reason: "malformed_response", httpStatus: response.status } };
  }

  return { ok: true, httpStatus: response.status, json };

}

// POST /api/tact/runs/governance/preflight — see
// products/yolna-runs/app/api/tact/runs/governance/preflight/route.ts for
// the server side of this contract.
export async function callRunsGovernancePreflight(
  envelope: GovernancePreflightEnvelope,
  deps: RunsGovernanceClientDeps = defaultDeps
): Promise<PreflightClientResult> {

  const posted = await postSignedJson("/api/tact/runs/governance/preflight", envelope, deps);
  if (!posted.ok) return posted.result;

  if (posted.httpStatus !== 200) {
    return { status: "unavailable", reason: "non_2xx", httpStatus: posted.httpStatus };
  }

  const body = posted.json as Record<string, unknown> | null;
  if (!body || body.success !== true || !isValidPreflightResponseShape(body.decision)) {
    return { status: "unavailable", reason: "invalid_response_shape", httpStatus: posted.httpStatus };
  }

  return { status: "decided", response: body.decision };

}

// POST /api/tact/runs/governance/complete — see
// products/yolna-runs/app/api/tact/runs/governance/complete/route.ts.
// `completed` covers every CompleteResult the Core contract can itself
// produce (linked/already_linked/link_conflict/invocation_not_found/
// decision_not_found/invalid), each surfaced over a different HTTP status
// by the route — this client treats all of those as "we got a real typed
// answer from Core", distinct from a transport-level failure where no
// CompleteResult was ever computed (auth failure, timeout, 503, ...).
export async function callRunsGovernanceComplete(
  envelope: GovernanceCompleteEnvelope,
  deps: RunsGovernanceClientDeps = defaultDeps
): Promise<CompleteClientResult> {

  const posted = await postSignedJson("/api/tact/runs/governance/complete", envelope, deps);
  if (!posted.ok) return posted.result;

  if (posted.httpStatus !== 200 && posted.httpStatus !== 400 && posted.httpStatus !== 404 && posted.httpStatus !== 409) {
    return { status: "unavailable", reason: "non_2xx", httpStatus: posted.httpStatus };
  }

  const body = posted.json as Record<string, unknown> | null;
  if (!body || body.success !== true || !isValidCompleteResultShape(body.result)) {
    return { status: "unavailable", reason: "invalid_response_shape", httpStatus: posted.httpStatus };
  }

  return { status: "completed", result: body.result };

}
