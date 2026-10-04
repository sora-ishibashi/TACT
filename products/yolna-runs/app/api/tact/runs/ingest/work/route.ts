import { NextRequest, NextResponse } from "next/server";

import { postgresWorkProjectionWriter } from "@/lib/projection/postgresProjectionAdapter";
import { verifyIngestionRequest } from "@/lib/projection/ingestionAuth";
import { validateWorkProjectionUpsertInput } from "@/lib/projection/ingestionValidation";

// =========================
// POST /api/tact/runs/ingest/work (SOR-135 Phase 4A)
// =========================
//
// The Yolna -> Runs projection write path's fixed transport: Yolna calls
// this authenticated endpoint; Runs never receives a direct DB connection
// or service-role credential from Yolna, and Yolna never receives Runs'
// service-role credential (see scripts/verify/rootForbiddenStandaloneImport.ts
// for the static check that Yolna's own source tree cannot reach this
// route's implementation modules directly, and
// scripts/verify/runsClientServerBoundary.ts for the check that no Runs
// browser bundle can reach the service-role client this route eventually
// calls through postgresWorkProjectionWriter).
//
// Local-only this phase: implemented and testable, but not wired to any
// real Yolna caller (no network deployment exists yet to call it — Phase
// 4B+). Request signing / nonce / replay prevention are explicitly SOR-8's
// responsibility, not implemented here — see lib/projection/ingestionAuth.ts.

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

  const validated = validateWorkProjectionUpsertInput(body);

  if (!validated.ok || !validated.value) {
    return NextResponse.json({ success: false, error: "invalid payload", details: validated.errors }, { status: 400 });
  }

  try {
    await postgresWorkProjectionWriter.upsertWork(validated.value);
  } catch (error) {
    console.error("[api/tact/runs/ingest/work]", error);
    return NextResponse.json({ success: false, error: "failed to upsert work projection" }, { status: 500 });
  }

  return NextResponse.json({ success: true });

}
