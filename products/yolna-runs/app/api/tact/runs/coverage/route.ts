import { NextRequest, NextResponse } from "next/server";
import { listCaptureGaps, listCurrentObservationSurfaces } from "@tact/runs-core/tact-execution";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

export async function GET(request: NextRequest) {
  try {
    const { userId } = await getCurrentUserContext(request);
    if (!userId) return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
    const [surfaces, gaps] = await Promise.all([listCurrentObservationSurfaces(userId), listCaptureGaps(userId)]);
    return NextResponse.json({ success: true, surfaces, gaps });
  } catch (error) {
    console.error("[api/tact/runs/coverage]", error);
    return NextResponse.json({ success: false, error: "failed to load observation coverage" }, { status: 500 });
  }
}
