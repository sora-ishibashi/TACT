import { NextRequest, NextResponse } from "next/server";

import { postgresConnectionProjectionWriter } from "@/lib/projection/postgresConnectionProjectionAdapter";
import { verifyIngestionRequest } from "@/lib/projection/ingestionAuth";
import { validateConnectionProjectionSnapshotInput } from "@/lib/projection/ingestionValidation";

// =========================
// POST /api/tact/runs/ingest/connections (SOR-212)
// =========================
//
// The Yolna -> Runs Connection projection write path's fixed transport —
// same authenticated shared-secret boundary as
// /api/tact/runs/ingest/work and /api/tact/runs/ingest/conversation-link
// (lib/projection/ingestionAuth.ts's verifyIngestionRequest(), reusing the
// existing RUNS_PROJECTION_INGESTION_TOKEN; no separate auth mechanism
// added here). Runs never receives a direct DB connection or service-role
// credential from Yolna, and Yolna never receives Runs' service-role
// credential.
//
// This endpoint is a FULL SNAPSHOT replace, not an incremental upsert —
// see @tact/execution-contract's ConnectionProjectionWriter.replaceSnapshot
// and this app's own
// supabase/migrations/20270101000017_create_tact_runs_connection_projection.sql
// for why Connection needs this (distinguishing "never snapshotted" from
// "snapshotted, zero rows").
//
// Called by core/tact-integration/connectionProjection.ts (root Yolna,
// server-only) after a Connection create/confirm/disconnect canonical
// operation succeeds. Best-effort on the caller's side — a failure here
// never rolls back that canonical operation (see that file's own header
// comment).

export async function POST(request: NextRequest) {

  const auth = verifyIngestionRequest(request);

  if (!auth.authorized) {
    // Reason is a fixed enum tag, never a secret value.
    return NextResponse.json({ success: false, error: `unauthorized (${auth.reason})` }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "malformed JSON body" }, { status: 400 });
  }

  const validated = validateConnectionProjectionSnapshotInput(body);

  if (!validated.ok || !validated.value) {
    return NextResponse.json({ success: false, error: "invalid payload", details: validated.errors }, { status: 400 });
  }

  try {
    await postgresConnectionProjectionWriter.replaceSnapshot(validated.value);
  } catch (error) {
    console.error("[api/tact/runs/ingest/connections]", error);
    return NextResponse.json({ success: false, error: "failed to replace connection projection snapshot" }, { status: 500 });
  }

  return NextResponse.json({ success: true });

}
