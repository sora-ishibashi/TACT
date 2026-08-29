"use client";

// =========================
// CodeSection (Phase112、Phase113で完了報告、Phase114〜116で実用化)
// =========================
//
// TACT Code UI。core/tact-agent/のAgent Orchestrator基盤
// (Phase104〜111: CodingAgentAdapter/selectCodingAgent/runAgentHandoff/
// runCodingTask)を、ユーザーが自由入力したCoding Task経由で操作できる
// ようにする最初のUI。
//
// 絶対条件(Phase112 Section0、Phase114〜116でも維持): UI側に
// Claude/Codexの切替ロジックを直接書かない。UIはAgent選択の意思
// (agent: "auto"|"claude-code"|"codex")・maxAttempts・
// verificationModeをPOST /api/tact/code-tasks/run へ渡すだけで、実際の
// Agent選択・Adapter呼び出し・Handoff・Resume・VerificationはAPI側の
// runCodingTask()/runVerification()(Orchestrator/Verification Runner)
// がすべて行う。shellコマンドの生成・実行はUIから一切行わない。
//
// Phase112 Section9: リアルタイムストリーミング機構(WebSocket/SSE)は
// 既存実装に存在しないため、今回も新規実装しない(Phase115でも
// 踏襲)。Activityログは API完了後にresult.attemptsから再構成した
// 要約であり、真のリアルタイムイベントタイムスタンプではない
// (下記buildActivityLog()参照)。実行中のExecution表示も、リクエスト
// 完了までは「最初に試行されるAgent」を推定表示するだけの近似であり、
// Handoffが実際に何回発生するかはレスポンスが返るまで分からない
// (架空の途中経過を作らない、既存の設計方針をそのまま維持)。
//
// Phase113: APIが追加したreport(summary/markdown、
// core/tact-agent/codingTaskReport.tsが機械的に生成)をそのまま表示する
// だけで、UI側で報告内容を作文・再計算しない(推測で埋めない、という
// 絶対条件をUI層でも維持する)。
//
// Phase115: 開発環境限定のHandoffテスト経路(simulateHandoffTest)を
// 追加した。process.env.NODE_ENV(Next.jsが自動設定する値、新しい
// 環境変数は作らない)が"production"でない場合のみUIに表示する。
// 実際の有効化・実行はAPI側(app/api/tact/code-tasks/run/route.ts)が
// 二重に判定する(UI側の非表示だけに依存しない)。

import { useEffect, useRef, useState } from "react";

type AgentChoice = "auto" | "claude-code" | "codex";

