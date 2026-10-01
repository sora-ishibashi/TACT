import { NextRequest, NextResponse } from "next/server";

import { postgresConversationLinkProjectionWriter } from "@/lib/projection/postgresProjectionAdapter";
import { verifyIngestionRequest } from "@/lib/projection/ingestionAuth";
import { validateConversationLinkProjectionUpsertInput } from "@/lib/projection/ingestionValidation";

// =========================
// POST /api/tact/runs/ingest/conversation-link (SOR-135 Phase 4A)
// =========================
//
// See app/api/tact/runs/ingest/work/route.ts's header comment for the
// transport design and explicit SOR-8 security handoff — identical here,
// just the Conversation Link Projection counterpart.

export async function POST(request: NextRequest) {

  const auth = verifyIngestionRequest(request);

  if (!auth.authorized) {
    return NextResponse.json({ success: false, error: `unauthorized (${auth.reason})` }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "malformed JSON body" }, { status: 400 });
  }

  const validated = validateConversationLinkProjectionUpsertInput(body);

  if (!validated.ok || !validated.value) {
    return NextResponse.json({ success: false, error: "invalid payload", details: validated.errors }, { status: 400 });
  }

  try {
    await postgresConversationLinkProjectionWriter.upsertConversationLink(validated.value);
  } catch (error) {
    console.error("[api/tact/runs/ingest/conversation-link]", error);
    return NextResponse.json({ success: false, error: "failed to upsert conversation link projection" }, { status: 500 });
  }

  return NextResponse.json({ success: true });

}
