import { NextRequest, NextResponse } from "next/server";
import { listCaptureGaps, listCurrentObservationSurfaces } from "@tact/runs-core/tact-execution";
import type { PublicConnection } from "@tact/runs-core/tact-runs-view/coverageManagement";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// SOR-187: `connections` is added additively, alongside the existing
// `{ surfaces, gaps }` shape (no existing field removed/renamed). It is
// always [] today — the standalone products/yolna-runs application has no
// reachable Connection data source (see coverageManagement.ts's header
// comment: core/tact-integration/connection.ts and its tact_connections
// table are outside this app's import/DB boundary, confirmed via
// scripts/verify/standaloneForbiddenImports.ts and the "Cross-product FK
// removal" migration comment). This is not fabricated data — the UI must
// render an empty list as "connection unavailable", never as "no
// connections exist".
export async function GET(request: NextRequest) {
  try {
    const { userId } = await getCurrentUserContext(request);
    if (!userId) return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
    const [surfaces, gaps] = await Promise.all([listCurrentObservationSurfaces(userId), listCaptureGaps(userId)]);
    const connections: PublicConnection[] = [];
    return NextResponse.json({ success: true, surfaces, gaps, connections });
  } catch (error) {
    console.error("[api/tact/runs/coverage]", error);
    return NextResponse.json({ success: false, error: "failed to load observation coverage" }, { status: 500 });
  }
}
