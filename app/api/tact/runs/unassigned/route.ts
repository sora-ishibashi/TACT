import { NextRequest, NextResponse } from "next/server";

import { listExecutionsForUser, listLatestCorrelationMethodsForExecutions } from "@/core/tact-execution";
import { toActivityItemView } from "@/core/tact-runs-view";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/runs/unassigned (SOR-46 Unassigned/Ambiguous read surface)
// =========================
//
// 絶対条件(SOR-46指示「Reuse the existing canonical Execution /
// correlation state. Do not create duplicate state or a parallel queue
// model」): 新しいread model/tableは作らない。既存のlistExecutionsForUser()
// (SOR-54)へcorrelationStatusesを渡して絞り込むだけで、返す形も既存の
// Activity screenと同じtoActivityItemView()をそのまま再利用する
// (correlationStatus/workId等は既にこのview形に含まれている)。

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
}

export async function GET(request: NextRequest) {

  try {

    const { userId } = await getCurrentUserContext(request);

    if (!userId) {
      return unauthorizedResponse();
    }

    const executions = await listExecutionsForUser(userId, {
      correlationStatuses: ["unresolved", "ambiguous"],
    });

    // SOR-77 (consistency with /api/tact/runs/activity's same hotfix): a
    // "Keep Unassigned" item is UNASSIGNED but still human-corrected — carry
    // that distinction through here too, even though this list's existing
    // Review affordance is already unconditional for non-CORRELATED rows.
    const latestMethods = await listLatestCorrelationMethodsForExecutions(executions.map((e) => e.id));

    return NextResponse.json({
      success: true,
      items: executions.map((execution) =>
        toActivityItemView(execution, latestMethods.get(execution.id) === "manual_override")
      ),
    });

  } catch (error) {

    console.error("[api/tact/runs/unassigned]", error);

    return NextResponse.json({ success: false, error: "failed to load unassigned executions" }, { status: 500 });

  }

}
