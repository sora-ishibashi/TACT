// =========================
// Coding Task Orchestrator 入口(Phase111)
// =========================
//
// Coding Taskを1つ渡すだけで、
//
//   Agent selection → Adapter availability → execute →
//   success/failure/unavailable/interrupted →
//   (必要ならHandoff → 次Agent selection → Resume) → execute → ...
//
// という流れを、maxAttemptsまで繰り返して管理する単一の入口。
//
// 責務の分離(絶対条件、Section3): このファイルは「いつ・どの順で
// 何を呼ぶか」という接続のみを持つ。
//   - Adapterの実行方法(CLI起動等)          → core/codeAgent/*Adapter.ts
//   - どのAgentを選ぶか(純粋関数)            → agentSelection.ts
//   - Handoffの作成・完了                    → agentHandoffRunner.ts /
//                                               handoffManager.ts
//   - 次Agentへの再開Instruction組み立て      → codexResume.ts
// のいずれも、このファイルへロジックを持ち込まない(重複実装しない、
// God Objectにしない)。
//
// 依存方向: core/tact-agent/gitState.tsが既にcore/codeAgent/
// gitProvider.tsを再利用している一方向依存(tact-agent → codeAgent)を
// そのまま踏襲する。ここでは実行境界そのもの(CodingAgentAdapter/
// CodeTask)を直接呼ぶ必要があるため、core/codeAgent/types.ts・
// adapterRegistry.tsをimportする(gitState.tsと同じ許可された依存方向)。
//
// 無限Handoff防止(絶対条件、Section4): 2つの独立した仕組みを組み合わせる。
//   - 即時再試行の防止: あるAgentの実行が失敗した直後、次のAgentを
//     選ぶ際にはそのAgent自身をattemptedAgentsとして除外し、
//     「失敗した直後に同じAgentへ戻る」ことだけを防ぐ(選択直後の
//     ループではなく、1段階だけの除外)。
//   - 絶対的な上限: maxAttempts(既定3、呼び出し側が上書き可能)に
//     達したら、それ以上何度切り替えても必ず停止する。
// 2つを組み合わせることで、「Claude→Codex→Claude→Codex...」のように
// 2Agent間を往復し続けるケースも、maxAttemptsで確実に止まる
// (attemptedAgentsをRun全体で永続的に積み上げると、2Agent構成では
// 2回目の失敗時点で「候補が尽きた」としてunavailable停止してしまい、
// 本来確認すべきmaxAttempts超過の経路を検証できなくなるため、
// 意図的にAgentごとの即時除外だけに留めている)。
//
// 呼び出し元の責務: DevelopmentTaskの作成(taskManager.createDevelopmentTask())
// は、このOrchestratorの外側で呼び出し元が行う(Orchestrator自身は
// DevelopmentTaskを新規作成しない。既存Taskのcurrent Agent取得・更新
// のみを行う)。completedWork/pendingWork/verificationStatus/nextActionは
// 呼び出し元がTask内容を知っている前提でそのまま受け取り、この
// ファイル自身は「何が完了したか」を推測・捏造しない
// (claudeToCodexHandoff.tsと同じ絶対条件)。

import {
  CodeTask,
  CodeTaskAttachment,
  CodeTaskAttachmentDelivery,
  CodingAgentAdapter,
} from "../codeAgent/types";
import {
  getCodingAgentAdapter,
  CodingAgentProviderId,
} from "../codeAgent/adapterRegistry";
import { selectCodingAgent } from "./agentSelection";
import {
  evaluateHandoffTrigger,
  AgentExecutionOutcome,
  AgentContinuationStatus,
} from "./handoffTrigger";
import { runAgentHandoff } from "./agentHandoffRunner";
import { getCurrentAgentForTask } from "./taskManager";
import {
  resumeLatestHandoffForTask,
  buildAgentResumeInstruction,
} from "./codexResume";
import {
  AgentCandidate,
  AgentHandoffStore,
  HandoffState,
  VerificationStatus,
} from "./types";

// 既定の候補Agent一覧。Claude Code/Codexのどちらかに固定した分岐を
// Domain Logic側(agentSelection.ts)に作らないという絶対条件は守った
// うえで、「この環境で現実にAdapter実装が存在するAgent」の既定値として
// ここに置く(呼び出し側はcandidateAgentIdsで上書きできる)。
const DEFAULT_CANDIDATE_AGENT_IDS: CodingAgentProviderId[] = ["claude-code", "codex"];

