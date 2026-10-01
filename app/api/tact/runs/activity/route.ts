import { NextRequest, NextResponse } from "next/server";

import { listExecutionsForUser, listLatestCorrelationDecisionsForExecutions } from "@tact/runs-core/tact-execution";
import { listWorkTitlesByIdsViaRegistry } from "@tact/runs-core/tact-execution/projection/registry";
import { toActivityItemView } from "@tact/runs-core/tact-runs-view";

import { getCurrentUserContext } from "@/core/auth/getUserContext";
// SOR-135 Phase 2 (Runs isolation): side-effect-only import. This root
// Yolna route reads Work titles through the product-neutral projection
// registry (listWorkTitlesByIdsViaRegistry, above) instead of Yolna's
// tact-work store directly — importing this module registers the real
// Yolna-backed WorkProjectionRepository so that read actually resolves
// data here. The standalone Runs application (products/yolna-runs) has
// the identical route MINUS this one import, so it fails closed instead
// (no Work projection source configured yet — SOR-135 Phase 3).
import "@/core/tact-execution-yolna-adapter";

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

    // Fail closed, not fail silent: a projection failure (e.g. no
    // WorkProjectionRepository registered, as in the standalone Runs
    // application before SOR-135 Phase 3) must not be mistaken for "no
    // Work titles exist" — surface it as a clear 503 instead of a
    // misleadingly empty title map.
    let workTitles: Map<string, string | null>;

    try {
      workTitles = await listWorkTitlesByIdsViaRegistry(workIds, userId, accessToken);
    } catch (error) {
      console.error("[api/tact/runs/activity] Work title projection unavailable", error);
      return NextResponse.json({ success: false, error: "work projection unavailable" }, { status: 503 });
    }

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
