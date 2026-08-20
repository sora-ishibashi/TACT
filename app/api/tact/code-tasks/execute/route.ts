import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";

import { getCodeTask, saveCodeTask } from "@/core/codeAgent/store";
import { getCodingAgentAdapter } from "@/core/codeAgent/adapterRegistry";
import { getGitProvider } from "@/core/codeAgent/gitProvider";
import { recordCodeTaskOutcome } from "@/core/brain/memory";
import {
  checkCleanRepository,
  checkScope,
  checkDangerousChanges,
} from "@/core/codeAgent/safetyGate";
import { measureWorkflowMetrics, classifyEvaluation } from "@/core/codeAgent/evaluation";
import { CodeTask, CodeTaskStatus, CodeTaskTestResult } from "@/core/codeAgent/types";
import { CodingAgentProviderId } from "@/core/codeAgent/adapterRegistry";

// =========================
// POST /api/tact/code-tasks/execute
// (STEP142-E/F/G, STEP143-B, STEP144-B/D/E/G/H/I)
// =========================
//
// status==="approved"のCodeTaskのみを受け付け、以下の順で進める。
//
//   Preflight Safety Gate(Clean Repository Gate + Checkpoint)
//     ↓ dirtyならここでblocked、Coding Agentは起動しない
//   (useBranch指定時) Feature Branch作成
//     ↓
//   running (CodingAgentAdapter.execute。STEP144-Bのregistry経由)
//     ↓
//   Change Scope Gate + Dangerous Change Detection
//     ↓ 対象外ファイル変更 → failed/rolled_back(scope_violation)
//     ↓ 危険な領域の変更 → requires_human_review(常にrollbackを試みるが、
//        状態はrolled_backにはせず、必ず人間の確認を要求する)
//   testing (npx tsc --noEmit)
//     ↓
//   evaluating (before/after比較。evaluationTask未指定ならinconclusive)
//     ↓ 悪化(degraded) → failed/rolled_back
//   completed(+ commit candidateを生成するが、commitはしない)
//
// 重要な安全設計:
// - status !== "approved" の場合はここで拒否する
//   (Adapter側の二重チェックに加え、APIルート側でも確認する)。
// - Coding Agentが利用不可の場合、実行せずにstatus="failed"として
//   保存し、架空の成功を報告しない。
// - Preflight Safety Gateを通過できない場合、Human Approval済み
//   でもCoding Agentを起動しない。
// - npx tsc --noEmitに失敗した場合もstatus="failed"とし、
//   「コードを変更した」だけで成功扱いにしない。
// - commit/push/PR作成はこのエンドポイントでは一切行わない
//   (STEP144-F: 別ゲート。/commit, /pushを参照)。
//
// body:
// {
//   id: string  // CodeTask.id
// }

const TYPECHECK_TIMEOUT_MS = 5 * 60 * 1000;
const TYPECHECK_OUTPUT_LIMIT = 5000;

function runTypecheck(
  repositoryPath: string
): Promise<CodeTaskTestResult> {

  return new Promise((resolve) => {

    execFile(
      "npx",
      ["tsc", "--noEmit", "-p", "."],
      {
        cwd: repositoryPath,
        timeout: TYPECHECK_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        // core/codeAgent/claudeCodeAdapter.tsのrunCommand()と同じ理由
        // (Windows上、npxの実体はnpx.cmdであり、shell:trueなしでは
        // 解決できない)。npxへの引数は固定の静的文字列のみ。
        shell: true,
      },
      (error, stdout, stderr) => {

        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;

        resolve({
          typecheckPassed: exitCode === 0,
          typecheckExitCode: exitCode,
          typecheckOutput:
            (stdout + "\n" + stderr).slice(0, TYPECHECK_OUTPUT_LIMIT),
        });

      }
    );

  });

}

type OutcomeType =
  | "completed"
  | "blocked"
  | "failed"
  | "requires_human_review"
  | "rolled_back";

