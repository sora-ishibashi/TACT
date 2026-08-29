import { NextRequest, NextResponse } from "next/server";

import {
  createDevelopmentTask,
  getCurrentAgentForTask,
  runCodingTask,
  captureGitState,
  buildCodingTaskReportSummary,
  buildCodingTaskReportMarkdown,
  runVerification,
} from "@/core/tact-agent";
import type {
  CodingTaskExecutionLogEvent,
  RunCodingTaskDeps,
  VerificationMode,
  VerificationStatus,
} from "@/core/tact-agent";
import { getCodingAgentAdapter } from "@/core/codeAgent/adapterRegistry";
import type { CodingAgentProviderId } from "@/core/codeAgent/adapterRegistry";
import type { CodingAgentAdapter, CodeTaskExecutionResult } from "@/core/codeAgent/types";
import {
  cleanupStagedAttachments,
  MAX_TOTAL_ATTACHMENT_BYTES,
  stageCodeTaskAttachments,
  validateIncomingAttachmentList,
} from "@/core/codeAgent/attachmentContext";
import type {
  IncomingCodeTaskAttachment,
  StagedAttachments,
} from "@/core/codeAgent/attachmentContext";

// =========================
// POST /api/tact/code-tasks/run (Phase112〜116)
// =========================
//
// TACT Code UI(components/tact/CodeSection.tsx)から、ユーザーが直接
// 入力したCoding Taskを受け取り、Phase111のAgent Orchestrator
// (core/tact-agent/codingTaskRunner.ts runCodingTask())へ接続する
// エントリーポイント。
//
// 既存の /api/tact/code-tasks・/api/tact/code-tasks/execute
// (STEP142〜144)は、ImprovementProposalを起点とし、Preflight Safety
// Gate/Checkpoint/Scope Gate/Dangerous Change Detection/Rollback/
// 別エンドポイントでのHuman Approvalを伴う、単一Adapter直接呼び出しの
// 重量な自己改善パイプラインであり、Agent選択・Handoff・Resume
// (Phase104〜111)を一切使っていない。今回UIから求められているのは
// 「ユーザーが自由入力したTaskを、複数Coding Agent間で選択・Handoff
// しながら実行する」という別のユースケースであるため、既存
// /execute のフローを流用・改修せず(大規模な設計変更を避ける、
// 絶対条件)、Phase111のrunCodingTask()を直接呼ぶ薄いエンドポイントを
// 新設する。責務はUI/APIに重複実装しない
// (Agent selection/Adapter選択/execute/failure判定/Handoff/Resume/
// maxAttempts/currentAgent切替は、すべてrunCodingTask()側の責務のまま)。
//
// 認証: 既存core/tact-agent/(Phase94〜111)のDevelopmentTask/
// HandoffStateはuser_idによる絞り込みを行わない設計のまま
// (tact_memory RLS Stage 0、既存のCore Push/Conversation APIと同じ
// 「未認証でも許可する」既存方針を踏襲。新しい認証方式は作らない)。
//
// body:
// {
//   instruction: string,
//   agent?: "auto" | "claude-code" | "codex",
//   maxAttempts?: number,
//   verificationMode?: "none" | "quick" | "full",   // Phase116
//   simulateHandoffTest?: boolean                    // Phase115、開発環境限定
// }
//
// Phase113: 実行結果に加え、監査可能な完了報告(report.summary /
// report.markdown、core/tact-agent/codingTaskReport.tsが機械的に生成)
// を追加した。既存の`success`/`status`/`taskId`/`currentAgent`/
// `finalAgent`/`handoffOccurred`/`attempts`/`message`フィールドは
// 変更していない(既存クライアントとの互換性を維持する)。Git状態の
// 取得はcore/tact-agent/gitState.tsのcaptureGitState()(既存、
// core/codeAgent/gitProvider.tsを再利用)をそのまま呼ぶだけで、
// 重複実装しない。
//
// Phase116: Verificationを実際に実行できるようにした
// (core/tact-agent/verificationRunner.ts、新規)。Handoff発生時に
// 各Handoff Stateへ記録するverificationStatus(実行"前"の状態、
// 常に未実施)と、最終ReportのVerification(実行"後"、要求された
// mode(quick/full)に応じて実際に走らせた結果)は意図的に別物として
// 扱う(前者は「Handoff時点で何を確認済みだったか」という既存の
// Handoff意味論、後者は今回追加したPost-run Verification)。
// mode未指定時は"quick"(tsc --noEmitのみ)を既定値とする
// (絶対条件: 実行していないCheckをpassedにしない。デフォルトを
// "full"にすると、Coding Agent実行のたびに`npm test`/`npm run build`
// まで毎回走り、UI応答が大きく遅くなるため、既定は最小限のtscのみに
// 留める。フル検証はユーザーが明示的に選択した場合のみ実行する)。
//
// Phase115: simulateHandoffTestは、本番挙動に影響しない開発環境限定の
// Handoff検証経路。process.env.NODE_ENV !== "production"の場合のみ
// 有効(Next.jsが自動設定する値をそのまま使う、新しい環境変数は
// 作らない)。有効時、最初に選択されたAgentの実行1回だけを、実CLIを
// 一切起動しない合成的なFailure結果に差し替える
// (core/tact-agent/codingTaskRunner.tsの既存拡張点
// RunCodingTaskDeps.getAdapter——Phase111のUnit Testが既に使っている
// DI経路——をそのまま利用するだけで、Orchestrator自体のロジックは
// 一切変更しない)。repositoryPathの公開・認証変更・sandbox無効化は
// 一切行わない。2つ目以降のAgentは実Adapterでそのまま実行されるため、
// Handoff→Resume→(実LLMによる)実行という経路を安全に確認できる。

