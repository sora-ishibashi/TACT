import { NextRequest, NextResponse } from "next/server";

import { listExecutionsForWork, listExecutionAttentions, listLatestCorrelationDecisionsForExecutions } from "@/core/tact-execution";
// SOR-135 Phase 1 (Runs isolation): go through the Yolna compatibility
// adapter, not "@/core/tact-work" directly, so this Runs API route no
// longer has a direct import-graph edge into Yolna's own Work store.
import { getWork } from "@/core/tact-execution-yolna-adapter";
import { toWorkHeaderView, toWorkTimelineItemView } from "@/core/tact-runs-view";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/runs/work/[workId] (SOR-54 Screen 3: Work Detail)
// =========================
//
// 絶対条件(SOR-53/54指示「Important architecture rule」): 別のTimeline
// ledgerを作らない。listExecutionsForWork()(既存、SOR-50)がCanonical
// Execution Ledgerをwork_idでfilterした結果をそのままderived viewへ
// 変換するだけ——work_idはSOR-53のWork Correlationが確定させた場合のみ
// 設定されるため、ambiguous/unassignedのExecutionはこのlistへ
// 構造的に含まれない(絶対条件、SOR-54指示「Work Detail scope」)。

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ workId: string }> }
) {

  try {

    const { userId, accessToken } = await getCurrentUserContext(request);

    if (!userId || !accessToken) {
      return unauthorizedResponse();
    }

    const { workId } = await context.params;

    // getWork()はrequest-scoped client(既存user access token)で
    // tenant/所有権を検証する既存契約(core/tact-work/store.ts)——
    // このRoute自身は所有権判定ロジックを持たない。
    const work = await getWork(workId, userId, accessToken);

    if (!work) {
      return NextResponse.json({ success: false, error: "work not found" }, { status: 404 });
    }

    const executions = await listExecutionsForWork(workId, userId);

    // Attention countは"if easy"(SOR-54指示)。SOR-52のread boundaryを
    // そのまま再利用し(新しいfilter付きqueryを増やさない)、open
    // attentionのうちこのworkIdに一致するものを数えるだけ。
    let attentionCount: number | null = null;

    try {
      const openAttentions = await listExecutionAttentions(userId, { status: "open" });
      attentionCount = openAttentions.filter((item) => item.workId === workId).length;
    } catch {
      // Attention countは補助情報のため、取得失敗してもWork Detail自体は返す。
      attentionCount = null;
    }

    // SOR-23 (OBS-UX-P1 Priority 2 "why was this Execution assigned to this
    // Work"): every row here is already CORRELATED by construction
    // (listExecutionsForWork() only returns work_id-matched rows) — batch
    // the latest correlation decision per execution the same way SOR-77's
    // Activity/Unassigned already do, no new query shape.
    const latestDecisions = await listLatestCorrelationDecisionsForExecutions(executions.map((e) => e.id));

    return NextResponse.json({
      success: true,
      work: toWorkHeaderView(work, executions.length, attentionCount),
      items: executions.map((execution) => toWorkTimelineItemView(execution, latestDecisions.get(execution.id))),
    });

  } catch (error) {

    console.error("[api/tact/runs/work/[workId]]", error);

    return NextResponse.json({ success: false, error: "failed to load work detail" }, { status: 500 });

  }

}