// 各終了経路でBrainへの記録とAPIレスポンスを一箇所にまとめるための
// ヘルパー(success時だけでなくblocked/failed/requires_human_review/
// rolled_backも記録する。STEP143-B: K, STEP144-I)。
async function finish(
  task: CodeTask,
  outcomeType: OutcomeType,
  summary: string,
  extra: {
    failureReason?: string;
    changedFiles?: string[];
    typecheckPassed?: boolean;
  } = {}
) {

  await saveCodeTask(task);

  await recordCodeTaskOutcome({
    proposalId: task.proposalId,
    codeTaskId: task.id,
    success: outcomeType === "completed",
    summary,
    changedFiles: extra.changedFiles ?? task.execution?.changedFiles ?? [],
    typecheckPassed: extra.typecheckPassed ?? task.test?.typecheckPassed ?? false,
    outcomeType,
    failureReason: extra.failureReason ?? task.blockedReason,
    evaluation: task.evaluation,
    rollback: task.rollback,
    codingAgent: task.codingAgentProviderId ?? "claude-code",
    gitBranch: task.branchName,
  });

  return NextResponse.json({
    success: outcomeType === "completed",
    task,
  });

}

// scope_violation/dangerous_change/test失敗/degradedが起きた際、
// Rollbackを試み、結果に応じて最終statusを決める共通処理
// (STEP144-D: rollbackが完全に成功した場合のみ"rolled_back"とし、
// それ以外(未試行・部分失敗)は引き続き"failed"のままにして
// 人間の確認を促す。dangerous_changeだけは常にrequires_human_review
// を優先する——自動でrevertできたとしても、なぜ危険な領域が
// 変更されたのか自体の確認が必要なため)。
async function rollbackAndDecideStatus(
  task: CodeTask,
  changedFiles: string[],
  forceHumanReview: boolean
): Promise<{ status: CodeTaskStatus; rollback: Awaited<ReturnType<ReturnType<typeof getGitProvider>["rollback"]>> }> {

  const gitProvider = getGitProvider();

  const rollback =
    await gitProvider.rollback(
      task.repositoryPath,
      task.checkpoint,
      changedFiles
    );

  if (forceHumanReview) {

    return { status: "requires_human_review", rollback };

  }

  return {
    status: rollback.attempted && rollback.success ? "rolled_back" : "failed",
    rollback,
  };

}

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

    let task = await getCodeTask(id);

    if (!task) {

      return NextResponse.json(
        { success: false, error: "task not found" },
        { status: 404 }
      );

    }

    if (task.status !== "approved") {

      return NextResponse.json(
        {
          success: false,
          error:
            `task is in status "${task.status}", not "approved". ` +
            "TACT Code refuses to execute unapproved tasks.",
        },
        { status: 409 }
      );

    }

    const gitProvider = getGitProvider();

    // =========================
    // Preflight Safety Gate(STEP143-B: A/B)
    // =========================

    task = {
      ...task,
      status: "preflight_check",
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(task);

    const clean =
      await checkCleanRepository(task.repositoryPath, task.targetFiles);

    if (!clean.ok) {

      task = {
        ...task,
        status: "blocked",
        blockedReason: clean.reason ?? "unknown_preflight_failure",
        updatedAt: new Date().toISOString(),
      };

      return await finish(
        task,
        "blocked",
        "Preflight Safety Gateでブロックされたため、Coding Agentは起動していない。" +
          `理由: ${clean.reason}` +
          (clean.dirtyTargetFiles.length > 0
            ? ` (dirtyな対象ファイル: ${clean.dirtyTargetFiles.join(", ")})`
            : ""),
        { failureReason: clean.reason }
      );

    }

    const checkpoint =
      await gitProvider.createCheckpoint(task.repositoryPath, task.targetFiles);

    if (!checkpoint) {

      // checkCleanRepository()がok:trueを返した直後にcreateCheckpoint()が
      // nullを返すことは通常起きないはずだが(競合状態を除く)、
      // 万一の場合でも「checkpoint無しで実行してrollbackできない」
      // という事態を避けるため、ここでもblockedにする。
      task = {
        ...task,
        status: "blocked",
        blockedReason: "checkpoint_unavailable",
        updatedAt: new Date().toISOString(),
      };

      return await finish(
        task,
        "blocked",
        "Checkpointを取得できなかったため、Coding Agentは起動していない。",
        { failureReason: "checkpoint_unavailable" }
      );

    }

    task = {
      ...task,
      checkpoint,
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(task);

    // =========================
    // Feature Branch(STEP144-E、useBranch指定時のみ。オプトイン)
    // =========================
    //
    // 既存Task(useBranch未指定)との後方互換のため、デフォルトでは
    // 現在のBranch上でSTEP143-Bまでと同じく直接実行する。
    // Productionを直接書き換えない運用にしたい場合、Task作成時に
    // useBranch:trueを指定する。

    if (task.useBranch) {

      const branchName =
        task.branchName || `tact-code/${task.id}`;

      const branchResult =
        await gitProvider.createBranch(task.repositoryPath, branchName);

      if (!branchResult.success) {

        task = {
          ...task,
          status: "blocked",
          blockedReason: "branch_creation_failed",
          updatedAt: new Date().toISOString(),
        };

        return await finish(
          task,
          "blocked",
          `Feature Branchの作成に失敗したため、Coding Agentは起動していない: ${branchResult.detail}`,
          { failureReason: "branch_creation_failed" }
        );

      }

      task = {
        ...task,
        branchName,
        updatedAt: new Date().toISOString(),
      };

      await saveCodeTask(task);

    }

    // =========================
    // Evaluation(before)(STEP143-B: F/G, STEP144-G)
    // =========================
    // adapter実行より前に「変更前」の指標を測定する。
    // evaluationTaskが無い場合はnullのままとし、後でinconclusiveとする。

    const beforeMetrics =
      task.evaluationTask
        ? await measureWorkflowMetrics(task.evaluationTask).catch(
            () => null
          )
        : null;

    // =========================
    // Coding Agent実行(STEP144-B: Adapter Registry経由)
    // =========================

    const adapter =
      getCodingAgentAdapter(
        (task.codingAgentProviderId as CodingAgentProviderId) ?? "claude-code"
      );

    const availability = await adapter.isAvailable();

    if (!availability.available) {

      task = {
        ...task,
        status: "failed",
        error: `CodingAgentAdapter (${adapter.id}) unavailable: ${availability.detail}`,
        updatedAt: new Date().toISOString(),
      };

      return await finish(
        task,
        "failed",
        `CodingAgentAdapter(${adapter.id})が利用できないため実行していない: ${availability.detail}`,
        { failureReason: "adapter_unavailable" }
      );

    }

    task = {
      ...task,
      status: "running",
      codingAgentProviderId: adapter.id,
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(task);

    let executionResult;

    try {

      executionResult = await adapter.execute(task);

    } catch (executionError) {

      task = {
        ...task,
        status: "failed",
        error: String(executionError),
        updatedAt: new Date().toISOString(),
      };

      return await finish(
        task,
        "failed",
        `Coding Agentの実行自体が例外を投げた: ${String(executionError)}`,
        { failureReason: "adapter_execution_exception" }
      );

    }

    task = {
      ...task,
      execution: executionResult,
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(task);

    // =========================
    // Change Scope Gate + Dangerous Change Detection
    // (STEP143-B: D/E)
    // =========================

    const scopeCheck =
      checkScope(task.targetFiles, executionResult.changedFiles);

    const dangerousChangeCheck =
      checkDangerousChanges(executionResult.changedFiles);

    task = {
      ...task,
      scopeCheck,
      dangerousChangeCheck,
      updatedAt: new Date().toISOString(),
    };

    if (dangerousChangeCheck.flaggedFiles.length > 0) {

      const { status, rollback } =
        await rollbackAndDecideStatus(
          task,
          executionResult.changedFiles,
          /* forceHumanReview */ true
        );

      task = {
        ...task,
        status,
        blockedReason: "dangerous_change",
        rollback,
        updatedAt: new Date().toISOString(),
      };

      return await finish(
        task,
        "requires_human_review",
        "危険な変更領域が検出されたため自動完了しない: " +
          dangerousChangeCheck.reasons.join(" / "),
        { failureReason: "dangerous_change" }
      );

    }

    if (scopeCheck.violationFiles.length > 0) {

      const { status, rollback } =
        await rollbackAndDecideStatus(
          task,
          executionResult.changedFiles,
          /* forceHumanReview */ false
        );

      task = {
        ...task,
        status,
        blockedReason: "scope_violation",
        rollback,
        updatedAt: new Date().toISOString(),
      };

      return await finish(
        task,
        status === "rolled_back" ? "rolled_back" : "failed",
        "対象ファイル以外が変更されたため失敗扱いとした: " +
          scopeCheck.violationFiles.join(", "),
        { failureReason: "scope_violation" }
      );

    }

    // =========================
    // Test(STEP142-F, 既存機構を維持)
    // =========================

    task = {
      ...task,
      status: "testing",
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(task);

    const testResult =
      await runTypecheck(task.repositoryPath);

    task = {
      ...task,
      test: testResult,
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(task);

    const executionOk =
      executionResult.exitCode === 0 && !executionResult.timedOut;

    if (!executionOk || !testResult.typecheckPassed) {

      const failureReason =
        !executionOk ? "execution_failure" : "typecheck_failure";

      const { status, rollback } =
        await rollbackAndDecideStatus(
          task,
          executionResult.changedFiles,
          /* forceHumanReview */ false
        );

      task = {
        ...task,
        status,
        blockedReason: failureReason,
        rollback,
        updatedAt: new Date().toISOString(),
      };

      return await finish(
        task,
        status === "rolled_back" ? "rolled_back" : "failed",
        !executionOk
          ? "Coding Agentの実行が失敗(exitCode!=0またはtimeout)したため失敗扱いとした。"
          : "TypeScriptの型チェックに失敗したため失敗扱いとした。",
        { failureReason }
      );

    }

    // =========================
    // Evaluation(after)(STEP143-B: F/G, STEP144-G)
    // =========================

    task = {
      ...task,
      status: "evaluating",
      updatedAt: new Date().toISOString(),
    };

    await saveCodeTask(task);

    const afterMetrics =
      task.evaluationTask
        ? await measureWorkflowMetrics(task.evaluationTask).catch(
            () => null
          )
        : null;

    const { classification, reason } =
      classifyEvaluation(beforeMetrics, afterMetrics);

    task = {
      ...task,
      evaluation: {
        before: beforeMetrics,
        after: afterMetrics,
        classification,
        reason,
      },
      updatedAt: new Date().toISOString(),
    };

    if (classification === "degraded") {

      const { status, rollback } =
        await rollbackAndDecideStatus(
          task,
          executionResult.changedFiles,
          /* forceHumanReview */ false
        );

      task = {
        ...task,
        status,
        blockedReason: "degraded",
        rollback,
        updatedAt: new Date().toISOString(),
      };

      return await finish(
        task,
        status === "rolled_back" ? "rolled_back" : "failed",
        "変更前より品質が悪化した(degraded)と判定されたため失敗扱いとした。",
        { failureReason: "degraded" }
      );

    }

    // =========================
    // Completed(STEP144-F: commit candidateを生成するが、commitはしない)
    // =========================

    const commitCandidate =
      await gitProvider.buildCommitCandidate(
        task.repositoryPath,
        executionResult.changedFiles
      );

    task = {
      ...task,
      status: "completed",
      commitCandidate,
      updatedAt: new Date().toISOString(),
    };

    return await finish(
      task,
      "completed",
      "Coding Agentによる実装・Scope Check・TypeScriptチェックすべてに成功した。" +
        `Evaluation: ${classification}${reason ? `(${reason})` : ""}。` +
        "commitはまだ行っていない(POST /api/tact/code-tasks/commitで人間が確認の上実行する)。"
    );

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );

  }

}
