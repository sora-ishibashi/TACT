import { NextRequest, NextResponse } from "next/server";

import { listExecutionsForUser, listLatestCorrelationDecisionsForExecutions } from "@/core/tact-execution";
import { listWorkTitlesByIds } from "@/core/tact-work";
import { toActivityItemView } from "@/core/tact-runs-view";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/runs/activity (SOR-54 Screen 1: Activity)
// =========================
//
// 既存read boundary(core/tact-execution.listExecutionsForUser()、
// SOR-54で追加した最小限のquery)を読み、pure projection
// (core/tact-runs-view.toActivityItemView())へ通すだけ——permission/
// correlationの再判定はしない(絶対条件、SOR-54指示「Core Principle」)。
//
// app/api/tact/connections/route.tsと同じTRUST BOUNDARY: userIdは
// getCurrentUserContext(request)経由でのみ解決する。

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
}

export async function GET(request: NextRequest) {

  try {

    const { userId, accessToken } = await getCurrentUserContext(request);

    if (!userId || !accessToken) {
      return unauthorizedResponse();
    }

    const executions = await listExecutionsForUser(userId);

    // SOR-77 live Staging verification UX gap fix: whether Activity should
    // show a Review/History affordance for an already-CORRELATED row is not
    // stored anywhere on tact_canonical_executions (絶対条件、do not add
    // duplicate columns) — derive it from the existing append-only
    // correlation history, batched the same way Attention's workTitle join
    // already does (single .in() query + application-layer grouping).
    const latestDecisions = await listLatestCorrelationDecisionsForExecutions(executions.map((e) => e.id));

    // SOR-23 (OBS-UX-P1 Priority 1): human-readable Work identity — same
    // tenant-safe batch join already used by Attention (SOR-18) and the
    // Correlation Review surface (SOR-77).
    const workIds = executions
      .map((e) => e.workId)
      .filter((id): id is string => id !== null);
    const workTitles = await listWorkTitlesByIds(workIds, userId, accessToken);

    return NextResponse.json({
      success: true,
      items: executions.map((execution) =>
        toActivityItemView(
          execution,
          execution.workId ? workTitles.get(execution.workId) ?? null : null,
          latestDecisions.get(execution.id)?.method === "manual_override"
        )
      ),
    });

  } catch (error) {

    console.error("[api/tact/runs/activity]", error);

    return NextResponse.json({ success: false, error: "failed to load activity" }, { status: 500 });

  }

}
