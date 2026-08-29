// =========================
// ClaudeCodeAdapter(STEP142-E)
// =========================
//
// CodingAgentAdapterの具体実装。Claude Code CLI(`claude`コマンド)を
// 子プロセスとして起動し、非対話的(print mode, -p)にInstructionを
// 実行させる。
//
// 重要な安全設計:
// - execute()は、渡されたCodeTask.statusが"approved"でない場合、
//   何もせず例外を投げる(実行しない)。呼び出し元(APIルート)側の
//   ガードとは独立に、Adapter自身もこの条件を強制する
//   (二重の安全弁。人間承認を迂回する経路を作らない)。
// - `--dangerously-skip-permissions`は、非対話プロセスとして
//   ファイル変更を行うために必要なフラグ(対話プロンプトが出せない
//   環境のため)。このAdapterはstatus==="approved"のTaskにしか
//   使わないため、「人間が承認したTaskに対してのみ」この権限で
//   動く、という設計にしている。
// - 実行不可(claude CLIが見つからない等)の場合はisAvailable()が
//   available:falseを返す。呼び出し側はこれを見て、実行せずに
//   ステータスをfailedにする(架空の実行成功を報告しない)。
//
// Windows固有の注意(実機検証で判明):
// - npmがグローバルインストールするCLI(claude等)は実体が
//   `claude.cmd`であり、Node.jsは(CVE-2024-27980対応後)
//   shell:trueなしでは.cmd/.batを直接起動できない
//   (shell:trueなしでspawnすると同期的にEINVAL例外を投げる)。
//   そのためshell:trueは必須。
// - ただしshell:trueで動的な文字列(Instruction本文)をCLI引数として
//   渡すと、Node.js自身が"DEP0190"として警告する通り、
//   シェルインジェクションのリスクがある(cmd.exeへの引数は
//   安全にエスケープされない)。
//   このため、Instruction本文は**CLI引数として渡さず、
//   子プロセスのstdinへ書き込む**設計にした
//   (`claude -p`は標準入力からプロンプトを読み取れる。これは
//   `cat file | claude -p`という一般的な利用パターンと同じ)。
//   shell:trueで渡すargsは固定の静的フラグのみとし、
//   ユーザー/LLM由来の可変文字列を一切含めない。

import { execFile, spawn } from "node:child_process";

import {
  CodeTask,
  CodeTaskAttachmentDelivery,
  CodeTaskExecutionResult,
  CodingAgentAdapter,
} from "./types";
import { buildClaudeCodeAttachmentBlock } from "./attachmentContext";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10分

const OUTPUT_CAPTURE_LIMIT = 20000;

// git status --porcelainで、変更されたファイルパスの集合を取る。
// 「Claude Codeが何を変更したか」を、Claude Code自身の自己申告
// ではなく、Git(既存ツール)による客観的な差分で確認するための
// ものであり、新しい依存は追加しない。
// gitはWindows上でも実体が.exeであり、shell:trueは不要
// (静的引数のみなので、そもそも動的引数の注入リスクもない)。
//
// Phase110: CodexAdapter(core/codeAgent/codexAdapter.ts)も同じ
// changedFiles検出の仕組みをそのまま再利用する(「既存の仕組みで
// 取得できる」絶対条件、重複実装しない)ため、exportする。
// ロジック自体は変更していない。
export async function snapshotChangedFiles(
  repositoryPath: string
): Promise<Set<string>> {

  const result = await new Promise<{ exitCode: number | null; stdout: string }>(
    (resolve) => {

      execFile(
        "git",
        ["status", "--porcelain"],
        { cwd: repositoryPath, timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout) => {

          const exitCode =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;

          resolve({ exitCode, stdout: stdout ?? "" });

        }
      );

    }
  );

  if (result.exitCode !== 0) {
    return new Set();
  }

  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\S+\s+/, ""));

  return new Set(files);

}

// before/after 2つのgit status --porcelainスナップショットから、
// 「今回の実行で新たに変更されたと観測できるファイル一覧」を決定論的に合成する。
// ClaudeCodeAdapter.execute()とCodexAdapter.execute()(Phase110)の
// 両方が同じ規約を使うため、ここに抽出して共有する。実行前からdirty
// だったファイルは今回のAgent実行による変更と実測できないため、結果へ
// 含めない。実行前後のGit状態全体は別途Reportに保持される。
export function computeChangedFiles(
  before: Set<string>,
  after: Set<string>
): string[] {

  const changedFiles =
    Array.from(after).filter(
      (file) => !before.has(file)
    );

  return changedFiles;

}

// claude --version(固定・静的な引数のみ)の実行。
// shell:trueは.cmd解決のために必須だが、引数はすべて固定文字列
// なので動的な値の注入リスクはない。
//
// Phase107(Repository Evidence: Phase106投資調査): 拡張子なしの
// "claude"をexecFile(..., {shell:true})へ渡すと、この環境では
// (PATHEXTに.CMDが含まれ、対話シェルからの`claude --version`や
// `cmd.exe /c "claude --version"`は成功するにもかかわらず)
// 子プロセスが実行されず`code:null`・空stdout/stderrで失敗することを
// 実機で確認した。`"claude.cmd"`と拡張子を明示すると同条件で成功する
// (Phase106で切り分け済み)。挙動を変えるのはコマンド名の拡張子
// だけであり、shell:true・引数・timeout等は無変更。
function checkClaudeVersion(): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {

  return new Promise((resolve) => {

    execFile(
      "claude.cmd",
      ["--version"],
      { cwd: process.cwd(), timeout: 10_000, shell: true },
      (error, stdout, stderr) => {

        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;

        resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });

      }
    );

  });

}