const AGENT_CHOICES: { id: AgentChoice; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

const AGENT_DISPLAY_NAME: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function displayName(agentId: string): string {
  return AGENT_DISPLAY_NAME[agentId] ?? agentId;
}

type AttemptResult = {
  agentId: string;
  status: "success" | "failure" | "unavailable" | "interrupted";
  exitCode: number | null;
  timedOut: boolean;
  changedFiles: string[];
  durationMs?: number;
  stdout?: string;
  handoff?: {
    handoffId: string;
    fromAgent: string;
    toAgent: string;
    reason: string;
  };
  // Phase115: Handoffが発生したAttemptについて、Resumeが実際に
  // 行われたかを示す(推測しない、APIがそのまま転記した値)。
  resume?: {
    resumed: boolean;
    instructionGenerated: boolean;
  };
};

type VerificationChoice = "none" | "quick" | "full";

const VERIFICATION_CHOICES: { id: VerificationChoice; label: string }[] = [
  { id: "none", label: "なし" },
  { id: "quick", label: "Quick" },
  { id: "full", label: "Full" },
];

// Phase113: APIのreport.summary(core/tact-agent/codingTaskReport.ts
// CodingTaskReportSummary)と構造的に対応する、UI側の最小限の型。
type ReportAgentInfo = {
  agentId: string;
  used: boolean;
  attemptCount: number;
  totalDurationMs: number;
  configuredModel?: string;
  configuredReasoningEffort?: string;
  observedModel?: string;
  observedReasoningEffort?: string;
  observedTokenUsage?: number;
};

type ReportSummary = {
  taskId: string;
  status: string;
  finalAgent?: string;
  attemptCount: number;
  handoffCount: number;
  maxAttempts: number;
  maxAttemptsReached: boolean;
  changedFiles: string[];
  agents: ReportAgentInfo[];
  isAvailableCallCount: number;
  executeCallCount: number;
  totalDurationMs: number;
  verification: { checks: Record<string, string>; detail?: string };
  completedWork: string[];
  pendingWork: string[];
  nextAction: string;
};

type TaskReport = {
  summary: ReportSummary;
  markdown: string;
};

type RunResponse = {
  success: boolean;
  status?: "completed" | "unavailable" | "max_attempts_exceeded";
  taskId?: string;
  currentAgent?: string;
  finalAgent?: string;
  handoffOccurred?: boolean;
  verificationMode?: VerificationChoice;
  attempts?: AttemptResult[];
  message?: string;
  error?: string;
  report?: TaskReport;
};

type ExecutionLogEntry = {
  timestamp: string;
  message: string;
};

type StreamEvent =
  | { type: "log"; log: ExecutionLogEntry }
  | { type: "result"; result: RunResponse }
  | { type: "error"; error: string };

type LocalImageAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

const MAX_ATTACHMENT_COUNT = 4;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ACCEPTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function formatFileSize(sizeBytes: number): string {

  return sizeBytes >= 1024 * 1024
    ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(sizeBytes / 1024))} KB`;

}

// markdown文字列から、"## N. 見出し"〜次の"## "直前までを取り出す
// (Risksセクションの文面はcore/tact-agent/codingTaskReport.ts側にしか
// 存在しないため、UI側で再計算・再作文せず、生成済みテキストをそのまま
// 抜き出して表示するだけに留める)。
function extractMarkdownSection(markdown: string, heading: string): string {

  const startIndex = markdown.indexOf(heading);

  if (startIndex === -1) {
    return "";
  }

  const afterHeading = markdown.slice(startIndex + heading.length);
  const nextHeadingIndex = afterHeading.indexOf("\n## ");

  return (
    nextHeadingIndex === -1
      ? afterHeading
      : afterHeading.slice(0, nextHeadingIndex)
  ).trim();

}

export default function CodeSection() {

  const [instruction, setInstruction] = useState("");
  const [agent, setAgent] = useState<AgentChoice>("auto");
  // Phase114: maxAttemptsは空文字="Orchestratorの既定値(3)"を意味する
  // (未指定の場合にrunCodingTask()側の既定値をそのまま使う、既存の
  // 後方互換動作を崩さない)。
  const [maxAttemptsInput, setMaxAttemptsInput] = useState("");
  // Phase116: 既定は"quick"(tsc --noEmitのみ)。「なし」も選べるように
  // し、既存(Phase112/113)の「Verification未実行」動作も引き続き
  // 選択可能にする。
  const [verificationMode, setVerificationMode] = useState<VerificationChoice>("quick");
  const [attachments, setAttachments] = useState<LocalImageAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [executionLog, setExecutionLog] = useState<ExecutionLogEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 二重送信防止(既存Chat UIと同じ方針)。loadingフラグに加え、
  // 実行中フラグをrefでも保持し、連続Enter押下による競合を防ぐ。
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentSequenceRef = useRef(0);
  const previewUrlsRef = useRef(new Map<string, string>());

  useEffect(() => {
    const previewUrls = previewUrlsRef.current;

    return () => {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      previewUrls.clear();
    };

  }, []);

  function removeAttachment(attachmentId: string) {

    const previewUrl = previewUrlsRef.current.get(attachmentId);

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrlsRef.current.delete(attachmentId);
    }

    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId)
    );

  }

  function handleAttachmentSelection(
    event: React.ChangeEvent<HTMLInputElement>
  ) {

    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";

    if (selectedFiles.length === 0) {
      return;
    }

    const invalidFile = selectedFiles.find(
      (file) =>
        !ACCEPTED_IMAGE_MIME_TYPES.has(file.type) ||
        file.size === 0 ||
        file.size > MAX_ATTACHMENT_BYTES
    );

    if (invalidFile) {
      setErrorMessage(
        `添付できるのは10MB以下のPNG / JPEG / WebP画像です: ${invalidFile.name}`
      );
      return;
    }

    const proposedCount = attachments.length + selectedFiles.length;
    const proposedBytes =
      attachments.reduce((sum, attachment) => sum + attachment.file.size, 0) +
      selectedFiles.reduce((sum, file) => sum + file.size, 0);

    if (proposedCount > MAX_ATTACHMENT_COUNT) {
      setErrorMessage(`画像は最大${MAX_ATTACHMENT_COUNT}枚まで添付できます`);
      return;
    }

    if (proposedBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      setErrorMessage("添付画像の合計サイズは20MB以下にしてください");
      return;
    }

    const newAttachments = selectedFiles.map((file) => {
      attachmentSequenceRef.current += 1;
      const id = `local-attachment-${attachmentSequenceRef.current}`;
      const previewUrl = URL.createObjectURL(file);
      previewUrlsRef.current.set(id, previewUrl);
      return { id, file, previewUrl };
    });

    setAttachments((current) => [...current, ...newAttachments]);
    setErrorMessage(null);

  }

  async function handleSubmit() {

    const trimmed = instruction.trim();

    if (!trimmed || submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setLoading(true);
    setErrorMessage(null);
    setResult(null);
    setExecutionLog([]);

    try {

      const parsedMaxAttempts = Number(maxAttemptsInput);

      const formData = new FormData();
      formData.set("instruction", trimmed);
      formData.set("agent", agent);
      formData.set("verificationMode", verificationMode);

      if (
        maxAttemptsInput.trim() &&
        Number.isFinite(parsedMaxAttempts) &&
        parsedMaxAttempts > 0
      ) {
        formData.set("maxAttempts", String(parsedMaxAttempts));
      }

      attachments.forEach((attachment) => {
        formData.append("attachments", attachment.file, attachment.file.name);
      });

      const response = await fetch("/api/tact/code-tasks/run", {
        method: "POST",
        body: formData,
        headers: { Accept: "application/x-ndjson" },
      });

      if (!response.ok) {

        const body: RunResponse = await response.json();

        setErrorMessage(
          body.error ?? `実行に失敗しました(HTTP ${response.status})`
        );
        return;

      }

      if (!response.body) {
        throw new Error("The execution log stream was not available.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedResult: RunResponse | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line) {
              continue;
            }

            const event = JSON.parse(line) as StreamEvent;

            if (event.type === "log") {
              setExecutionLog((current) => [...current, event.log]);
            } else if (event.type === "result") {
              streamedResult = event.result;
            } else {
              throw new Error(event.error);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!streamedResult) {
        throw new Error("The execution finished without a result payload.");
      }

      setResult(streamedResult);

    } catch (error) {

      console.error("TACT Code run API call failed:", error);
      setErrorMessage("TACT Codeとの通信に失敗しました");

    } finally {

      submittingRef.current = false;
      setLoading(false);

    }

  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }

  }

  async function handleCopyReport() {

    if (!result?.report?.markdown) {
      return;
    }

    try {
      await navigator.clipboard.writeText(result.report.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy report to clipboard:", error);
    }

  }

  const activityLog = executionLog;

  // Execution欄に表示するAgent一覧。実行中はまだattemptsが無いため、
  // ユーザーが選んだ候補(autoならclaude-code/codexの両方)を
  // "Waiting"として仮表示する。完了後はresult.attemptsの実データに
  // 置き換える(架空の途中経過を作らない——実行中の暫定表示である
  // ことをUI上「Waiting」という文言で示す)。
  const candidateAgentsForDisplay: string[] = [];

  return (

    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-6 py-5">

      <h2 className="text-sm font-semibold text-gray-900">TACT Code</h2>
      <p className="mt-1 text-xs text-gray-400">
        実装したい内容を入力すると、Claude Code / Codexが実際にコードを変更します。
      </p>

      <div className="mt-4 flex flex-col gap-3">

        <div>

          <p className="mb-1 text-xs font-medium text-gray-500">Coding Task</p>

          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ここに実装したい内容を入力(Enterで実行、Shift+Enterで改行)"
            rows={5}
            disabled={loading}
            className="w-full resize-none rounded-xl border border-gray-300 p-3 text-sm outline-none placeholder:text-gray-400 disabled:bg-gray-50"
          />

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={loading}
              onChange={handleAttachmentSelection}
              className="sr-only"
              aria-label="参考画像を添付"
            />
            <button
              type="button"
              disabled={loading}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
            >
              画像を添付
            </button>
            <span className="text-[11px] text-gray-400">
              PNG / JPEG / WebP・最大4枚・1枚10MB・合計20MB
            </span>
          </div>

          {attachments.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2" aria-label="添付画像">
              {attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className="relative flex w-36 flex-col overflow-hidden rounded-lg border border-gray-200 bg-gray-50"
                >
                  {/* Object URLs cannot be optimized by next/image. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={attachment.previewUrl}
                    alt={`${attachment.file.name}のプレビュー`}
                    className="h-20 w-full object-cover"
                  />
                  <div className="min-w-0 px-2 py-1.5">
                    <p className="truncate text-[11px] text-gray-700" title={attachment.file.name}>
                      {attachment.file.name}
                    </p>
                    <p className="text-[10px] text-gray-400">
                      {formatFileSize(attachment.file.size)}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => removeAttachment(attachment.id)}
                    className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] text-white hover:bg-black disabled:opacity-50"
                    aria-label={`${attachment.file.name}を解除`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

        </div>

        <div className="flex items-center gap-3">

          <span className="text-xs font-medium text-gray-500">Agent</span>

          <div className="flex gap-1">

            {AGENT_CHOICES.map((choice) => (

              <button
                key={choice.id}
                type="button"
                disabled={loading}
                onClick={() => setAgent(choice.id)}
                className={`rounded-full px-3 py-1 text-xs disabled:opacity-50 ${
                  agent === choice.id
                    ? "bg-black text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {choice.label}
              </button>

            ))}

          </div>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || !instruction.trim()}
            className="ml-auto rounded-lg bg-black px-4 py-1.5 text-xs text-white transition hover:bg-gray-800 disabled:opacity-50"
          >
            {loading ? "実行中..." : "実行"}
          </button>

        </div>

        <div className="flex flex-wrap items-center gap-4">

          <div className="flex items-center gap-2">

            <span className="text-xs font-medium text-gray-500">Verification</span>

            <div className="flex gap-1">

              {VERIFICATION_CHOICES.map((choice) => (

                <button
                  key={choice.id}
                  type="button"
                  disabled={loading}
                  onClick={() => setVerificationMode(choice.id)}
                  className={`rounded-full px-3 py-1 text-xs disabled:opacity-50 ${
                    verificationMode === choice.id
                      ? "bg-black text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {choice.label}
                </button>

              ))}

            </div>

          </div>

          <label className="flex items-center gap-2 text-xs text-gray-500">
            maxAttempts
            <input
              type="number"
              min={1}
              max={10}
              value={maxAttemptsInput}
              onChange={(e) => setMaxAttemptsInput(e.target.value)}
              disabled={loading}
              placeholder="既定(3)"
              className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-xs outline-none disabled:bg-gray-50"
            />
          </label>

        </div>

      </div>

      <hr className="my-5 border-gray-200" />

      <div>

        <p className="mb-2 text-xs font-medium text-gray-500">Execution</p>

        {!loading && !result && (
          <p className="text-sm text-gray-400">まだ実行していません。</p>
        )}

        {loading && (

          <ul className="space-y-1.5">

            {candidateAgentsForDisplay.map((agentId, index) => (

              <li key={agentId} className="flex items-center gap-2 text-sm">
                <span className={index === 0 ? "text-amber-500" : "text-gray-300"}>
                  {index === 0 ? "●" : "○"}
                </span>
                <span className="text-gray-900">{displayName(agentId)}</span>
                <span className="text-xs text-gray-400">
                  {index === 0 ? "Running" : "Waiting"}
                </span>
              </li>

            ))}

          </ul>

        )}

        {!loading && result && (

          <div className="flex flex-col gap-1">

            {(result.attempts ?? []).map((attempt, index) => (

              <div key={`${attempt.agentId}-${index}`}>

                <div className="flex items-center gap-2 text-sm">
                  <span
                    className={
                      attempt.status === "success"
                        ? "text-green-600"
                        : "text-red-500"
                    }
                  >
                    {attempt.status === "success" ? "✓" : "✗"}
                  </span>
                  <span className="text-gray-900">{displayName(attempt.agentId)}</span>
                  <span className="text-xs text-gray-400">
                    {attempt.status === "success"
                      ? "Completed"
                      : attempt.status === "unavailable"
                        ? "Unavailable"
                        : attempt.status === "interrupted"
                          ? "Timed out"
                          : "Failed"}
                  </span>
                </div>

                {attempt.handoff && (
                  // Phase115: Claude Code → Failure → Handoff → Codex → Resume
                  // という流れを、既存のattempt.status/attempt.handoff/
                  // attempt.resume(いずれもrunCodingTask()が実際に記録した
                  // 値、推測で補完しない)からそのまま可視化する。
                  <div className="ml-2.5 flex flex-col gap-0.5 border-l border-dashed border-gray-300 py-1 pl-4 text-xs text-gray-400">
                    <span>↓ {attempt.status === "interrupted" ? "Timeout" : attempt.status === "unavailable" ? "Unavailable" : "Failure"}</span>
                    <span>↓ Handoff({attempt.handoff.reason})</span>
                    <span>↓ {displayName(attempt.handoff.toAgent)}へ引き継ぎ</span>
                    <span>
                      ↓ Resume: {attempt.resume?.resumed ? "実施済み" : "未記録"}
                      {attempt.resume?.instructionGenerated ? "(Instruction再生成あり)" : ""}
                    </span>
                  </div>
                )}

              </div>

            ))}

            <div className="mt-2 text-sm font-medium">
              {result.status === "completed" ? (
                <span className="text-green-600">✓ Completed — {displayName(result.finalAgent ?? "")}</span>
              ) : result.status === "max_attempts_exceeded" ? (
                <span className="text-red-600">✗ Failed(試行上限に到達)</span>
              ) : (
                <span className="text-red-600">✗ 利用可能なCoding Agentがありません</span>
              )}
            </div>

            {result.handoffOccurred && (
              <p className="mt-1 text-xs text-gray-500">
                Agent間でHandoffが発生しました(Task ID: {result.taskId})。
              </p>
            )}

          </div>

        )}

        {errorMessage && (
          <p className="mt-2 text-sm text-red-600">{errorMessage}</p>
        )}

      </div>

      {result?.report && (

        <>

          <hr className="my-5 border-gray-200" />

          <div>

            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-gray-500">完了報告</p>
              <button
                type="button"
                onClick={handleCopyReport}
                className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
              >
                {copied ? "コピーしました" : "Copy Report"}
              </button>
            </div>

            <div className="flex flex-col gap-4 text-sm">

              {/* Summary */}
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-500">Summary</p>
                <p className="text-gray-700">
                  status: <span className="font-medium text-gray-900">{result.report.summary.status}</span>
                  {" / "}
                  最終Agent: <span className="font-medium text-gray-900">
                    {result.report.summary.finalAgent ? displayName(result.report.summary.finalAgent) : "(なし)"}
                  </span>
                  {" / "}
                  試行回数: {result.report.summary.attemptCount} / {result.report.summary.maxAttempts}
                  {" / "}
                  Handoff回数: {result.report.summary.handoffCount}
                </p>
              </div>

              {/* Agent / Attempts */}
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-500">Agent / Attempts</p>
                <ul className="space-y-1">
                  {result.report.summary.agents.map((a) => (
                    <li key={a.agentId} className="text-gray-700">
                      {displayName(a.agentId)}: {a.attemptCount}回実行, 合計{a.totalDurationMs}ms
                      {a.agentId === "codex" && (
                        <>
                          {" "}(model: {a.observedModel ?? "未取得"}, reasoning effort: {a.observedReasoningEffort ?? "未取得"},
                          {" "}token使用量: {a.observedTokenUsage !== undefined ? a.observedTokenUsage.toLocaleString() : "未取得"})
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Handoff */}
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-500">Handoff</p>
                <p className="text-gray-700">
                  {result.report.summary.handoffCount > 0
                    ? `${result.report.summary.handoffCount}回発生しました(詳細はFull Report参照)。`
                    : "発生していません。"}
                </p>
              </div>

              {/* Changed Files */}
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-500">
                  Changed Files({result.report.summary.changedFiles.length}件)
                </p>
                {result.report.summary.changedFiles.length === 0 ? (
                  <p className="text-gray-400">なし</p>
                ) : (
                  <ul className="max-h-32 overflow-y-auto text-xs text-gray-600">
                    {result.report.summary.changedFiles.map((f) => (
                      <li key={f} className="font-mono">{f}</li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Verification(Phase116: 実行結果を実測値としてそのまま表示、
                  実行していないCheckを"未実行"以外で表示しない) */}
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-500">
                  Verification({result.verificationMode ?? "quick"})
                </p>
                <div className="flex flex-wrap gap-3">
                  {(["tsc", "eslint", "test", "build"] as const).map((name) => {
                    const value = result.report!.summary.verification.checks[name];
                    const label =
                      value === "passed" ? "✓ passed" : value === "failed" ? "✗ failed" : "未実行";
                    const colorClass =
                      value === "passed"
                        ? "text-green-600"
                        : value === "failed"
                          ? "text-red-600"
                          : "text-gray-400";
                    return (
                      <span key={name} className={`text-xs ${colorClass}`}>
                        {name}: {label}
                      </span>
                    );
                  })}
                </div>
                {result.report.summary.verification.detail && (
                  <p className="mt-1 text-xs text-gray-400">{result.report.summary.verification.detail}</p>
                )}
              </div>

              {/* Cost */}
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-500">Cost</p>
                <p className="text-gray-700">
                  isAvailable() call数: {result.report.summary.isAvailableCallCount}
                  {" / "}
                  実行(execute) call数: {result.report.summary.executeCallCount}
                  {" / "}
                  合計実行時間: {result.report.summary.totalDurationMs}ms
                </p>
              </div>

              {/* Risks */}
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-500">Risks</p>
                <pre className="whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-xs text-gray-600">
                  {extractMarkdownSection(result.report.markdown, "## 9. Risks") || "(記録なし)"}
                </pre>
              </div>

              {/* Full Report */}
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-500">Full Report</p>
                <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
                  {result.report.markdown}
                </pre>
              </div>

            </div>

          </div>

        </>

      )}

      <hr className="my-5 border-gray-200" />

      <div>

        <p className="mb-2 text-xs font-medium text-gray-500">Execution Log</p>

        {activityLog.length === 0 ? (

          <p className="text-sm text-gray-400">
            {loading ? "Waiting for server events..." : "No execution log is available."}
          </p>

        ) : (

          <ul className="space-y-1 text-sm text-gray-600">
            {activityLog.map((line, index) => (
              <li key={`${line.timestamp}-${index}`}>
                [{new Date(line.timestamp).toLocaleTimeString()}] {line.message}
              </li>
            ))}
          </ul>

        )}

      </div>

    </div>

  );

}
