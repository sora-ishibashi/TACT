import { NextRequest, NextResponse } from "next/server";

import { listExecutionsForWork, listExecutionAttentions, listLatestCorrelationDecisionsForExecutions } from "@tact/runs-core/tact-execution";
import { getWorkViaRegistry } from "@tact/runs-core/tact-execution/projection/registry";
import { toWorkHeaderView, toWorkTimelineItemView } from "@tact/runs-core/tact-runs-view";

import { getCurrentUserContext } from "@/core/auth/getUserContext";
// SOR-135 Phase 2 (Standalone Runs): see activity/route.ts's identical
// note — no Yolna compatibility adapter here, getWorkViaRegistry() below
// fails closed with a 503 until a Runs-owned projection store exists
// (Phase 3).

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

    // getWorkViaRegistry()はrequest-scoped accessTokenでtenant/所有権を
    // 検証する既存契約(WorkProjectionRepository実装側、root Yolna
    // applicationではcore/tact-work/store.ts)——このRoute自身は所有権
    // 判定ロジックを持たない。Fail closed, not fail silent: no
    // WorkProjectionRepository registered (standalone Runs before SOR-135
    // Phase 3) must not be mistaken for "this Work does not exist".
    let work;

    try {
      work = await getWorkViaRegistry(workId, userId, accessToken);
    } catch (error) {
      console.error("[api/tact/runs/work/[workId]] Work projection unavailable", error);
      return NextResponse.json({ success: false, error: "work projection unavailable" }, { status: 503 });
    }

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
