import { NextRequest, NextResponse } from "next/server";

import { getExecutionCorrelationView, getExecutionCorrectionContext, resolveTargetWorkForCorrelation } from "@/core/tact-execution";
// SOR-135 Phase 1 (Runs isolation): go through the Yolna compatibility
// adapter, not "@/core/tact-work" directly, so this Runs API route no
// longer has a direct import-graph edge into Yolna's own Work store.
import { listWorkTitlesByIds } from "@/core/tact-execution-yolna-adapter";
import { toCorrelationReviewView, type WorkActionabilityEntry } from "@/core/tact-runs-view";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/runs/execution/[executionId]/correlation
// (SOR-77 CORRELATION-REVIEW-P1: human correction review surface)
// =========================
//
// 絶対条件(SOR-46/74/77指示「thin HTTP wrapper」、reclassify/route.tsと
// 同じ規律): tenant所有権検証はgetExecutionCorrelationView()/
// getExecutionCorrectionContext()/listWorkTitlesByIds()(いずれも既存の
// userId-scoped read function)が担う。このfile自身はuserIdの導出
// (session由来のみ)とoutcomeのHTTP status mappingだけを行う。
//
// 新しいstateやtableは作らない(SOR-77指示「do not add duplicate
// columns if append-only correlation history can derive these values
// reliably」): candidateWorkIds/predicted/correctionはすべて既存の
// tact_execution_work_correlations(append-only history、SOR-52)から
// 導出されたもの。

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ executionId: string }> }
) {

  try {

    const { userId, accessToken } = await getCurrentUserContext(request);

    if (!userId || !accessToken) {
      return unauthorizedResponse();
    }

    const { executionId } = await context.params;

    const [correlation, correctionContext] = await Promise.all([
      getExecutionCorrelationView(executionId, userId),
      getExecutionCorrectionContext(executionId, userId),
    ]);

    if (!correlation || !correctionContext) {
      return NextResponse.json({ success: false, error: "execution not found" }, { status: 404 });
    }

    // 表示に必要なWork idを集める(現在の割当・候補・訂正前後の値)
    // ——重複はSet+listWorkTitlesByIds()自身のdedupで安全に吸収される。
    const referencedWorkIds = [
      correlation.workId,
      ...(correlation.candidateWorkIds ?? []),
      correctionContext.predicted?.workId ?? null,
      ...(correctionContext.predicted?.candidateWorkIds ?? []),
      correctionContext.correction?.finalWorkId ?? null,
      correctionContext.correction?.previousWorkId ?? null,
    ].filter((id): id is string => id !== null);

    const workTitles = await listWorkTitlesByIds(referencedWorkIds, userId, accessToken);

    // SOR-77 live Staging verification defect fix: a candidateWorkId in
    // correlation history is a historical fact, not a live guarantee the
    // Work is still assignable (it may since have been deleted or reached a
    // terminal status). Re-validate each *candidate* (not every referenced
    // id — currentWorkId/finalWorkId/previousWorkId are shown as fact, not
    // offered as an action) against its CURRENT tenant/state using the same
    // check captureExecution()/reclassify_execution_work() already trust
    // (resolveTargetWorkForCorrelation()) — never invent a second notion of
    // "assignable" here.
    const candidateIds = [
      ...new Set([
        ...(correlation.candidateWorkIds ?? []),
        ...(correctionContext.predicted?.candidateWorkIds ?? []),
      ]),
    ];

    const actionabilityEntries = await Promise.all(
      candidateIds.map(async (workId): Promise<[string, WorkActionabilityEntry]> => {

        const resolution = await resolveTargetWorkForCorrelation(workId, userId);

        return [
          workId,
          resolution.ok
            ? { actionable: true, unavailableReason: null }
            : { actionable: false, unavailableReason: resolution.reason },
        ];

      })
    );

    const workActionability = new Map(actionabilityEntries);

    return NextResponse.json({
      success: true,
      correlation: toCorrelationReviewView(correlation, correctionContext, workTitles, workActionability),
    });

  } catch (error) {

    console.error("[api/tact/runs/execution/[executionId]/correlation]", error);

    return NextResponse.json({ success: false, error: "failed to load execution correlation" }, { status: 500 });

  }

}
