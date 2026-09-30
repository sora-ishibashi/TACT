import { NextRequest, NextResponse } from "next/server";

import { listObservationCapabilities } from "@/core/tact-execution";
import type { ExecutionActionCategory, ExecutionProvider } from "@/core/tact-execution";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/execution/observation-registry (SOR-14)
// =========================
//
// 読み取り専用。tact_execution_observation_registry(SOR-14)を返す
// だけで、permissionの再評価やCanonical Executionの再解釈は一切
// 行わない。このtableはtenant固有データを持たない(system-wide
// capability宣言)ため、userIdによるfilteringは行わないが、未認証
// requestは拒否する(app/api/tact/runs/activity/route.tsと同じ
// TRUST BOUNDARY)。SOR-131が読む前提のoutputであり、Execution
// Router/巨大Connector Catalogではない。

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
}

export async function GET(request: NextRequest) {

  try {

    const { userId } = await getCurrentUserContext(request);

    if (!userId) {
      return unauthorizedResponse();
    }

    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") as ExecutionProvider | null;
    const actionCategory = searchParams.get("actionCategory") as ExecutionActionCategory | null;

    const capabilities = await listObservationCapabilities({
      provider: provider ?? undefined,
      actionCategory: actionCategory ?? undefined,
    });

    return NextResponse.json({ success: true, capabilities });

  } catch (error) {

    console.error("[api/tact/execution/observation-registry]", error);

    return NextResponse.json({ success: false, error: "failed to load observation registry" }, { status: 500 });

  }

}
