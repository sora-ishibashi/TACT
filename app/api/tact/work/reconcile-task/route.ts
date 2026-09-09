import { NextRequest, NextResponse } from "next/server";

import { getCurrentUserContext } from "@/core/auth/getUserContext";
import { reconcileStrandedTaskProjection } from "@/core/tact-work/taskRunReconciliation";

// =========================
// POST /api/tact/work/reconcile-task
// (DUR-P1: Stranded Task State Integrity Fix)
// =========================
//
// 責務: 認証済みTACT userが、自分が所有する1件のTaskに対してのみ、
// core/tact-work/taskRunReconciliation.tsのreconcileStrandedTaskProjection()
// をon-demandで1回だけ起動できる最小entrypoint。app/api/tact/runtime/
// reconcile/route.ts(Fast Port P5d)と全く同じ形・同じ絶対条件を踏襲する。
//
// 絶対条件:
//   - 新しいadmin secret/service role bypassは追加しない。認証は既存の
//     通常のTACT user Authorization: Bearer <access_token>のみ
//     (getCurrentUserContext()、既存関数を再利用するだけ)。
//   - body.userIdのような、caller入力からuserIdを受け取るfieldは存在
//     しない——所有者判定はreconcileStrandedTaskProjection()内部の
//     owner-scoped query(getWork/listTasksForWork/listRunsForTask)が
//     担う。他user所有のworkId/taskIdを指定した場合はnot_foundになる。
//   - このroute自身はSupabase service role keyを直接扱わない
//     (既存のtact-work canonical store経由でのみDBへ触れる)。
//   - cron/schedulerからは呼ばれない。operator/クライアントが明示的に
//     1回だけ呼ぶことを想定した最小entrypoint。
export async function POST(
  request: NextRequest
) {

  try {

    const { userId, accessToken } = await getCurrentUserContext(request);

    if (!userId || !accessToken) {

      return NextResponse.json(
        { success: false, error: "authentication required" },
        { status: 401 }
      );

    }

    const body = await request.json();

    const workId = body?.workId;
    const taskId = body?.taskId;

    if (
      typeof workId !== "string" || !workId ||
      typeof taskId !== "string" || !taskId
    ) {

      return NextResponse.json(
        { success: false, error: "workId and taskId are required" },
        { status: 400 }
      );

    }

    const outcome = await reconcileStrandedTaskProjection(workId, userId, accessToken, taskId);

    if (outcome.status === "not_found") {

      return NextResponse.json(
        { success: false, error: "not_found" },
        { status: 404 }
      );

    }

    return NextResponse.json({
      success: true,
      outcome,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );

  }

}
