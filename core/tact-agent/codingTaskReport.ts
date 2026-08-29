// =========================
// Coding Task Report Builder(Phase113)
// =========================
//
// core/tact-agent/codingTaskRunner.ts runCodingTask()が返す構造化結果
// (RunCodingTaskResult)・実行前後のGit状態・Verification結果から、
// Claude CodeのPhase報告レベルの監査可能なレポートを機械的に組み立てる。
//
// 絶対条件(Phase113): LLMに実測値を推測させたり、成功内容を作文させ
// たりしない。このファイルは純粋な決定論的関数のみで構成される
// (LLM呼び出しは一切行わない)。取得できない値は明示的に「未取得」
// とし、architecture上の既知の事実(例: このFlowはSearch APIを一切
// 使わない)と、実際に計測した値(例: durationMs)と、確認できていない
// 事項を、すべて区別して出力する。
//
// 依存方向: core/tact-agent/内のcodingTaskRunner.ts/types.tsの型のみに
// 依存する(core/codeAgent/を直接importしない。Adapterの実装詳細を
// 知る必要はなく、RunCodingTaskResultに既に含まれる値だけを使う)。

import { RunCodingTaskAttempt, RunCodingTaskResult, RunCodingTaskStatus } from "./codingTaskRunner";
import { VerificationStatus, HandoffGitState } from "./types";
// Phase117: 添付Contextの型のみをimportする(Adapterの実装詳細には
// 依然として依存しない。RunCodingTaskInput/CodeTaskへ実際に渡された値と、
// Adapterが実際に記録した伝達方式だけを転記する)。
import type { CodeTaskAttachment } from "../codeAgent/types";

export interface CodingTaskReportInput {

  taskId: string;

  instruction: string;

  // UIでユーザーが選んだAgent("auto" | "claude-code" | "codex")。
  requestedAgent: string;

  result: RunCodingTaskResult;

  gitBefore: HandoffGitState;

  gitAfter: HandoffGitState;

  // runCodingTask()へ実際に渡したverificationStatus(Handoffが起きな
  // かった場合、最終状態を推測しないためこの値をそのまま使う)。
  verification: VerificationStatus;

  // runCodingTask()へ実際に渡した初期値(Handoffが1度も起きなかった
  // 場合のWork Section用フォールバック。Handoffが起きた場合は、
  // 最後のHandoffが保持する値の方が新しいためそちらを優先する)。
  completedWork: string[];

  pendingWork: string[];

  nextAction: string;

  // 実際にrunCodingTask()へ渡した添付Contextのメタデータ。実体パスや
  // ファイル内容はReportへ出さない。
  attachments?: CodeTaskAttachment[];

  // 決定論性のため、呼び出し元が生成したタイムスタンプをそのまま使う
  // (Report Builder自身がDate.now()を呼ばない。Unit Testで同じ入力から
  // 常に同じ出力を得られるようにするため)。
  generatedAt: string;

}

// =========================
// Adapter実行ログからの実測情報抽出(ベストエフォート)
// =========================
//
// Adapter自体(core/codeAgent/*Adapter.ts)は変更しない。既に
// RunCodingTaskAttempt.executionResult.stderrへ格納済みの生ログ文字列
// から、Codex CLIが実際に標準出力する起動バナー(Phase110/111の
// Reality Testで実測確認済みの書式: "model: ...", "reasoning effort:
// ...", "tokens used\n12,345")を正規表現で抽出するだけであり、
// 実行方法そのものは一切変更しない。抽出できなかった場合はundefinedの
// まま返し、「未取得」として扱う(推測で埋めない)。
export interface ExtractedCodexRuntimeInfo {
  observedModel?: string;
  observedReasoningEffort?: string;
  observedTokenUsage?: number;
}

export function extractCodexRuntimeInfo(
  stderr: string | undefined
): ExtractedCodexRuntimeInfo {

  if (!stderr) {
    return {};
  }

  const modelMatch = stderr.match(/^model:\s*(.+)$/m);
  const effortMatch = stderr.match(/^reasoning effort:\s*(.+)$/m);
  const tokenMatch = stderr.match(/tokens used\s*\r?\n\s*([\d,]+)/);

  return {
    observedModel: modelMatch?.[1]?.trim(),
    observedReasoningEffort: effortMatch?.[1]?.trim(),
    observedTokenUsage: tokenMatch
      ? Number(tokenMatch[1].replace(/,/g, ""))
      : undefined,
  };

}