const KNOWN_AGENT_IDS: CodingAgentProviderId[] = ["claude-code", "codex"];
const KNOWN_VERIFICATION_MODES: VerificationMode[] = ["none", "quick", "full"];
const MAX_MULTIPART_REQUEST_BYTES = MAX_TOTAL_ATTACHMENT_BYTES + 1024 * 1024;

type RunRequestBody = {
  instruction?: unknown;
  agent?: unknown;
  verificationMode?: unknown;
  maxAttempts?: unknown;
  simulateHandoffTest?: unknown;
};

type ValidatedRunRequest = {
  instruction: string;
  agentParam: "auto" | CodingAgentProviderId;
  verificationMode: VerificationMode;
  maxAttempts?: number;
  simulateHandoffTest: boolean;
  incomingAttachments: IncomingCodeTaskAttachment[];
};

type ExecutionLogEntry = CodingTaskExecutionLogEvent;

function emitExecutionLog(
  callback: ((entry: ExecutionLogEntry) => void) | undefined,
  message: string
): void {
  callback?.({ timestamp: new Date().toISOString(), message });
}

function formatVerificationLog(
  event: {
    check?: "tsc" | "eslint" | "test" | "build";
    status: "started" | "completed" | "skipped";
    result?: "passed" | "failed" | "not_run";
  }
): string {
  if (event.status === "started") {
    return `Verification started: ${event.check}`;
  }

  if (event.status === "completed") {
    return `${event.check} ${event.result}`;
  }

  return event.check
    ? `${event.check} not run`
    : "Verification skipped";
}

function asFormString(value: FormDataEntryValue | null): string | undefined {

  return typeof value === "string" ? value : undefined;

}

function initialVerification(): VerificationStatus {

  return {
    checks: {},
    detail: "実行前時点では未実施(Handoffが発生した場合、この時点の状態がHandoff Stateに記録される)",
  };

}

