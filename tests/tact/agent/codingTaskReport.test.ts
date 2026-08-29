// =========================
// TACT Agent — Coding Task Report Builder(Phase113)
// =========================
//
// 対象: core/tact-agent/codingTaskReport.ts(新規)。
//
// 環境制約: 実CLI起動・実LLM API・実DB書き込みは一切行わない。
// RunCodingTaskResult相当の完全に合成されたオブジェクトを直接構築し、
// buildCodingTaskReportSummary()/buildCodingTaskReportMarkdown()/
// extractCodexRuntimeInfo()という純粋関数のみを検証する
// (LLM呼び出しなし、決定論的)。

import {
  buildCodingTaskReportSummary,
  buildCodingTaskReportMarkdown,
  extractCodexRuntimeInfo,
  CodingTaskReportInput,
} from "../../../core/tact-agent/codingTaskReport";
import type { RunCodingTaskAttempt } from "../../../core/tact-agent/codingTaskRunner";
import type { HandoffGitState, VerificationStatus, HandoffState } from "../../../core/tact-agent/types";
import { check, summarize, type CheckResult } from "../lib/check";

function gitState(overrides: Partial<HandoffGitState> = {}): HandoffGitState {
  return {
    branch: "main",
    lastCommit: "abc1234",
    workingTreeStatus: "dirty",
    dirtyFileCount: 9,
    capturedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function verification(checks: VerificationStatus["checks"] = {}): VerificationStatus {
  return { checks, detail: "test detail" };
}

function baseReportInput(
  overrides: Partial<CodingTaskReportInput> = {}
): CodingTaskReportInput {

  return {
    taskId: "task-1",
    instruction: "do something",
    requestedAgent: "auto",
    result: {
      status: "completed",
      finalAgent: "claude-code",
      attempts: [],
      reason: "正常に完了したため、引き継ぎは不要。",
      taskId: "task-1",
      maxAttempts: 3,
      isAvailableCallCount: 1,
    },
    gitBefore: gitState(),
    gitAfter: gitState(),
    verification: verification(),
    completedWork: [],
    pendingWork: ["do something"],
    nextAction: "do something",
    generatedAt: "2026-08-26T00:00:01.000Z",
    ...overrides,
  };

}

function attempt(overrides: Partial<RunCodingTaskAttempt> = {}): RunCodingTaskAttempt {

  return {
    agentId: "claude-code",
    status: "success",
    availability: { available: true, detail: "" },
    executionResult: {
      exitCode: 0,
      timedOut: false,
      changedFiles: ["file1.txt"],
      durationMs: 1000,
      stdout: "done",
      stderr: "",
    },
    ...overrides,
  };

}

function makeHandoff(overrides: Partial<HandoffState> = {}): HandoffState {

  return {
    handoffId: "handoff-1",
    taskId: "task-1",
    fromAgent: "claude-code",
    toAgent: "codex",
    reason: "実行がエラー終了した",
    completedWork: ["前段の作業"],
    pendingWork: ["残りの作業"],
    verificationStatus: verification(),
    gitStatus: gitState(),
    nextAction: "残りの作業を進める",
    status: "completed",
    createdAt: "2026-08-26T00:00:00.500Z",
    completedAt: "2026-08-26T00:00:00.600Z",
    ...overrides,
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // extractCodexRuntimeInfo(): 実際にPhase110/111で観測した
  // stderrバナー書式からの抽出、および未取得ケース
  // ==========================================================

  {

    const realisticStderr =
      "Reading prompt from stdin...\n" +
      "OpenAI Codex v0.149.1\n" +
      "--------\n" +
      "workdir: C:\\Users\\sorao\\Documents\\tact\n" +
      "model: gpt-5.6-terra\n" +
      "provider: openai\n" +
      "approval: never\n" +
      "sandbox: danger-full-access\n" +
      "reasoning effort: low\n" +
      "reasoning summaries: none\n" +
      "session id: 01a03c64-4856-7b61-8125-9b0235160c46\n" +
      "--------\n" +
      "tokens used\n" +
      "13,724\n";

    const extracted = extractCodexRuntimeInfo(realisticStderr);

    results.push(
      check(
        "[TestR-1] extractCodexRuntimeInfo()が実際のCodex CLI出力書式からmodel/" +
          "reasoning effort/token使用量を正しく抽出する(実測ログの再現)",
        extracted.observedModel === "gpt-5.6-terra" &&
          extracted.observedReasoningEffort === "low" &&
          extracted.observedTokenUsage === 13724,
        `extracted=${JSON.stringify(extracted)}`
      )
    );

    results.push(
      check(
        "[TestR-2] extractCodexRuntimeInfo(undefined)は何も推測せず空オブジェクトを返す",
        Object.keys(extractCodexRuntimeInfo(undefined)).length === 0
      )
    );

    results.push(
      check(
        "[TestR-3] extractCodexRuntimeInfo()はバナー書式に一致しないstderrに対して" +
          "架空の値を捏造しない(undefinedのまま)",
        extractCodexRuntimeInfo("some unrelated error text").observedModel === undefined
      )
    );

  }

  // ==========================================================
  // 成功ケース(Handoffなし)
  // ==========================================================

  {

    const input = baseReportInput({
      result: {
        status: "completed",
        finalAgent: "claude-code",
        attempts: [attempt()],
        reason: "正常に完了したため、引き継ぎは不要。",
        taskId: "task-1",
        maxAttempts: 3,
        isAvailableCallCount: 1,
      },
    });

    const summary = buildCodingTaskReportSummary(input);
    const markdown = buildCodingTaskReportMarkdown(input);

    results.push(
      check(
        "[TestR-4] 成功ケース: summary.status='completed'、handoffCount=0、" +
          "changedFilesが実際のAttemptから集約される",
        summary.status === "completed" &&
          summary.handoffCount === 0 &&
          summary.changedFiles.length === 1 &&
          summary.changedFiles[0] === "file1.txt"
      )
    );

    results.push(
      check(
        "[TestR-5] 成功ケースのMarkdownに「成功」「Handoffは発生していません」が含まれる",
        markdown.includes("成功") && markdown.includes("Handoffは発生していません")
      )
    );

  }

  // ==========================================================
  // 失敗ケース(maxAttempts到達)
  // ==========================================================

  {

    const input = baseReportInput({
      result: {
        status: "max_attempts_exceeded",
        attempts: [
          attempt({ status: "failure", executionResult: { exitCode: 1, timedOut: false, changedFiles: [], durationMs: 500, stdout: "", stderr: "" } }),
          attempt({ agentId: "codex", status: "failure", executionResult: { exitCode: 1, timedOut: false, changedFiles: [], durationMs: 600, stdout: "", stderr: "" } }),
        ],
        reason: "maxAttempts(2)に到達したため、これ以上Handoffを作成せず停止する。",
        taskId: "task-1",
        maxAttempts: 2,
        isAvailableCallCount: 4,
      },
    });

    const summary = buildCodingTaskReportSummary(input);
    const markdown = buildCodingTaskReportMarkdown(input);

    results.push(
      check(
        "[TestR-6] maxAttempts到達ケース: summary.maxAttemptsReached=true、" +
          "finalAgentは未設定のまま(架空の成功Agentを作らない)",
        summary.maxAttemptsReached === true && summary.finalAgent === undefined
      )
    );

    results.push(
      check(
        "[TestR-7] maxAttempts到達ケースのMarkdownに「maxAttempts」到達である旨が明記される",
        markdown.includes("maxAttempts=2到達") || markdown.includes("maxAttempts")
      )
    );

  }

  // ==========================================================
  // Handoffありケース
  // ==========================================================

  {

    const handoff = makeHandoff();

    const input = baseReportInput({
      completedWork: [],
      pendingWork: ["do something"],
      nextAction: "do something",
      result: {
        status: "completed",
        finalAgent: "codex",
        attempts: [
          attempt({
            status: "failure",
            executionResult: { exitCode: 1, timedOut: false, changedFiles: [], durationMs: 300, stdout: "", stderr: "" },
            handoff,
            resume: { resumed: true, instructionGenerated: true },
          }),
          attempt({
            agentId: "codex",
            status: "success",
            executionResult: { exitCode: 0, timedOut: false, changedFiles: ["file2.txt"], durationMs: 700, stdout: "", stderr: "" },
          }),
        ],
        reason: "正常に完了したため、引き継ぎは不要。",
        taskId: "task-1",
        maxAttempts: 3,
        isAvailableCallCount: 4,
      },
    });

    const summary = buildCodingTaskReportSummary(input);
    const markdown = buildCodingTaskReportMarkdown(input);

    results.push(
      check(
        "[TestR-8] Handoffありケース: summary.handoffCount=1、completedWork/pendingWorkは" +
          "呼び出し元の初期値ではなく最後のHandoffの値が優先される(推測で更新しない)",
        summary.handoffCount === 1 &&
          summary.completedWork.includes("前段の作業") &&
          summary.pendingWork.includes("残りの作業")
      )
    );

    results.push(
      check(
        "[TestR-9] Handoffありケースのmarkdownに、fromAgent→toAgentとResume実施状況が記録される",
        markdown.includes("Claude Code → Codex") &&
          markdown.includes("Resume実施: はい") &&
          markdown.includes("次Agentへのinstruction再生成: はい")
      )
    );

    results.push(
      check(
        "[TestR-10] Handoffありケースのmarkdownは、両方のAgentのセクションで" +
          "「使用されていません」と誤表示しない(両方とも実際に使われている)",
        !markdown.includes("## 3. Claude Code\n\n今回のRunでは使用されていません") &&
          !markdown.includes("## 4. Codex\n\n今回のRunでは使用されていません")
      )
    );

  }

  // ==========================================================
  // 未実行verificationケース
  // ==========================================================

  {

    const input = baseReportInput({
      verification: verification({}),
      result: {
        status: "completed",
        finalAgent: "claude-code",
        attempts: [attempt()],
        reason: "正常に完了したため、引き継ぎは不要。",
        taskId: "task-1",
        maxAttempts: 3,
        isAvailableCallCount: 1,
      },
    });

    const markdown = buildCodingTaskReportMarkdown(input);

    results.push(
      check(
        "[TestR-11] Verificationが未実行の場合、test/tsc/eslint/buildすべてが" +
          "「未実行」と明記され、実行したふりをしない",
        markdown.includes("- test: 未実行") &&
          markdown.includes("- tsc: 未実行") &&
          markdown.includes("- eslint: 未実行") &&
          markdown.includes("- build: 未実行")
      )
    );

  }

  // ==========================================================
  // 未取得cost情報ケース(Claude Codeのみ使用、token使用量は取得不可)
  // ==========================================================

  {

    const input = baseReportInput({
      result: {
        status: "completed",
        finalAgent: "claude-code",
        attempts: [attempt()],
        reason: "正常に完了したため、引き継ぎは不要。",
        taskId: "task-1",
        maxAttempts: 3,
        isAvailableCallCount: 1,
      },
    });

    const summary = buildCodingTaskReportSummary(input);
    const markdown = buildCodingTaskReportMarkdown(input);

    const claudeInfo = summary.agents.find((a) => a.agentId === "claude-code");

    results.push(
      check(
        "[TestR-12] Claude Codeのみ使用時、observedTokenUsageは未取得のままundefined" +
          "(architecture上取得できないものを推測で埋めない)",
        claudeInfo !== undefined && claudeInfo.observedTokenUsage === undefined
      )
    );

    results.push(
      check(
        "[TestR-13] markdown上のtoken使用量が「未取得」と明記される",
        markdown.includes("token使用量: 未取得")
      )
    );

  }

  {

    const stagedPath = "C:\\temp\\tact-code-attachments\\task-1\\attachment-1.png";
    const markdown = buildCodingTaskReportMarkdown(
      baseReportInput({
        attachments: [{
          id: "att-1",
          kind: "image",
          mimeType: "image/png",
          fileName: "reference.png",
          sizeBytes: 8,
          filePath: stagedPath,
        }],
        result: {
          status: "completed",
          finalAgent: "codex",
          attempts: [attempt({
            agentId: "codex",
            executionResult: {
              exitCode: 0,
              timedOut: false,
              changedFiles: [],
              durationMs: 1,
              stdout: "",
              stderr: "",
              attachmentDelivery: [{
                attachmentId: "att-1",
                method: "cli_image_argument",
                detail: `codex received ${stagedPath}`,
              }],
            },
          })],
          reason: "completed",
          taskId: "task-1",
          maxAttempts: 1,
          isAvailableCallCount: 1,
        },
      })
    );

    results.push(
      check(
        "[TestR-14] Attachment Reportは実測したdelivery方式を記録し、内部staging pathは出力しない",
        markdown.includes("Attachment Context (Phase117)") &&
          markdown.includes("cli_image_argument") &&
          !markdown.includes(stagedPath)
      )
    );

  }

  return summarize("coding-task-report (Phase113)", results);

}