// =========================
// Agent別ランタイム情報(Section3/4/8で使う)
// =========================

export interface AgentRuntimeInfo {

  agentId: string;

  used: boolean;

  attemptCount: number;

  // このAgentの実行で発生した合計durationMs(実測、durationMsが
  // 取得できたattemptのみ合算)。
  totalDurationMs: number;

  // 環境変数からの設定値(実際にその値で実行されたことの確認ではない、
  // 「そう設定されていた」という事実のみ)。
  configuredModel?: string;

  configuredReasoningEffort?: string;

  // 実行ログから抽出できた実測値(Codexのみ、Phase113時点)。
  observedModel?: string;

  observedReasoningEffort?: string;

  observedTokenUsage?: number;

}

function collectAgentRuntimeInfo(
  attempts: RunCodingTaskAttempt[],
  agentId: string
): AgentRuntimeInfo {

  const agentAttempts = attempts.filter((a) => a.agentId === agentId);

  let observedModel: string | undefined;
  let observedReasoningEffort: string | undefined;
  let observedTokenUsage: number | undefined;

  if (agentId === "codex") {

    for (const attempt of agentAttempts) {

      const extracted = extractCodexRuntimeInfo(attempt.executionResult?.stderr);

      observedModel = observedModel ?? extracted.observedModel;
      observedReasoningEffort = observedReasoningEffort ?? extracted.observedReasoningEffort;

      if (extracted.observedTokenUsage !== undefined) {
        observedTokenUsage = (observedTokenUsage ?? 0) + extracted.observedTokenUsage;
      }

    }

  }

  const totalDurationMs = agentAttempts.reduce(
    (sum, a) => sum + (a.executionResult?.durationMs ?? 0),
    0
  );

  return {
    agentId,
    used: agentAttempts.length > 0,
    attemptCount: agentAttempts.length,
    totalDurationMs,
    configuredModel:
      agentId === "claude-code"
        ? process.env.CLAUDE_MODEL
        : agentId === "codex"
          ? process.env.CODEX_MODEL
          : undefined,
    configuredReasoningEffort:
      agentId === "codex" ? process.env.CODEX_REASONING_EFFORT : undefined,
    observedModel,
    observedReasoningEffort,
    observedTokenUsage,
  };

}

// =========================
// 構造化Summary(UI表示用)
// =========================

export interface CodingTaskReportSummary {

  taskId: string;

  status: RunCodingTaskStatus;

  finalAgent?: string;

  attemptCount: number;

  handoffCount: number;

  maxAttempts: number;

  maxAttemptsReached: boolean;

  // 全AttemptのchangedFilesを合併・重複排除したもの(順序は初出順)。
  changedFiles: string[];

  agents: AgentRuntimeInfo[];

  isAvailableCallCount: number;

  executeCallCount: number;

  totalDurationMs: number;

  verification: VerificationStatus;

  completedWork: string[];

  pendingWork: string[];

  nextAction: string;

}

export function buildCodingTaskReportSummary(
  input: CodingTaskReportInput
): CodingTaskReportSummary {

  const { result } = input;

  const changedFiles: string[] = [];

  for (const attempt of result.attempts) {

    for (const file of attempt.executionResult?.changedFiles ?? []) {

      if (!changedFiles.includes(file)) {
        changedFiles.push(file);
      }

    }

  }

  const distinctAgentIds = Array.from(
    new Set(result.attempts.map((a) => a.agentId))
  );

  const agents = distinctAgentIds.map((agentId) =>
    collectAgentRuntimeInfo(result.attempts, agentId)
  );

  const handoffAttempts = result.attempts.filter((a) => !!a.handoff);

  const lastHandoff = handoffAttempts.length > 0
    ? handoffAttempts[handoffAttempts.length - 1].handoff
    : undefined;

  const totalDurationMs = result.attempts.reduce(
    (sum, a) => sum + (a.executionResult?.durationMs ?? 0),
    0
  );

  return {
    taskId: result.taskId,
    status: result.status,
    finalAgent: result.finalAgent,
    attemptCount: result.attempts.length,
    handoffCount: handoffAttempts.length,
    maxAttempts: result.maxAttempts,
    maxAttemptsReached: result.status === "max_attempts_exceeded",
    changedFiles,
    agents,
    isAvailableCallCount: result.isAvailableCallCount,
    executeCallCount: result.attempts.length,
    totalDurationMs,
    verification: input.verification,
    // Handoffが発生していれば、最後のHandoffが保持する最新の状態を
    // 優先する(呼び出し元の初期値より新しい)。発生していなければ、
    // 呼び出し元が渡した初期値をそのまま使う(推測で更新しない)。
    completedWork: lastHandoff?.completedWork ?? input.completedWork,
    pendingWork: lastHandoff?.pendingWork ?? input.pendingWork,
    nextAction: lastHandoff?.nextAction ?? input.nextAction,
  };

}