// 「Claude→Codex→Claude→Codex...」のような無限Handoffを防ぐための
// 既定上限(絶対条件、Section4「初期値は安全側でよい」)。将来的に
// 設定可能にする、という指示のとおりRunCodingTaskInput.maxAttemptsで
// 上書きできる。
const DEFAULT_MAX_ATTEMPTS = 3;

export interface RunCodingTaskInput {

  // 既に作成済みのDevelopmentTask.taskId(このOrchestratorは
  // DevelopmentTaskを新規作成しない)。
  taskId: string;

  repositoryPath: string;

  instruction: string;

  targetFiles?: string[];

  timeoutMs?: number;

  // Phase117: ユーザーがTACT Code UIから添付した参考資料(画像等)。
  // 呼び出し元(APIルート)が既に検証・配置(staging)済みのものを
  // そのまま受け取り、このOrchestratorは内容を解釈しない
  // (画像の意味を推測・文章化しない)。
  //
  // Instructionとは別の軸として毎AttemptのCodeTaskへ載せるため、
  // Handoff後にInstructionがResume用に組み立て直されても
  // (codexResume.ts buildAgentResumeInstruction())、添付Contextは
  // 次のAgentへそのまま引き継がれる。
  attachments?: CodeTaskAttachment[];

  // Handoffが発生した場合にのみ使われる、呼び出し元が把握している
  // 実際のTask内容(推測・自動生成しない)。
  completedWork: string[];

  pendingWork: string[];

  verificationStatus: VerificationStatus;

  nextAction: string;

  maxAttempts?: number;

  candidateAgentIds?: string[];

}

export interface RunCodingTaskAttempt {

  agentId: string;

  status: AgentContinuationStatus;

  availability: { available: boolean; detail: string };

  executionResult?: {
    exitCode: number | null;
    timedOut: boolean;
    changedFiles: string[];
    durationMs: number;
    // Adapter.execute()の生出力(デバッグ・監査用にそのまま保持する。
    // 判定ロジック自体はexitCode/timedOutのみを使う)。
    stdout: string;
    stderr: string;
    // Phase117: 添付ファイルを、このAttemptのAdapterが実際にどの方式で
    // Coding Agentへ渡したか(Adapterが実行時に記録した事実のみ。
    // 添付が無いAttemptではundefined)。
    attachmentDelivery?: CodeTaskAttachmentDelivery[];
  };

  executionError?: string;

  // このAttemptが失敗し、Handoffが実際に作成された場合のみ設定される。
  handoff?: HandoffState;

  // Phase113: Handoffが発生した場合の、Resume(次Agentへの再開)実施状況。
  // 「Resumeが実際に行われたか」「次Agentへ渡すInstructionがHandoffから
  // 組み立て直されたか(=completedWorkの再実行を防ぐ経路を通ったか)」を
  // 監査できるようにする(推測せず、実際にresumeLatestHandoffForTask()/
  // buildAgentResumeInstruction()を呼んだ結果だけを記録する)。
  resume?: {
    resumed: boolean;
    instructionGenerated: boolean;
  };

}

export type RunCodingTaskStatus =
  | "completed"
  | "unavailable"
  | "max_attempts_exceeded";

export interface RunCodingTaskResult {

  status: RunCodingTaskStatus;

  // 実際に成功したAgent(status:"completed"の場合のみ)。
  finalAgent?: string;

  attempts: RunCodingTaskAttempt[];

  reason: string;

  // Phase113: Report Builder(core/tact-agent/codingTaskReport.ts)が
  // 呼び出し元(input.taskId)を別途保持しなくても自己完結して監査
  // レポートを組み立てられるよう、実際に使われた値をそのまま複製する
  // (捏造ではなく、input側の値をそのまま転記するだけ)。
  taskId: string;

  maxAttempts: number;

  // 実際にisAvailable()を呼んだ回数の合計(全Agent・全ループ分)。
  // Cost/CLI情報の実測値として使う(推測しない)。
  isAvailableCallCount: number;

}

export interface RunCodingTaskDeps {

  candidateAgentIds?: string[];

  // Unit Test用の差し替え点(実Adapterを起動しないためのDI、
  // core/tact-agent/handoffManager.tsのstore引数と同じ設計判断)。
  getAdapter?: (agentId: string) => CodingAgentAdapter;

  store?: AgentHandoffStore;

