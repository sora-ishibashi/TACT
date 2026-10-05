import { NextRequest, NextResponse } from "next/server";
import {
  listOwnedPermissionRules,
  listExecutionsForUser,
  listPermissionDecisionsForExecution,
  listDownstreamPermissionEvidenceForExecution,
} from "@tact/runs-core/tact-execution";
import { buildPermissionManagementScopes } from "@tact/runs-core/tact-runs-view/permissionManagement";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/runs/permission-management (SOR-187)
// =========================
//
// 既存read boundary(listOwnedPermissionRules/listExecutionsForUser/
// listPermissionDecisionsForExecution/listDownstreamPermissionEvidenceForExecution、
// いずれもSOR-47/50/51/177で確立済み)を読み、pure projection
// (buildPermissionManagementScopes())へ通すだけ——permission/downstream
// comparisonの再判定はこのRoute自身では一切行わない。
//
// 絶対条件(SOR-187指示「無制限N+1にしない」): recent executionsを
// RECENT_EXECUTIONS_LIMITでbound——そのexecution集合に対してのみ
// decision/evidenceを読む(無制限なN+1ではない、boundedなN+1)。

const RECENT_EXECUTIONS_LIMIT = 50;

export async function GET(request: NextRequest) {

  try {

    const { userId } = await getCurrentUserContext(request);

    if (!userId) {
      return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
    }

    const [rules, executions] = await Promise.all([
      listOwnedPermissionRules(userId),
      listExecutionsForUser(userId, { limit: RECENT_EXECUTIONS_LIMIT }),
    ]);

    const perExecution = await Promise.all(
      executions.map(async (execution) => {
        const [decisions, evidence] = await Promise.all([
          listPermissionDecisionsForExecution(execution.id),
          listDownstreamPermissionEvidenceForExecution(execution.id, userId),
        ]);
        return { executionId: execution.id, decisions, evidence };
      })
    );

    const decisionsByExecutionId = new Map(perExecution.map((row) => [row.executionId, row.decisions]));
    const evidenceByExecutionId = new Map(perExecution.map((row) => [row.executionId, row.evidence]));

    const scopes = buildPermissionManagementScopes({
      rules,
      executions,
      decisionsByExecutionId,
      evidenceByExecutionId,
    });

    return NextResponse.json({ success: true, scopes });

  } catch (error) {

    console.error("[api/tact/runs/permission-management]", error);

    return NextResponse.json({ success: false, error: "failed to load permission management view" }, { status: 500 });

  }

}