// =========================
// Markdown Report(Section6: 12セクション構成)
// =========================

const AGENT_DISPLAY_NAME: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function displayName(agentId: string): string {
  return AGENT_DISPLAY_NAME[agentId] ?? agentId;
}

function formatGitState(state: HandoffGitState): string {

  return (
    `- branch: ${state.branch}\n` +
    `- HEAD: ${state.lastCommit}\n` +
    `- workingTree: ${state.workingTreeStatus}\n` +
    `- dirtyFileCount: ${state.dirtyFileCount ?? "未取得"}`
  );

}

function formatAgentSection(
  title: string,
  agentId: string,
  info: AgentRuntimeInfo | undefined,
  attempts: RunCodingTaskAttempt[]
): string[] {

  const lines: string[] = [`## ${title}`];

  if (!info || !info.used) {
    lines.push("", "今回のRunでは使用されていません。");
    return lines;
  }

  const agentAttempts = attempts.filter((a) => a.agentId === agentId);

  lines.push(
    "",
    `- availability: ${agentAttempts.map((a) => (a.availability.available ? "available" : "unavailable")).join(", ")}`,
    `- 設定モデル(環境変数、実行の確認ではない): ${info.configuredModel ?? "未設定(CLI既定値)"}`
  );

  if (agentId === "codex") {

    lines.push(
      `- 設定reasoning effort(環境変数): ${info.configuredReasoningEffort ?? "未設定(CLI既定値)"}`,
      `- 実測モデル(実行ログから抽出): ${info.observedModel ?? "未取得"}`,
      `- 実測reasoning effort(実行ログから抽出): ${info.observedReasoningEffort ?? "未取得"}`,
      `- 実測token使用量(実行ログから抽出): ${info.observedTokenUsage !== undefined ? info.observedTokenUsage.toLocaleString() : "未取得"}`
    );

  }

  lines.push("", "### Attempt詳細");

  agentAttempts.forEach((attempt, index) => {

    lines.push(
      `${index + 1}. exitCode=${attempt.executionResult?.exitCode ?? "未取得"}, ` +
        `timedOut=${attempt.executionResult?.timedOut ?? "未取得"}, ` +
        `duration=${attempt.executionResult?.durationMs !== undefined ? `${attempt.executionResult.durationMs}ms` : "未取得"}, ` +
        `changedFiles=${attempt.executionResult?.changedFiles.length ?? 0}件`
    );

  });

  return lines;

}

function formatAttachmentContextSection(
  attachments: CodeTaskAttachment[],
  attempts: RunCodingTaskAttempt[]
): string[] {

  const lines = ["## Attachment Context (Phase117)", ""];

  if (attachments.length === 0) {
    lines.push("- Attached files: none");
    return lines;
  }

  lines.push(`- Accepted attachments: ${attachments.length}`);

  attachments.forEach((attachment) => {
    lines.push(
      `  - ${attachment.id}: ${attachment.kind}, ${attachment.mimeType}, ` +
        `${attachment.fileName}, ${attachment.sizeBytes} bytes`
    );
  });

  lines.push("", "### Agent delivery (observed)", "");

  let deliveryObserved = false;

  attempts.forEach((attempt, index) => {
    const delivery = attempt.executionResult?.attachmentDelivery;

    if (!delivery || delivery.length === 0) {
      return;
    }

    deliveryObserved = true;
    lines.push(`- Attempt ${index + 1} (${displayName(attempt.agentId)}):`);
    delivery.forEach((item) => {
      lines.push(`  - ${item.attachmentId}: ${item.method}`);
    });
  });

  if (!deliveryObserved) {
    lines.push("- Not observed: no adapter execution result recorded attachment delivery.");
  }

  lines.push(
    "",
    "### Temporary-file cleanup",
    "",
    "- Not measured in this report: the API route performs cleanup in its finally block after this report is built."
  );

  return lines;

}

