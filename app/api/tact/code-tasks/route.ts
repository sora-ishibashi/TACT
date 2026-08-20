import { NextRequest, NextResponse } from "next/server";

import { getImprovementProposalById } from "@/core/brain/memory";
import { guessTargetFiles } from "@/core/brain/claudeCodeInstruction";
import { buildSafeClaudeCodeInstruction } from "@/core/codeAgent/instructionSafety";
import { saveCodeTask, listCodeTasks, getCodeTask } from "@/core/codeAgent/store";
import { CodeTask, CodeTaskEvaluationTask } from "@/core/codeAgent/types";

// =========================
// POST /api/tact/code-tasks (STEP142)
// =========================
//
// 既存のImprovementProposal(tact_memory.type="improvement_proposal")
// から、Claude Code向けInstructionを取得し、CodeTaskとして保存する。
//
// body:
// {
//   proposalId: string
// }
//
// 重要: このエンドポイントはTaskをstatus="ready_for_approval"として
// 保存するだけで、Coding Agentを実行しない
// (実行はPOST /api/tact/code-tasks/executeが担い、かつ
// status==="approved"のTaskしか受け付けない)。

export async function POST(
  request: NextRequest
) {

  try {

    const body = await request.json();

    const proposalId: string | undefined = body.proposalId;

    if (!proposalId) {

      return NextResponse.json(
        { success: false, error: "proposalId is required" },
        { status: 400 }
      );

    }

    const proposal =
      await getImprovementProposalById(proposalId);

    if (!proposal) {

      return NextResponse.json(
        { success: false, error: "proposal not found" },
        { status: 404 }
      );

    }

    // STEP143-B: 生成されたInstructionには、既存の安全設計
    // (推測でEvidenceを捏造しない等)を保護する制約を常に付加する。
    const instruction =
      buildSafeClaudeCodeInstruction(proposal);

    const targetFiles =
      guessTargetFiles(proposal.targetAgent);

    // STEP143-B: Evaluation(F/G)用の、再現可能なWorkflow入力。
    // 省略可能(既存呼び出し元・既存テストとの後方互換を維持)。
    // 指定された場合のみ、Task実行時にbefore/after比較を行う。
    const evaluationTask: CodeTaskEvaluationTask | undefined =
      body.evaluationTask &&
      typeof body.evaluationTask.userInput === "string" &&
      typeof body.evaluationTask.mode === "string"
        ? {
            userInput: body.evaluationTask.userInput,
            mode: body.evaluationTask.mode,
          }
        : undefined;

    // STEP144-E: 省略可能。trueの場合、実行時にFeature Branchを
    // 作成してその上でCoding Agentを実行する(Productionを直接
    // 変更しない運用)。省略時(既存Taskとの後方互換)はfalse相当。
    const useBranch: boolean = body.useBranch === true;

    const branchName: string | undefined =
      typeof body.branchName === "string" ? body.branchName : undefined;

    // STEP144-B: 省略可能。省略時はadapterRegistry側のデフォルト
    // ("claude-code")が使われる。
    const codingAgentProviderId: string | undefined =
      typeof body.codingAgentProviderId === "string"
        ? body.codingAgentProviderId
        : undefined;

    const now = new Date().toISOString();

    const task: CodeTask = {

      id: crypto.randomUUID(),

      proposalId: proposal.id,

      status: "ready_for_approval",

      executionPolicy: "human_approval_required",

      // STEP142: 今回は単一リポジトリ(TACT自身)前提。
      // マルチリポジトリ対応は今回のスコープ外。
      repositoryPath: process.cwd(),

      instruction,

      targetFiles,

      ...(evaluationTask ? { evaluationTask } : {}),
      ...(useBranch ? { useBranch } : {}),
      ...(branchName ? { branchName } : {}),
      ...(codingAgentProviderId ? { codingAgentProviderId } : {}),

      createdAt: now,

      updatedAt: now,

    };

    await saveCodeTask(task);

    return NextResponse.json({
      success: true,
      task,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );

  }

}

// =========================
// GET /api/tact/code-tasks?id=...  または  ?limit=...
// =========================

export async function GET(
  request: NextRequest
) {

  try {

    const { searchParams } = new URL(request.url);

    const id = searchParams.get("id");

    if (id) {

      const task = await getCodeTask(id);

      if (!task) {

        return NextResponse.json(
          { success: false, error: "task not found" },
          { status: 404 }
        );

      }

      return NextResponse.json({ success: true, task });

    }

    const limitParam = searchParams.get("limit");

    const parsedLimit =
      limitParam ? Number(limitParam) : NaN;

    const tasks =
      await listCodeTasks(
        Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
          : undefined
      );

    return NextResponse.json({ success: true, tasks });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );

  }

}
