import { NextRequest, NextResponse } from "next/server";

import { getCodeTask, saveCodeTask } from "@/core/codeAgent/store";
import { getGitProvider } from "@/core/codeAgent/gitProvider";

// =========================
// POST /api/tact/code-tasks/commit (STEP144-F)
// =========================
//
// execute()が status: "completed" まで到達し、commitCandidateを
// 生成した後にのみ呼べる、**別のHuman Approvalゲート**。
// execute()自体はcommitを行わない(実装+Test+Evaluationまでで停止する)。
// commitするかどうかは、人間がこのAPIを明示的に呼ぶことで決める。
//
// pushはここでは行わない(POST /api/tact/code-tasks/pushが別ゲート)。
//
// body:
// {
//   id: string,
//   message?: string  // 省略時はcommitCandidate.suggestedMessageを使う
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

    if (task.status !== "completed") {

      return NextResponse.json(
        {
          success: false,
          error:
            `task is in status "${task.status}", not "completed". ` +
            "commit is only allowed after execute() has succeeded.",
        },
        { status: 409 }
      );

    }

    if (!task.commitCandidate) {

      return NextResponse.json(
        {
          success: false,
          error: "task has no commitCandidate (execute() may not have generated one).",
        },
        { status: 409 }
      );

    }

    if (task.gitCommit?.success) {

      return NextResponse.json(
        {
          success: false,
          error: `task was already committed (sha: ${task.gitCommit.sha}).`,
        },
        { status: 409 }
      );

    }

    const message: string =
      typeof body.message === "string" && body.message.trim().length > 0
        ? body.message
        : task.commitCandidate.suggestedMessage;

    const gitProvider = getGitProvider();

    const commitResult =
      await gitProvider.commit(
        task.repositoryPath,
        task.commitCandidate.files,
        message
      );

    const updatedTask = {
      ...task,
      gitCommit: commitResult,
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(updatedTask);

    return NextResponse.json({
      success: commitResult.success,
      task: updatedTask,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );

  }

}