// claude -p を、Instruction本文をCLI引数に含めずstdin経由で実行する。
// argsは全て固定の静的フラグ + Adapterの設定(コンストラクタ引数/
// 環境変数)由来のmodel値のみ(Task本文由来の可変文字列は一切含まない)
// ため、shell:trueによるcmd.exe解釈を経ても、シェルインジェクションの
// 余地がない。
//
// Phase107: checkClaudeVersion()と同じ理由で"claude.cmd"を明示する
// (Phase106投資調査、この環境ではshell:true経由の拡張子なし
// "claude"解決が失敗するため)。
//
// Phase111(Section5): CodexAdapter.tsと対になる形で、modelを
// コンストラクタ/環境変数(CLAUDE_MODEL)から注入できるようにする
// (絶対条件: 今回、既定モデルを勝手に変更しない。未指定時はCLI自身の
// 既定モデルのまま、Phase108〜110と挙動は完全に同じ)。
function runClaudeWithStdin(
  instruction: string,
  options: { cwd: string; timeout: number; model?: string }
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {

  const args = [
    "-p",
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  return new Promise((resolve) => {

    const child = spawn(
      "claude.cmd",
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        shell: true,
      }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < OUTPUT_CAPTURE_LIMIT) {
        stdout += chunk.toString();
      }
    });

    child.stderr?.on("data", (chunk) => {
      if (stderr.length < OUTPUT_CAPTURE_LIMIT) {
        stderr += chunk.toString();
      }
    });

    child.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + "\n" + String(err),
        timedOut: false,
      });
    });

    child.on("close", (code, signal) => {
      if (signal === "SIGTERM") {
        timedOut = true;
      }
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
      });
    });

    // Instruction本文はここでstdinへ書き込む。CLI引数には一切
    // 含めない(上記コメント参照)。
    child.stdin?.write(instruction);
    child.stdin?.end();

  });

}

export interface ClaudeCodeAdapterConfig {

  // 未指定時はCLI自身の既定モデルのまま(Phase111では既定値を変更しない)。
  model?: string;

}

export class ClaudeCodeAdapter implements CodingAgentAdapter {

  readonly id = "claude-code";

  private readonly model?: string;

  constructor(config: ClaudeCodeAdapterConfig = {}) {

    this.model = config.model ?? process.env.CLAUDE_MODEL;

  }

  async isAvailable(): Promise<{
    available: boolean;
    detail: string;
  }> {

    const result = await checkClaudeVersion();

    if (result.exitCode === 0) {
      return {
        available: true,
        detail: result.stdout.trim(),
      };
    }

    return {
      available: false,
      detail:
        result.stderr.trim() ||
        `claude --version exited with code ${result.exitCode}`,
    };

  }

  async execute(
    task: CodeTask
  ): Promise<CodeTaskExecutionResult> {

    if (task.status !== "approved") {

      throw new Error(
        `CodeTask ${task.id} is not approved (status=${task.status}). ` +
        "ClaudeCodeAdapter.execute() refuses to run unapproved tasks."
      );

    }

    const startedAt = Date.now();

    // Phase117: 添付ファイル(参考資料)は、Instruction本文の末尾へ
    // 「実体のファイルパス」として追記する。Phase117時点のClaude Code
    // CLI(`claude --help`で確認)には画像を直接添付するオプションが
    // 存在しないため、Claude Code自身のRead tool(画像ファイルを画像
    // として読める)にファイルを開かせるのが、現状のCLI仕様で画像の
    // 情報を失わずに渡せる唯一の方式である(説明文へ変換して渡す設計は
    // 採らない、Phase117絶対条件)。stdin経由で渡す点はPhase116までと
    // 同じで、CLI引数は一切変更していない(shell:true下のargv注入
    // リスクを増やさない)。
    const attachments = task.attachments ?? [];

    const attachmentBlock = buildClaudeCodeAttachmentBlock(attachments);

    const attachmentDelivery: CodeTaskAttachmentDelivery[] = attachments.map(
      (attachment) => ({
        attachmentId: attachment.id,
        method: "prompt_path_reference",
        detail:
          `Instruction末尾に実体パス(${attachment.filePath})を記載し、` +
          "Claude Code自身のRead toolで画像として開かせる方式で渡した" +
          "(Phase117時点のclaude CLIには画像添付オプションが存在しない)。",
      })
    );

    const before =
      await snapshotChangedFiles(task.repositoryPath);

    const result = await runClaudeWithStdin(
      task.instruction + attachmentBlock,
      {
        cwd: task.repositoryPath,
        timeout: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        model: this.model,
      }
    );

    const after =
      await snapshotChangedFiles(task.repositoryPath);

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, OUTPUT_CAPTURE_LIMIT),
      stderr: result.stderr.slice(0, OUTPUT_CAPTURE_LIMIT),
      changedFiles: computeChangedFiles(before, after),
      durationMs: Date.now() - startedAt,
      timedOut: result.timedOut,
      attachmentDelivery:
        attachmentDelivery.length > 0 ? attachmentDelivery : undefined,
    };

  }

}