// Phase115: 開発環境限定。最初のAdapter.execute()呼び出し1回だけを
// 実CLIを起動しない合成的なFailureへ差し替えるDecorator。
// 2回目以降の呼び出しは実Adapterへそのまま委譲する。
function wrapAdapterWithSimulatedFirstFailure(
  realAdapter: CodingAgentAdapter,
  state: { consumed: boolean }
): CodingAgentAdapter {

  return {

    id: realAdapter.id,

    isAvailable: () => realAdapter.isAvailable(),

    async execute(task): Promise<CodeTaskExecutionResult> {

      if (!state.consumed) {

        state.consumed = true;

        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "[TACT Code developer test] simulateHandoffTest=true により、" +
            "実CLIを一切起動せず合成的なFailureを返した(開発環境限定、本番挙動に影響しない)。",
          changedFiles: [],
          durationMs: 0,
          timedOut: false,
        };

      }

      return realAdapter.execute(task);

    },

  };

}

async function executeCodeTask(
  input: ValidatedRunRequest,
  onExecutionLog?: (entry: ExecutionLogEntry) => void
) {
  const {
    instruction,
    agentParam,
    verificationMode,
    maxAttempts,
    simulateHandoffTest,
    incomingAttachments,
  } = input;

  const candidateAgentIds: string[] | undefined =
    agentParam === "auto" ? undefined : [agentParam];
  const repositoryPath = process.cwd();
  const completedWork: string[] = [];
  const pendingWork: string[] = [instruction];
  const nextAction = instruction;
  const preRunVerification = initialVerification();
  let stagedAttachments: StagedAttachments | undefined;

  try {
    emitExecutionLog(onExecutionLog, "Task started");

    const gitBefore = await captureGitState(repositoryPath);

    const task = await createDevelopmentTask({
      title: instruction.length > 80 ? `${instruction.slice(0, 80)}...` : instruction,
      description: instruction,
      phase: "tact-code-ui",
      currentAgent: agentParam !== "auto" ? agentParam : undefined,
    });

    if (incomingAttachments.length > 0) {
      stagedAttachments = await stageCodeTaskAttachments(
        task.taskId,
        incomingAttachments
      );
    }

    emitExecutionLog(
      onExecutionLog,
      stagedAttachments
        ? `Context prepared: ${stagedAttachments.attachments.length} image attachment(s)`
        : "Context prepared"
    );

    const simulatedFailureState = { consumed: false };
    const deps: RunCodingTaskDeps = { onExecutionLog };

    if (simulateHandoffTest) {
      deps.getAdapter = (agentId: string) =>
        wrapAdapterWithSimulatedFirstFailure(
          getCodingAgentAdapter(agentId as CodingAgentProviderId),
          simulatedFailureState
        );
    }

    const result = await runCodingTask(
      {
        taskId: task.taskId,
        repositoryPath,
        instruction,
        completedWork,
        pendingWork,
        verificationStatus: preRunVerification,
        nextAction,
        candidateAgentIds,
        maxAttempts,
        attachments: stagedAttachments?.attachments,
      },
      deps
    );

    const gitAfter = await captureGitState(repositoryPath);
    const currentAgent = await getCurrentAgentForTask(task.taskId);
    const changedFiles: string[] = [];

    for (const attempt of result.attempts) {
      for (const file of attempt.executionResult?.changedFiles ?? []) {
        if (!changedFiles.includes(file)) {
          changedFiles.push(file);
        }
      }
    }

    emitExecutionLog(onExecutionLog, `Files changed: ${changedFiles.length}`);
    emitExecutionLog(onExecutionLog, "Verification started");

    const postRunVerification = await runVerification({
      mode: verificationMode,
      repositoryPath,
      changedFiles,
      onExecutionLog: (event) =>
        emitExecutionLog(onExecutionLog, formatVerificationLog(event)),
    });

    emitExecutionLog(onExecutionLog, "Verification completed");

    const reportInput = {
      taskId: task.taskId,
      instruction,
      requestedAgent: agentParam,
      result,
      gitBefore,
      gitAfter,
      verification: postRunVerification,
      completedWork,
      pendingWork,
      nextAction,
      attachments: stagedAttachments?.attachments ?? [],
      generatedAt: new Date().toISOString(),
    };

    const reportSummary = buildCodingTaskReportSummary(reportInput);
    const reportMarkdown = buildCodingTaskReportMarkdown(reportInput);
    const response = {
      success: result.status === "completed",
      status: result.status,
      taskId: task.taskId,
      currentAgent,
      finalAgent: result.finalAgent,
      handoffOccurred: result.attempts.some((attempt) => !!attempt.handoff),
      verificationMode,
      attempts: result.attempts.map((attempt) => ({
        agentId: attempt.agentId,
        status: attempt.status,
        exitCode: attempt.executionResult?.exitCode ?? null,
        timedOut: attempt.executionResult?.timedOut ?? false,
        changedFiles: attempt.executionResult?.changedFiles ?? [],
        durationMs: attempt.executionResult?.durationMs,
        stdout: attempt.executionResult?.stdout?.slice(0, 2000),
        handoff: attempt.handoff
          ? {
              handoffId: attempt.handoff.handoffId,
              fromAgent: attempt.handoff.fromAgent,
              toAgent: attempt.handoff.toAgent,
              reason: attempt.handoff.reason,
            }
          : undefined,
        resume: attempt.resume,
      })),
      message: result.reason,
      report: {
        summary: reportSummary,
        markdown: reportMarkdown,
      },
      attachments: (stagedAttachments?.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
      })),
    };

    emitExecutionLog(
      onExecutionLog,
      result.status === "completed"
        ? "Task completed"
        : `Task finished: ${result.status}`
    );

    return response;
  } finally {
    const stagedDirectory = stagedAttachments?.directory;

    if (stagedDirectory) {
      try {
        await cleanupStagedAttachments(stagedDirectory);
      } catch (cleanupError) {
        console.error("TACT Code attachment cleanup failed:", cleanupError);
      }
    }
  }
}

