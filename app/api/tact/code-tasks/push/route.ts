import { NextRequest, NextResponse } from "next/server";

import { getCodeTask, saveCodeTask } from "@/core/codeAgent/store";
import { getGitProvider } from "@/core/codeAgent/gitProvider";

// =========================
// POST /api/tact/code-tasks/push (STEP144-F)
// =========================
//
// gitCommitが成功した後にのみ呼べる、**さらに別のHuman Approval
// ゲート**。GitHub CLI(`gh`)による認証が確認できない場合、
// pushを一切試みず`requiresExternalAuth: true`を返して停止する
// (推測実装しない)。
//
// confirm:trueを明示的に渡さない限り、GitProvider.push()自体が
// 何もしない(誤操作防止の二重の安全弁)。
//
// body:
// {
//   id: string,
//   confirm: true,   // 必須。falseまたは省略時は何もしない
//   remote?: string  // 省略時は"origin"
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

    if (!task.gitCommit?.success) {

      return NextResponse.json(
        {
          success: false,
          error: "task has no successful gitCommit. commit before pushing.",
        },
        { status: 409 }
      );

    }

    if (!task.useBranch || !task.branchName) {

      return NextResponse.json(
        {
          success: false,
          error:
            "task was not executed on a Feature Branch (useBranch=false). " +
            "TACT Code does not push directly to the checked-out branch " +
            "(which may be a Production branch such as main).",
        },
        { status: 409 }
      );

    }

    const gitProvider = getGitProvider();

    const pushResult =
      await gitProvider.push(
        task.repositoryPath,
        task.branchName,
        {
          confirm: body.confirm === true,
          remote: typeof body.remote === "string" ? body.remote : undefined,
        }
      );

    const updatedTask = {
      ...task,
      gitPush: pushResult,
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(updatedTask);

    return NextResponse.json({
      success: pushResult.success,
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
