import { NextRequest, NextResponse } from "next/server";

import { getCodeTask, saveCodeTask } from "@/core/codeAgent/store";

// =========================
// POST /api/tact/code-tasks/approve (STEP142-C: Human Approval Gate)
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
// body:
// {
//   id: string  // CodeTask.id
// }

export async function POST(
  request: NextRequest
) {

  try {

    const body = await request.json();

    const id: string | undefined = body.id;

    if (!id) {

      return NextResponse.json(
        { success: false, error: "id is required" },
        { status: 400 }
      );

    }

    const task = await getCodeTask(id);

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