  // Phase118: APIが接続している実行ログの通知先。Agent選択・実行・
  // Handoff・終了という、このOrchestratorが実際に通過した状態だけを
  // 渡す。UIはこの値を受け取って表示するだけで、状態を推測しない。
  onExecutionLog?: (event: CodingTaskExecutionLogEvent) => void;

}

export interface CodingTaskExecutionLogEvent {

  timestamp: string;

  message: string;

}

function agentDisplayName(agentId: string): string {

  if (agentId === "claude-code") {
    return "Claude Code";
  }

  if (agentId === "codex") {
    return "Codex";
  }

  return agentId;

}

function emitExecutionLog(
  callback: RunCodingTaskDeps["onExecutionLog"],
  message: string
): void {

  callback?.({ timestamp: new Date().toISOString(), message });

}

export async function runCodingTask(
  input: RunCodingTaskInput,
  deps: RunCodingTaskDeps = {}
): Promise<RunCodingTaskResult> {

  const candidateAgentIds =
    deps.candidateAgentIds ??
    input.candidateAgentIds ??
    DEFAULT_CANDIDATE_AGENT_IDS;

  const getAdapter =
    deps.getAdapter ??
    ((agentId: string) => getCodingAgentAdapter(agentId as CodingAgentProviderId));

  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const attempts: RunCodingTaskAttempt[] = [];

  let currentAgent = await getCurrentAgentForTask(input.taskId, deps.store);
  let currentInstruction = input.instruction;
  let isAvailableCallCount = 0;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {

    // 毎ループ、実際のisAvailable()を呼び直して最新の可否を反映する
    // (Agent Registry上のキャッシュされたstatusではなく、実行境界の
    // 真実の源であるAdapter自身に問い合わせる。Phase104〜110の
    // 既存実装と同じ方針)。
    const candidates: AgentCandidate[] = [];

    for (const agentId of candidateAgentIds) {

      const availability = await getAdapter(agentId).isAvailable();
      isAvailableCallCount += 1;
      candidates.push({ agentId, availability });

    }

    // ここでは「直前に失敗して切り替わったAgentを、この1回だけ
    // currentAgentとして継続してよい」という通常のルール1判定のみを
    // 行う(attemptedAgentsは、直後の「失敗したAgentからの切り替え先を
    // 決める」場面でのみ使う。上のコメント参照)。
    const selection = selectCodingAgent({
      candidates,
      currentAgent,
    });

    if (selection.status === "unavailable") {

      emitExecutionLog(deps.onExecutionLog, "No coding agent is available");

      return {
        status: "unavailable",
        attempts,
        reason: selection.reason,
        taskId: input.taskId,
        maxAttempts,
        isAvailableCallCount,
      };

    }

    const agentId = selection.agentId;

    emitExecutionLog(
      deps.onExecutionLog,
      `Agent selected: ${agentDisplayName(agentId)}`
    );

    const availability =
      candidates.find((candidate) => candidate.agentId === agentId)!.availability;

    const adapter = getAdapter(agentId);

    const codeTask: CodeTask = {
      id: `${input.taskId}-attempt-${attemptIndex + 1}`,
      proposalId: input.taskId,
      status: "approved",
      executionPolicy: "human_approval_required",
      repositoryPath: input.repositoryPath,
      instruction: currentInstruction,
      targetFiles: input.targetFiles ?? [],
      timeoutMs: input.timeoutMs,
      // Phase117: 添付Contextは全Attempt(Handoff後の次Agentも含む)へ
      // 同じものを渡す。
      attachments: input.attachments,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let executionResult: Awaited<ReturnType<CodingAgentAdapter["execute"]>> | undefined;
    let executionError: string | undefined;

    try {
      emitExecutionLog(
        deps.onExecutionLog,
        `Coding agent started: ${agentDisplayName(agentId)}`
      );
      executionResult = await adapter.execute(codeTask);
    } catch (err) {
      executionError = String(err);
    }

    const outcome: AgentExecutionOutcome = {
      availability,
      executionError,
      executionResult: executionResult
        ? { exitCode: executionResult.exitCode, timedOut: executionResult.timedOut }
        : undefined,
    };

    const decision = evaluateHandoffTrigger(outcome);

    const attempt: RunCodingTaskAttempt = {
      agentId,
      status: decision.status,
      availability,
      executionError,
      executionResult: executionResult
        ? {
            exitCode: executionResult.exitCode,
            timedOut: executionResult.timedOut,
            changedFiles: executionResult.changedFiles,
            durationMs: executionResult.durationMs,
            stdout: executionResult.stdout,
            stderr: executionResult.stderr,
            attachmentDelivery: executionResult.attachmentDelivery,
          }
        : undefined,
    };

    attempts.push(attempt);

    if (executionResult) {
      emitExecutionLog(
        deps.onExecutionLog,
        `${agentDisplayName(agentId)} ${decision.status}: ${executionResult.changedFiles.length} files changed`
      );
    } else {
      emitExecutionLog(
        deps.onExecutionLog,
        `${agentDisplayName(agentId)} ${decision.status}`
      );
    }

    if (!decision.shouldHandoff) {

      emitExecutionLog(deps.onExecutionLog, "Coding task completed");

      return {
        status: "completed",
        finalAgent: agentId,
        attempts,
        reason: decision.reason,
        taskId: input.taskId,
        maxAttempts,
        isAvailableCallCount,
      };

    }

    // 無限Handoff防止(絶対条件、Section4): 上限に達したらここで
    // 必ず停止する(これ以上Handoffを作らない)。
    if (attemptIndex === maxAttempts - 1) {

      emitExecutionLog(
        deps.onExecutionLog,
        `Task stopped: maxAttempts (${maxAttempts}) reached`
      );

      return {
        status: "max_attempts_exceeded",
        attempts,
        reason:
          `maxAttempts(${maxAttempts})に到達したため、これ以上Handoffを作成せず停止する。` +
          `直近の状態: ${decision.reason}`,
        taskId: input.taskId,
        maxAttempts,
        isAvailableCallCount,
      };

    }

    // 次に選ぶべきAgentを、Handoffを作る前に確認する。次のAgentが
    // 存在しない場合はHandoff自体を作らずに停止する(絶対条件、
    // Step7 Case D: 両Agent unavailable → 明確に停止 → 無限ループなし。
    // 「toAgentが存在しないHandoff」という不整合な記録を残さない)。
    // attemptedAgentsには「今回失敗したagentId自身」だけを渡し、
    // 「失敗した直後に同じAgentへ戻る」ことだけを防ぐ(ルール3)。
    // これにより、2Agent構成でも次回以降のループでagentIdへ戻ることは
    // でき、最終的にmaxAttemptsが確実に無限ループを止める(上のコメント参照)。
    const nextSelection = selectCodingAgent({
      candidates,
      currentAgent: agentId,
      attemptedAgents: [agentId],
    });

    if (nextSelection.status === "unavailable") {

      emitExecutionLog(
        deps.onExecutionLog,
        "Task stopped: no handoff agent is available"
      );

      return {
        status: "unavailable",
        attempts,
        reason: nextSelection.reason,
        taskId: input.taskId,
        maxAttempts,
        isAvailableCallCount,
      };

    }

    const toAgent = nextSelection.agentId;

    emitExecutionLog(
      deps.onExecutionLog,
      `Handoff started: ${agentDisplayName(agentId)} → ${agentDisplayName(toAgent)}`
    );

    const handoffResult = await runAgentHandoff(
      {
        taskId: input.taskId,
        repositoryPath: input.repositoryPath,
        outcome,
        completedWork: input.completedWork,
        pendingWork: input.pendingWork,
        verificationStatus: input.verificationStatus,
        nextAction: input.nextAction,
        fromAgent: agentId,
        toAgent,
      },
      deps.store
    );

    attempt.handoff = handoffResult.handoff;

    emitExecutionLog(
      deps.onExecutionLog,
      `Handoff completed: ${agentDisplayName(agentId)} → ${agentDisplayName(toAgent)}`
    );

    // Resume: 次のAgentへ渡すInstructionは、元のinput.instructionを
    // そのまま使い回さず、実際に作成されたHandoffから組み立て直す
    // (completedWorkを次のAgentに再実行させないため、Phase109/110の
    // Reality Testで確認済みの経路をそのまま使う)。
    const resumed = await resumeLatestHandoffForTask(input.taskId, deps.store);

    attempt.resume = {
      resumed: !!resumed,
      instructionGenerated: !!resumed,
    };

    currentInstruction = resumed
      ? buildAgentResumeInstruction(resumed)
      : input.instruction;

    currentAgent = toAgent;

  }

  // ここには到達しない想定(ループ内のmaxAttempts-1チェックで必ず
  // returnする)が、型・安全側の網羅性のためのフォールバック。
  return {
    status: "max_attempts_exceeded",
    attempts,
    reason: `maxAttempts(${maxAttempts})に到達したため停止した。`,
    taskId: input.taskId,
    maxAttempts,
    isAvailableCallCount,
  };

}