export function buildCodingTaskReportMarkdown(
  input: CodingTaskReportInput
): string {

  const summary = buildCodingTaskReportSummary(input);
  const { result } = input;

  const lines: string[] = [];

  lines.push(`# Task Report: ${input.taskId}`, "", `生成日時: ${input.generatedAt}`, "");

  // --- 1. 判定 ---
  lines.push("## 1. 判定", "");
  lines.push(`- status: ${result.status}`);
  lines.push(`- 最終Agent: ${result.finalAgent ? displayName(result.finalAgent) : "(なし)"}`);
  lines.push(
    `- 判定: ${
      result.status === "completed"
        ? "成功"
        : result.status === "max_attempts_exceeded"
          ? `失敗(maxAttempts=${summary.maxAttempts}到達)`
          : "失敗(利用可能なAgentなし)"
    }`
  );
  lines.push(`- 判定理由: ${result.reason}`, "");

  // --- 2. 実行経路 ---
  lines.push("## 2. 実行経路", "");
  lines.push(`- 要求されたAgent(UI): ${input.requestedAgent}`);
  lines.push(`- 初回Agent: ${result.attempts[0] ? displayName(result.attempts[0].agentId) : "(実行されず)"}`);
  lines.push("", "### Attempt一覧", "");

  result.attempts.forEach((attempt, index) => {

    lines.push(
      `${index + 1}. **${displayName(attempt.agentId)}** — status=${attempt.status}` +
        (attempt.handoff ? ` → Handoff → ${displayName(attempt.handoff.toAgent)}` : "")
    );

  });

  if (result.attempts.length === 0) {
    lines.push("(Attemptなし — Agent選択の時点で停止)");
  }

  lines.push("", "### Handoff履歴", "");

  const handoffAttempts = result.attempts.filter((a) => !!a.handoff);

  if (handoffAttempts.length === 0) {

    lines.push("Handoffは発生していません。");

  } else {

    handoffAttempts.forEach((attempt, index) => {

      const h = attempt.handoff!;

      lines.push(
        `${index + 1}. ${displayName(h.fromAgent)} → ${displayName(h.toAgent)}`,
        `   - reason: ${h.reason}`,
        `   - handoffId: ${h.handoffId}`,
        `   - triggered: true`,
        `   - Resume実施: ${attempt.resume?.resumed ? "はい" : "いいえ(未記録)"}`,
        `   - 次Agentへのinstruction再生成: ${attempt.resume?.instructionGenerated ? "はい" : "いいえ(未記録)"}`
      );

    });

  }

  lines.push("", `- 最終Agent: ${result.finalAgent ? displayName(result.finalAgent) : "(なし)"}`, "");

  // --- 3. Claude Code / 4. Codex ---
  lines.push(
    ...formatAgentSection(
      "3. Claude Code",
      "claude-code",
      summary.agents.find((a) => a.agentId === "claude-code"),
      result.attempts
    ),
    ""
  );

  lines.push(
    ...formatAgentSection(
      "4. Codex",
      "codex",
      summary.agents.find((a) => a.agentId === "codex"),
      result.attempts
    ),
    ""
  );

  lines.push(
    ...formatAttachmentContextSection(input.attachments ?? [], result.attempts),
    ""
  );

  // --- 5. Git状態 ---
  lines.push("## 5. Git状態", "", "### 開始時", "", formatGitState(input.gitBefore), "");
  lines.push("### 終了時", "", formatGitState(input.gitAfter), "");
  lines.push("### 差分", "");
  lines.push(
    `- HEAD変化: ${input.gitBefore.lastCommit === input.gitAfter.lastCommit ? "なし(commitしていない)" : "あり"}`
  );
  lines.push(
    `- dirtyFileCountの変化: ${input.gitBefore.dirtyFileCount ?? "未取得"} → ${input.gitAfter.dirtyFileCount ?? "未取得"}`
  );
  lines.push(`- changedFiles(Adapter報告、Attempt横断の合併): ${summary.changedFiles.length}件`);
  summary.changedFiles.forEach((f) => lines.push(`  - ${f}`));
  lines.push("");

  // --- 6. Work ---
  lines.push("## 6. Work", "");
  lines.push("### completedWork", "");
  lines.push(summary.completedWork.length > 0 ? summary.completedWork.map((w) => `- ${w}`).join("\n") : "(記録なし)");
  lines.push("", "### pendingWork", "");
  lines.push(summary.pendingWork.length > 0 ? summary.pendingWork.map((w) => `- ${w}`).join("\n") : "(記録なし)");
  lines.push("", `### nextAction`, "", summary.nextAction || "(記録なし)", "");

  // --- 7. Verification ---
  lines.push("## 7. Verification", "");
  const checks = summary.verification.checks;
  (["test", "tsc", "eslint", "build"] as const).forEach((name) => {
    lines.push(`- ${name}: ${checks[name] ?? "未実行"}`);
  });
  lines.push(`- detail: ${summary.verification.detail ?? "(なし)"}`, "");

  // --- 8. Cost / API ---
  lines.push("## 8. Cost / API", "");
  lines.push(`- isAvailable() call数(実測、全Agent合計): ${summary.isAvailableCallCount}`);
  lines.push(`- Adapter.execute() call数(実測、= LLM実行回数): ${summary.executeCallCount}`);
  summary.agents.forEach((a) => {
    lines.push(`  - ${displayName(a.agentId)}: ${a.attemptCount}回, 合計duration=${a.totalDurationMs}ms(実測)`);
  });
  const totalTokens = summary.agents.reduce(
    (sum, a) => (a.observedTokenUsage !== undefined ? sum + a.observedTokenUsage : sum),
    0
  );
  const anyTokenObserved = summary.agents.some((a) => a.observedTokenUsage !== undefined);
  lines.push(
    `- token使用量: ${anyTokenObserved ? `${totalTokens.toLocaleString()}(実行ログから抽出できた分のみ。Claude Codeのtext出力にはtoken数が含まれないため未取得)` : "未取得"}`
  );
  lines.push("- Supabase operations: 実測していない。設計上確定している最小回数は「DevelopmentTask更新1回以上」+" +
    `「Handoff発生ごとにHandoff作成/完了で2回書き込み」(今回のHandoff回数: ${summary.handoffCount})。これは推測ではなく既存実装の構造から確定する回数だが、実際のDB round-trip数そのものは計測していない。`);
  lines.push("- Search operations: 0(このFlowはSearch APIを一切呼ばない設計であり、これは確実)。", "");

  // --- 9. Risks ---
  lines.push("## 9. Risks", "");
  lines.push("### 実測した事実", "");
  lines.push(
    "- 各AttemptのexitCode/timedOut/durationMs/changedFilesは、Adapter.execute()が実際に返した値をそのまま転記したものである(推測・加工なし)。",
    "- Git状態(branch/HEAD/dirtyFileCount)は、実行前後にcore/codeAgent/gitProvider.tsのGitProvider.status()を実際に呼んで取得した値である。"
  );
  lines.push("", "### 未検証", "");
  lines.push(
    "- changedFilesに記載されたファイルの「中身」がInstructionどおりの変更かどうかは、このReportでは検証していない(ファイルパスの一覧のみ)。",
    "- Claude Codeの実際の使用モデルは、CLIのtext出力から確認できないため未検証(設定値のみ既知)。"
  );
  lines.push("", "### 推測", "");
  lines.push("- このReportに推測によって埋めた値はない(取得できない値はすべて「未取得」「未検証」と明記している)。", "");

  // --- 10. Git ---
  lines.push("## 10. Git", "");
  lines.push("- commit: していない(このFlowはcommitを一切実行しない設計)");
  lines.push("- push: していない(このFlowはpushを一切実行しない設計)");
  lines.push("- 終了時のgit status:", "", formatGitState(input.gitAfter), "");

  // --- 11. 次に必要な作業 ---
  lines.push("## 11. 次に必要な作業", "");
  if (summary.pendingWork.length > 0) {
    lines.push(...summary.pendingWork.map((w) => `- ${w}`));
  } else {
    lines.push("(pendingWorkの記録なし)");
  }
  lines.push(`- nextAction: ${summary.nextAction || "(記録なし)"}`, "");

  // --- 12. 停止点 ---
  lines.push("## 12. 停止点", "");
  lines.push(
    "このTaskの実行はここで終了している。TACT Codeはこの結果を受けて自動で別のTaskを開始することはない" +
      "(次のCoding Taskを実行するには、ユーザーがTACT Code UIから改めて入力する必要がある)。"
  );

  return lines.join("\n");

}
