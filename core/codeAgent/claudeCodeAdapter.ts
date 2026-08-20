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
  CodeTaskExecutionResult,
  CodingAgentAdapter,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10分

const OUTPUT_CAPTURE_LIMIT = 20000;

// git status --porcelainで、変更されたファイルパスの集合を取る。
// 「Claude Codeが何を変更したか」を、Claude Code自身の自己申告
// ではなく、Git(既存ツール)による客観的な差分で確認するための
// ものであり、新しい依存は追加しない。
// gitはWindows上でも実体が.exeであり、shell:trueは不要
// (静的引数のみなので、そもそも動的引数の注入リスクもない)。
async function snapshotChangedFiles(
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

// claude --version(固定・静的な引数のみ)の実行。
// shell:trueは.cmd解決のために必須だが、引数はすべて固定文字列
// なので動的な値の注入リスクはない。
function checkClaudeVersion(): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {

  return new Promise((resolve) => {

    execFile(
      "claude",
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
// argsは全て固定の静的フラグのみ(動的文字列を一切含まない)ため、
// shell:trueによるcmd.exe解釈を経ても、シェルインジェクションの
// 余地がない。
function runClaudeWithStdin(
  instruction: string,
  options: { cwd: string; timeout: number }
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {

  return new Promise((resolve) => {

    const child = spawn(
      "claude",
      [
        "-p",
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
      ],
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

export class ClaudeCodeAdapter implements CodingAgentAdapter {

  readonly id = "claude-code";

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

    const before =
      await snapshotChangedFiles(task.repositoryPath);

    const result = await runClaudeWithStdin(
      task.instruction,
      {
        cwd: task.repositoryPath,
        timeout: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }
    );

    const after =
      await snapshotChangedFiles(task.repositoryPath);

    const changedFiles =
      Array.from(after).filter(
        (file) => !before.has(file)
      );

    // beforeの時点で既に変更されていたファイルが、実行後も
    // 引き続き変更されている場合も、承認されたTaskの結果として
    // 報告する(実行前後で変化がなかったファイルのみ除外する)。
    const stillChanged =
      Array.from(before).filter(
        (file) => after.has(file)
      );

    const allChanged =
      Array.from(
        new Set([...changedFiles, ...stillChanged])
      );

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, OUTPUT_CAPTURE_LIMIT),
      stderr: result.stderr.slice(0, OUTPUT_CAPTURE_LIMIT),
      changedFiles: allChanged,
      durationMs: Date.now() - startedAt,
      timedOut: result.timedOut,
    };

  }

}
