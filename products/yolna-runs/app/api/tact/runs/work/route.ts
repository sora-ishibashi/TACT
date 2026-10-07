import { NextRequest, NextResponse } from "next/server";
import { listExecutionAttentions, listExecutionsForUser } from "@tact/runs-core/tact-execution";
import { listRecentWorksForUserViaRegistry } from "@tact/runs-core/tact-execution/projection/registry";
import { activeAttentionCountForWork, toAttentionCardView } from "@tact/runs-core/tact-runs-view";
import { getCurrentUserContext } from "@/core/auth/getUserContext";
import "@/lib/projection/postgresProjectionAdapter";

/** Work index: a read-only composition of the canonical Work projection,
 * Execution Ledger, and active Attention read model.  It deliberately does
 * not infer status, correlation, or capture gaps on the client. */
export async function GET(request: NextRequest) {
  try {
    const { userId, accessToken } = await getCurrentUserContext(request);
    if (!userId || !accessToken) return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });

    const [works, executions, attentions] = await Promise.all([
      listRecentWorksForUserViaRegistry(userId, accessToken, { limit: 100 }),
      listExecutionsForUser(userId),
      listExecutionAttentions(userId, { statuses: ["open", "acknowledged"] }),
    ]);
    const executionSummary = new Map<string, { count: number; lastActivity: string | null }>();
    for (const execution of executions) {
      if (!execution.workId) continue;
      const previous = executionSummary.get(execution.workId) ?? { count: 0, lastActivity: null };
      const observedAt = execution.observedAt;
      executionSummary.set(execution.workId, {
        count: previous.count + 1,
        lastActivity: !previous.lastActivity || observedAt > previous.lastActivity ? observedAt : previous.lastActivity,
      });
    }
    const attentionCards = attentions.map(toAttentionCardView);
    return NextResponse.json({
      success: true,
      items: works.map((work) => ({
        workId: work.id,
        title: work.title,
        status: work.status,
        lastActivity: executionSummary.get(work.id)?.lastActivity ?? null,
        executionCount: executionSummary.get(work.id)?.count ?? 0,
        attentionCount: activeAttentionCountForWork(attentionCards, work.id),
      })),
    });
  } catch (error) {
    console.error("[api/tact/runs/work]", error);
    return NextResponse.json({ success: false, error: "failed to load work index" }, { status: 500 });
  }
}
