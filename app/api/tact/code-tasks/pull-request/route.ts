import { NextRequest, NextResponse } from "next/server";

import { getCodeTask, saveCodeTask } from "@/core/codeAgent/store";
import { getGitProvider } from "@/core/codeAgent/gitProvider";

// =========================
// POST /api/tact/code-tasks/pull-request (STEP144-F)
// =========================
//
// gitPushが成功した後にのみ呼べる、最後のHuman Approvalゲート。
// GitHub CLI(`gh`)の認証が確認できない場合はrequiresExternalAuth:true
// を返して停止する(推測実装しない)。
//
// body:
// {
//   id: string,
//   confirm: true,
//   base?: string,   // 省略時は"main"
//   title?: string,
//   body?: string
// }

export async function POST(
  request: NextRequest
) {

  try {

    const requestBody = await request.json();

    const id: string | undefined = requestBody.id;

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

    if (!task.gitPush?.success || !task.branchName) {

      return NextResponse.json(
        {
          success: false,
          error: "task has no successful gitPush. push the branch before creating a pull request.",
        },
        { status: 409 }
      );

    }

    const gitProvider = getGitProvider();

    const prResult =
      await gitProvider.createPullRequest(
        task.repositoryPath,
        {
          branch: task.branchName,
          base: typeof requestBody.base === "string" ? requestBody.base : "main",
          title:
            typeof requestBody.title === "string"
              ? requestBody.title
              : `TACT Code: ${task.targetFiles.join(", ")}`,
          body:
            typeof requestBody.body === "string"
              ? requestBody.body
              : task.commitCandidate?.suggestedMessage ?? task.instruction,
          confirm: requestBody.confirm === true,
        }
      );

    const updatedTask = {
      ...task,
      gitPullRequest: prResult,
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(updatedTask);

    return NextResponse.json({
      success: prResult.success,
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
