import { NextRequest, NextResponse } from "next/server";
import { listCaptureGaps, listCurrentObservationSurfaces } from "@tact/runs-core/tact-execution";
import type { ConnectionReadState, PublicConnection } from "@tact/runs-core/tact-runs-view/coverageManagement";
import type { ConnectionProjectionItem } from "@tact/execution-contract";
import { postgresConnectionProjectionRepository } from "@/lib/projection/postgresConnectionProjectionAdapter";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// SOR-212: `connectionReadState`/`connections` now read this
// deployment's own Connection projection
// (lib/projection/postgresConnectionProjectionAdapter.ts, backed by
// tact_runs_connection_projection / tact_runs_connection_projection_state —
// never root Yolna's core/tact-integration/connection.ts or
// tact_connections directly; that boundary is unchanged from SOR-187).
//
// Absolute condition (SOR-212, unchanged from SOR-187's own absolute
// condition): `connectionReadState` is derived ONLY from whether a state
// row exists for this user (getSnapshotState().readState) — never from
// `connections.length === 0`. A user whose snapshot legitimately contains
// zero Connections still reports "available".
function toPublicConnection(item: ConnectionProjectionItem): PublicConnection {
  return {
    id: item.externalConnectionId,
    service: item.service,
    status: item.status,
    provider: item.provider,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await getCurrentUserContext(request);
    if (!userId) return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });

    const [surfaces, gaps] = await Promise.all([listCurrentObservationSurfaces(userId), listCaptureGaps(userId)]);

    let connectionReadState: ConnectionReadState = "unavailable";
    let connections: PublicConnection[] = [];

    // A Connection projection read failure (e.g. service role unconfigured,
    // transient DB error) must not take down this whole endpoint — surfaces
    // /gaps are independently valid and should still render. Fail closed to
    // "unavailable" (never fabricate "available") and log for diagnosis.
    try {
      const snapshotState = await postgresConnectionProjectionRepository.getSnapshotState(userId);
      if (snapshotState.readState === "available") {
        connectionReadState = "available";
        const items = await postgresConnectionProjectionRepository.listConnectionsForUser(userId);
        connections = items.map(toPublicConnection);
      }
    } catch (error) {
      console.error("[api/tact/runs/coverage] connection projection read failed; reporting unavailable", error);
    }

    return NextResponse.json({ success: true, surfaces, gaps, connectionReadState, connections });
  } catch (error) {
    console.error("[api/tact/runs/coverage]", error);
    return NextResponse.json({ success: false, error: "failed to load observation coverage" }, { status: 500 });
  }
}
