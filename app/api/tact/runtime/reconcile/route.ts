import { NextRequest, NextResponse } from "next/server";

import { getCurrentUserContext } from "@/core/auth/getUserContext";
import { reconcileOneShotIntegrationRead } from "@/core/tact-runtime/reconcileOneShotEntrypoint";

// =========================
// POST /api/tact/runtime/reconcile
// (Fast Port P5d: Add Minimal One-Shot Reconciliation Entrypoint)
// =========================
//
// 責務: 認証済みTACT userが、自分が所有する1件のRunに対してのみ、
// 既存core/tact-runtime/reconciliation.tsのreconcileRuntimeExecution()
// をon-demandで1回だけ起動できる最小entrypoint。
//
// 絶対条件:
//   - 新しいadmin secret/service role bypassは追加しない。認証は
//     既存の/api/tact/conversation等と全く同じ、通常のTACT user
//     Authorization: Bearer <access_token>のみ(getCurrentUserContext()、
//     既存関数を再利用するだけ)。
//   - body.userId/body.actionのような、caller入力からuserId/actionを
//     受け取るfieldは存在しない——所有者判定・action再構成は
//     core/tact-runtime/reconcileOneShotEntrypoint.ts側がDBから行う。
//   - Run IDだけを渡せば誰でも実行できる設計にしない(所有者チェックは
//     reconcileOneShotIntegrationRead()内部のowner-scoped queryが担う。
//     他user所有のworkId/taskId/runIdを指定した場合はnot_foundになる)。
//   - このroute自身はTrigger.dev SDK/Composio Adapter/Supabase service
//     role keyのいずれも直接扱わない(全て既存の合成関数へ委譲)。
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
    const runId = body?.runId;

    if (
      typeof workId !== "string" || !workId ||
      typeof taskId !== "string" || !taskId ||
      typeof runId !== "string" || !runId
    ) {

      return NextResponse.json(
        { success: false, error: "workId, taskId and runId are required" },
        { status: 400 }
      );

    }

    const result = await reconcileOneShotIntegrationRead({
      userId,
      accessToken,
      workId,
      taskId,
      runId,
    });

    if (!result.ok) {

      const status = result.reason === "not_found" ? 404 : result.reason === "runtime_unavailable" ? 503 : 409;

      return NextResponse.json(
        { success: false, error: result.reason },
        { status }
      );

    }

    return NextResponse.json({
      success: true,
      outcome: result.outcome,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );

  }

}
