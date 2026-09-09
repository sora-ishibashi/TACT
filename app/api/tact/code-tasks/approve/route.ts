import { NextRequest, NextResponse } from "next/server";

import { getCodeTask, saveCodeTask } from "@/core/codeAgent/store";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// POST /api/tact/code-tasks/approve
// (STEP142-C: Human Approval Gate、TACT SEC-P0-1で認証必須化)
// =========================
//
// これがTACT Code全体の中で唯一「実行してよい」という状態
// (status: "approved")への遷移を許すエンドポイント。
//
// 重要: このエンドポイントはTACT自身(Workflow/Brain/Optimizer)の
// どこからも自動的には呼び出されない。人間が明示的にこのAPIを
// 呼んだ場合にのみ実行が可能になる、という設計そのものが
// Human Approval Gateである。
//
// TACT SEC-P0-1(Pre-Live Remediation): 従来はこのGate自体に認証が
// 無く、承認者の身元を一切記録していなかった(Pre-Live Full
// Repository Audit P0 finding #1)。認証必須化に加え、対象CodeTaskの
// 所有者(CodeTask.userId)と一致する場合のみ承認できるようにする。
//
// body:
// {
//   id: string  // CodeTask.id
// }

export async function POST(
  request: NextRequest
) {

  try {

    const { userId } = await getCurrentUserContext(request);

    if (!userId) {

      return NextResponse.json(
        { success: false, error: "authentication required" },
        { status: 401 }
      );

    }

    const body = await request.json();

    const id: string | undefined = body.id;

    if (!id) {

      return NextResponse.json(
        { success: false, error: "id is required" },
        { status: 400 }
      );

    }

    const task = await getCodeTask(id, userId);

    if (!task) {

      return NextResponse.json(
        { success: false, error: "task not found" },
        { status: 404 }
      );

    }

    if (
      task.status !== "draft" &&
      task.status !== "ready_for_approval"
    ) {

      return NextResponse.json(
        {
          success: false,
          error:
            `task is in status "${task.status}" and cannot be approved ` +
            `(only "draft" or "ready_for_approval" tasks can be approved)`,
        },
        { status: 409 }
      );

    }

    const approvedTask = {
      ...task,
      status: "approved" as const,
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(approvedTask);

    return NextResponse.json({
      success: true,
      task: approvedTask,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );

  }

}
