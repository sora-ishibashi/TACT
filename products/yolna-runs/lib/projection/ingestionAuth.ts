// =========================
// Yolna Runs Standalone — Projection Ingestion Auth Seam (SOR-135 Phase 4A)
// =========================
//
// Authentication for POST /api/tact/runs/ingest/** (the Yolna -> Runs
// projection write path — see packages/execution-contract's
// WorkProjectionWriter/ConversationLinkProjectionWriter and
// lib/projection/postgresProjectionAdapter.ts, the Phase 3 implementation
// these endpoints call into).
//
// Scope of what this file does and does not do (explicit security
// handoff, per SOR-135 Phase 4A section 13 instructions):
//   - DOES: verify a shared-secret bearer token, constant-time compared,
//     never logged. Fails closed if the token is not configured — an
//     unconfigured deployment rejects every ingestion request, it does
//     not fall open to accepting unauthenticated writes.
//   - DOES NOT: request signing, nonce/timestamp-based replay prevention,
//     or key rotation. These are SOR-8's (SEC-P1: Execution Integrity +
//     Realtime Permission Monitoring) responsibility. This is a deliberate
//     scope boundary, not an oversight — do not expand this file to cover
//     them without SOR-8 review.
//
// Caller is Yolna (a separate deployment/process once Phase 4B's cloud
// separation lands); there is no Runs Supabase Auth session to check here
// the way the browser-facing /api/tact/runs/** routes do via
// getCurrentUserContext() — this is a server-to-server credential, not a
// user session.

import { timingSafeEqual } from "node:crypto";

function constantTimeEquals(a: string, b: string): boolean {

  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");

  if (bufA.length !== bufB.length) {
    // Still touch timingSafeEqual on same-length buffers to avoid a
    // length-driven short-circuit being the only timing signal; comparing
    // bufA against itself keeps the branch cost similar without ever
    // claiming a false match.
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);

}

export interface IngestionAuthResult {
  authorized: boolean;
  reason?: "token_not_configured" | "missing_authorization_header" | "token_mismatch";
}

export function verifyIngestionRequest(request: Request): IngestionAuthResult {

  const configuredToken = process.env.RUNS_PROJECTION_INGESTION_TOKEN;

  if (!configuredToken) {
    return { authorized: false, reason: "token_not_configured" };
  }

  const header = request.headers.get("authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return { authorized: false, reason: "missing_authorization_header" };
  }

  const presentedToken = header.slice("Bearer ".length).trim();

  if (!constantTimeEquals(presentedToken, configuredToken)) {
    return { authorized: false, reason: "token_mismatch" };
  }

  return { authorized: true };

}
