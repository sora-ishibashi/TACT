import { NextRequest, NextResponse } from "next/server";
import { listCaptureGaps, listCurrentObservationSurfaces } from "@tact/runs-core/tact-execution";
import type { ConnectionReadState, PublicConnection } from "@tact/runs-core/tact-runs-view/coverageManagement";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// SOR-187 review: `connectionReadState`/`connections` are added
// additively, alongside the existing `{ surfaces, gaps }` shape (no
// existing field removed/renamed). `connectionReadState` is always
// "unavailable" today — the standalone products/yolna-runs application has
// no reachable Connection data source (see coverageManagement.ts's header
// comment: core/tact-integration/connection.ts and its tact_connections
// table are outside this app's import/DB boundary, confirmed via
// scripts/verify/standaloneForbiddenImports.ts and the "Cross-product FK
// removal" migration comment).
//
// Absolute condition: `connections: []` here must never be read by a
// consumer as "zero Connections exist" — `connectionReadState` is the
// explicit signal that the read capability itself does not exist. A real
// Connection read capability (and a real "available" state) is SOR-212's
// responsibility; this route never imports core/tact-integration.
export async function GET(request: NextRequest) {
  try {
    const { userId } = await getCurrentUserContext(request);
    if (!userId) return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
    const [surfaces, gaps] = await Promise.all([listCurrentObservationSurfaces(userId), listCaptureGaps(userId)]);
    const connectionReadState: ConnectionReadState = "unavailable";
    const connections: PublicConnection[] = [];
    return NextResponse.json({ success: true, surfaces, gaps, connectionReadState, connections });
  } catch (error) {
    console.error("[api/tact/runs/coverage]", error);
    return NextResponse.json({ success: false, error: "failed to load observation coverage" }, { status: 500 });
  }
}