export async function POST(
  request: NextRequest
) {

  try {

    const contentType = request.headers.get("content-type") ?? "";
    const isMultipart = contentType.toLowerCase().startsWith("multipart/form-data;");
    const contentLength = Number(request.headers.get("content-length"));

    if (
      isMultipart &&
      Number.isFinite(contentLength) &&
      contentLength > MAX_MULTIPART_REQUEST_BYTES
    ) {
      return NextResponse.json(
        {
          success: false,
          error: `attachments request exceeds the ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024}MB total limit`,
        },
        { status: 413 }
      );
    }

    let body: RunRequestBody;
    const incomingAttachments: IncomingCodeTaskAttachment[] = [];

    if (isMultipart) {
      const formData = await request.formData();
      const files = formData.getAll("attachments");

      for (const file of files) {
        if (!(file instanceof File)) {
          return NextResponse.json(
            { success: false, error: "attachments must be uploaded files" },
            { status: 400 }
          );
        }

        incomingAttachments.push({
          fileName: file.name,
          declaredMimeType: file.type,
          bytes: Buffer.from(await file.arrayBuffer()),
        });
      }

      body = {
        instruction: asFormString(formData.get("instruction")),
        agent: asFormString(formData.get("agent")),
        verificationMode: asFormString(formData.get("verificationMode")),
        maxAttempts: asFormString(formData.get("maxAttempts")),
        simulateHandoffTest: asFormString(formData.get("simulateHandoffTest")),
      };
    } else {
      const json = await request.json();
      body = json && typeof json === "object" ? json as RunRequestBody : {};
    }

    const instruction: string =
      typeof body.instruction === "string" ? body.instruction.trim() : "";

    if (!instruction) {

      return NextResponse.json(
        { success: false, error: "instruction is required" },
        { status: 400 }
      );

    }

    const attachmentValidation = validateIncomingAttachmentList(incomingAttachments);

    if (!attachmentValidation.ok) {
      return NextResponse.json(
        { success: false, error: attachmentValidation.error },
        { status: 400 }
      );
    }

    const agentParam: string =
      typeof body.agent === "string" ? body.agent : "auto";

    if (
      agentParam !== "auto" &&
      !KNOWN_AGENT_IDS.includes(agentParam as CodingAgentProviderId)
    ) {

      return NextResponse.json(
        {
          success: false,
          error: `unknown agent "${agentParam}" (expected "auto", "claude-code", or "codex")`,
        },
        { status: 400 }
      );

    }

    const parsedMaxAttempts =
      typeof body.maxAttempts === "number"
        ? body.maxAttempts
        : typeof body.maxAttempts === "string" && body.maxAttempts.trim()
          ? Number(body.maxAttempts)
          : undefined;

    const maxAttempts: number | undefined =
      typeof parsedMaxAttempts === "number" &&
      Number.isFinite(parsedMaxAttempts) &&
      parsedMaxAttempts > 0
        ? parsedMaxAttempts
        : undefined;

    const verificationModeParam: string =
      typeof body.verificationMode === "string" ? body.verificationMode : "quick";

    if (!KNOWN_VERIFICATION_MODES.includes(verificationModeParam as VerificationMode)) {

      return NextResponse.json(
        {
          success: false,
          error: `unknown verificationMode "${verificationModeParam}" (expected "none", "quick", or "full")`,
        },
        { status: 400 }
      );

    }

    const verificationMode = verificationModeParam as VerificationMode;

    // Phase115: 開発環境限定。本番(NODE_ENV==="production")では
    // クライアントが何を送っても常に無効化する(二重の安全弁、
    // core/codeAgent/*Adapter.tsのstatus==="approved"チェックと同じ
    // 設計思想)。
    const simulateHandoffTest =
      (body.simulateHandoffTest === true || body.simulateHandoffTest === "true") &&
      process.env.NODE_ENV !== "production";

    const validatedRequest: ValidatedRunRequest = {
      instruction,
      agentParam: agentParam as "auto" | CodingAgentProviderId,
      verificationMode,
      maxAttempts,
      simulateHandoffTest,
      incomingAttachments,
    };

    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: unknown) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };

          void (async () => {
            try {
              const response = await executeCodeTask(
                validatedRequest,
                (log) => send({ type: "log", log })
              );
              send({ type: "result", result: response });
            } catch (error) {
              console.error("TACT Code streamed run failed:", error);
              send({
                type: "error",
                error: "TACT Code task failed. Review the server log for details.",
              });
            } finally {
              controller.close();
            }
          })();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return NextResponse.json(await executeCodeTask(validatedRequest));

    // "auto"の場合はcandidateAgentIdsを渡さず、runCodingTask()側の
    // 既定候補一覧 + selectCodingAgent()にAgent選択を委ねる
    // (絶対条件: UIからClaude/Codexへ固定した分岐を作らない)。
    const candidateAgentIds: string[] | undefined =
      agentParam === "auto" ? undefined : [agentParam];

    const repositoryPath = process.cwd();

    const completedWork: string[] = [];
    const pendingWork: string[] = [instruction];
    const nextAction = instruction;
    const preRunVerification = initialVerification();
    let stagedAttachments: StagedAttachments | undefined;

    try {

    // Phase113: Report用に、実行前後のGit状態を実際に取得する
    // (既存captureGitState()の再利用のみ、重複実装しない)。
    const gitBefore = await captureGitState(repositoryPath);

    const task = await createDevelopmentTask({
      title: instruction.length > 80 ? `${instruction.slice(0, 80)}...` : instruction,
      description: instruction,
      phase: "tact-code-ui",
      currentAgent: agentParam !== "auto" ? agentParam : undefined,
    });

    if (incomingAttachments.length > 0) {
      stagedAttachments = await stageCodeTaskAttachments(
        task.taskId,
        incomingAttachments
      );
    }

    const simulatedFailureState = { consumed: false };

    const deps: RunCodingTaskDeps = simulateHandoffTest
      ? {
          getAdapter: (agentId: string) =>
            wrapAdapterWithSimulatedFirstFailure(
              getCodingAgentAdapter(agentId as CodingAgentProviderId),
              simulatedFailureState
            ),
        }
      : {};

    const result = await runCodingTask(
      {
        taskId: task.taskId,
        repositoryPath,
        instruction,
        completedWork,
        pendingWork,
        verificationStatus: preRunVerification,
        nextAction,
        candidateAgentIds,
        maxAttempts,
        attachments: stagedAttachments?.attachments,
      },
      deps
    );

    const gitAfter = await captureGitState(repositoryPath);

    const currentAgent = await getCurrentAgentForTask(task.taskId);

    // Phase116: 全AttemptのchangedFilesを合併・重複排除したもの
    // (core/tact-agent/codingTaskReport.tsのbuildCodingTaskReportSummary()
    // と同じ集約ロジックだが、Verification(ESLintの対象ファイル決定)に
    // 使うためここでも独立して計算する。値の出所はどちらも
    // result.attempts[].executionResult.changedFilesであり、集約方法が
    // 単純なUnion+重複排除である点も同一——ロジックの二重実装ではなく、
    // 同じ入力から同じ結果を導く単純な配列操作の重複であり、抽出するほどの
    // 複雑さはないため許容する)。
    const changedFiles: string[] = [];

    for (const attempt of result.attempts) {

      for (const file of attempt.executionResult?.changedFiles ?? []) {

        if (!changedFiles.includes(file)) {
          changedFiles.push(file);
        }

      }

    }

    // Phase116: Coding Agent実行が終わった後、実際にVerificationを走らせる。
    const postRunVerification = await runVerification({
      mode: verificationMode,
      repositoryPath,
      changedFiles,
    });

    const reportInput = {
      taskId: task.taskId,
      instruction,
      requestedAgent: agentParam,
      result,
      gitBefore,
      gitAfter,
      verification: postRunVerification,
      completedWork,
      pendingWork,
      nextAction,
      attachments: stagedAttachments?.attachments ?? [],
      generatedAt: new Date().toISOString(),
    };

    const reportSummary = buildCodingTaskReportSummary(reportInput);
    const reportMarkdown = buildCodingTaskReportMarkdown(reportInput);

    return NextResponse.json({
      success: result.status === "completed",
      status: result.status,
      taskId: task.taskId,
      currentAgent,
      finalAgent: result.finalAgent,
      handoffOccurred: result.attempts.some((attempt) => !!attempt.handoff),
      verificationMode,
      attempts: result.attempts.map((attempt) => ({
        agentId: attempt.agentId,
        status: attempt.status,
        exitCode: attempt.executionResult?.exitCode ?? null,
        timedOut: attempt.executionResult?.timedOut ?? false,
        changedFiles: attempt.executionResult?.changedFiles ?? [],
        durationMs: attempt.executionResult?.durationMs,
        // stdout/stderrはUI表示用に長さを絞る(肥大化防止、
        // core/prompt/builder.tsのTOOL_RESULT_SNIPPET_LENGTHと
        // 同じ考え方)。
        stdout: attempt.executionResult?.stdout?.slice(0, 2000),
        handoff: attempt.handoff
          ? {
              handoffId: attempt.handoff.handoffId,
              fromAgent: attempt.handoff.fromAgent,
              toAgent: attempt.handoff.toAgent,
              reason: attempt.handoff.reason,
            }
          : undefined,
        // Phase115: HandoffのResume実施状況をUIへそのまま伝える
        // (推測せず、runCodingTask()が実際にresumeLatestHandoffForTask()
        // /buildAgentResumeInstruction()を呼んだ結果のみ)。
        resume: attempt.resume,
      })),
      message: result.reason,
      // Phase113/116: 監査可能な完了報告(Verificationは実行結果を反映)。
      report: {
        summary: reportSummary,
        markdown: reportMarkdown,
      },
      attachments: (stagedAttachments?.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
      })),
    });

    } finally {

      const stagedDirectory = stagedAttachments?.directory;

      if (stagedDirectory) {
        try {
          await cleanupStagedAttachments(stagedDirectory ?? "");
        } catch (cleanupError) {
          console.error("TACT Code attachment cleanup failed:", cleanupError);
        }
      }

    }

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );

  }

}
