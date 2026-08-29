// =========================
// Verification Runner(Phase116)
// =========================
//
// Coding Agent実行(runCodingTask())が完了した後、実際に
// `tsc --noEmit` / `npm test` / `eslint` / `npm run build` を子プロセスと
// して実行し、core/tact-agent/types.tsの既存VerificationStatus型
// (Phase104から存在、無変更)へ実測結果を格納する。
//
// 絶対条件(Phase116): 実行していないCheckをpassedにしない。timeoutや
// 例外はfailedとして扱い、"未取得の成功"を作らない。
//
// 依存方向: core/tact-agent/gitState.tsが既にcore/codeAgent/
// gitProvider.tsを再利用している一方向依存(tact-agent → codeAgent)を
// 踏襲するが、このファイル自体はcore/codeAgent/を一切importしない
// (tsc/npm test/eslint/npm run buildはCoding Agent Adapterとは無関係な、
// プロジェクト全体に対する独立したCLI呼び出しであり、既存
// core/codeAgent/*Adapter.tsの実行方式(claude/codex CLI起動)とは無関係
// なため、依存を増やさない)。
//
// 既存機構の再利用: app/api/tact/code-tasks/execute/route.tsの
// runTypecheck()(STEP142-F、非export)と同じ`execFile("npx", [...],
// {shell:true})`パターンをそのまま踏襲する(Windows上npx/npmの実体は
// .cmdだが、拡張子なしのままshell:true経由で解決できることを
// 既存route.tsが実運用で確認済みのため、同じ方式を再利用する。
// claude/codex CLIとは異なり、npx/npmはNode.js本体に同梱される
// バイナリであり、Phase106/107で発見された拡張子省略解決の問題とは
// 別の実体であるため、既存の成功パターンをそのまま使う)。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { VerificationStatus, VerificationCheckName, VerificationCheckResult } from "./types";

export type VerificationMode = "none" | "quick" | "full";

export interface RunVerificationOptions {

  mode: VerificationMode;

  repositoryPath: string;

  // Full modeでのESLintを、今回のTaskが実際に変更したファイルだけに
  // 絞り込むために使う(既存Legacyの無関係なエラーと、今回のAgentの
  // 変更を混同しないため)。
  changedFiles: string[];

  // Phase118: 実際に開始・終了した検証だけをExecution Logへ通知する。
  onExecutionLog?: (event: VerificationExecutionLogEvent) => void;

}

export interface VerificationExecutionLogEvent {

  timestamp: string;

  check?: VerificationCheckName;

  status: "started" | "completed" | "skipped";

  result?: VerificationCheckResult;

}

function emitVerificationLog(
  callback: RunVerificationOptions["onExecutionLog"],
  event: Omit<VerificationExecutionLogEvent, "timestamp">
): void {

  callback?.({ timestamp: new Date().toISOString(), ...event });

}

interface CheckExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const TSC_TIMEOUT_MS = 5 * 60 * 1000;
const ESLINT_TIMEOUT_MS = 3 * 60 * 1000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;
const BUILD_TIMEOUT_MS = 8 * 60 * 1000;

const OUTPUT_CAPTURE_LIMIT = 3000;

function runCheckCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<CheckExecResult> {

  const startedAt = Date.now();

  return new Promise((resolve) => {

    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, shell: true },
      (error, stdout, stderr) => {

        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;

        // Node.jsのchild_process.execFileは、timeoutで強制終了した場合
        // error.signal === "SIGTERM"を設定する(既存core/codeAgent/
        // claudeCodeAdapter.tsのtimedOut判定と同じ考え方)。
        const timedOut =
          !!error && (error as { signal?: string }).signal === "SIGTERM";

        resolve({
          exitCode,
          stdout: (stdout ?? "").slice(0, OUTPUT_CAPTURE_LIMIT),
          stderr: (stderr ?? "").slice(0, OUTPUT_CAPTURE_LIMIT),
          durationMs: Date.now() - startedAt,
          timedOut,
        });

      }
    );

  });

}

function toCheckResult(result: CheckExecResult): VerificationCheckResult {

  if (result.timedOut) {
    return "failed";
  }

  return result.exitCode === 0 ? "passed" : "failed";

}

export async function runVerification(
  options: RunVerificationOptions
): Promise<VerificationStatus> {

  const checks: Partial<Record<VerificationCheckName, VerificationCheckResult>> = {};
  const detailParts: string[] = [];

  if (options.mode === "none") {

    emitVerificationLog(options.onExecutionLog, { status: "skipped" });

    return {
      checks: {},
      detail: "未実行(mode=none)",
    };

  }

  // tsc: quick/fullどちらでも実行する(型エラーは最も安価かつ重要な
  // チェックであり、既存/execute route.tsのrunTypecheck()と同じ
  // `npx tsc --noEmit -p .`をそのまま踏襲する)。
  emitVerificationLog(options.onExecutionLog, { check: "tsc", status: "started" });

  const tscResult = await runCheckCommand(
    "npx",
    ["tsc", "--noEmit", "-p", "."],
    options.repositoryPath,
    TSC_TIMEOUT_MS
  );

  checks.tsc = toCheckResult(tscResult);
  emitVerificationLog(options.onExecutionLog, {
    check: "tsc",
    status: "completed",
    result: checks.tsc,
  });
  detailParts.push(
    `tsc: ${checks.tsc}(${tscResult.durationMs}ms${tscResult.timedOut ? ", timeout" : ""})`
  );

  if (options.mode === "full") {

    // eslint: 今回変更されたファイル(.ts/.tsx/.js/.jsx、実在するもの)
    // だけに絞る。対象が無ければnot_runとする(架空の"問題なし"を
    // 作らない)。
    const lintableFiles = options.changedFiles.filter(
      (file) =>
        /\.(ts|tsx|js|jsx)$/.test(file) &&
        existsSync(path.join(options.repositoryPath, file))
    );

    if (lintableFiles.length > 0) {

      emitVerificationLog(options.onExecutionLog, { check: "eslint", status: "started" });

      const eslintResult = await runCheckCommand(
        "npx",
        ["eslint", ...lintableFiles],
        options.repositoryPath,
        ESLINT_TIMEOUT_MS
      );

      checks.eslint = toCheckResult(eslintResult);
      emitVerificationLog(options.onExecutionLog, {
        check: "eslint",
        status: "completed",
        result: checks.eslint,
      });
      detailParts.push(
        `eslint(${lintableFiles.length}件): ${checks.eslint}(${eslintResult.durationMs}ms${eslintResult.timedOut ? ", timeout" : ""})`
      );

    } else {

      checks.eslint = "not_run";
      emitVerificationLog(options.onExecutionLog, {
        check: "eslint",
        status: "skipped",
        result: checks.eslint,
      });
      detailParts.push("eslint: not_run(対象ファイルなし)");

    }

    emitVerificationLog(options.onExecutionLog, { check: "test", status: "started" });

    const testResult = await runCheckCommand(
      "npm",
      ["test"],
      options.repositoryPath,
      TEST_TIMEOUT_MS
    );

    checks.test = toCheckResult(testResult);
    emitVerificationLog(options.onExecutionLog, {
      check: "test",
      status: "completed",
      result: checks.test,
    });
    detailParts.push(
      `test: ${checks.test}(${testResult.durationMs}ms${testResult.timedOut ? ", timeout" : ""})`
    );

    emitVerificationLog(options.onExecutionLog, { check: "build", status: "started" });

    const buildResult = await runCheckCommand(
      "npm",
      ["run", "build"],
      options.repositoryPath,
      BUILD_TIMEOUT_MS
    );

    checks.build = toCheckResult(buildResult);
    emitVerificationLog(options.onExecutionLog, {
      check: "build",
      status: "completed",
      result: checks.build,
    });
    detailParts.push(
      `build: ${checks.build}(${buildResult.durationMs}ms${buildResult.timedOut ? ", timeout" : ""})`
    );

  } else {

    checks.eslint = "not_run";
    checks.test = "not_run";
    checks.build = "not_run";
    emitVerificationLog(options.onExecutionLog, {
      check: "eslint",
      status: "skipped",
      result: checks.eslint,
    });
    emitVerificationLog(options.onExecutionLog, {
      check: "test",
      status: "skipped",
      result: checks.test,
    });
    emitVerificationLog(options.onExecutionLog, {
      check: "build",
      status: "skipped",
      result: checks.build,
    });
    detailParts.push("eslint/test/build: not_run(mode=quick)");

  }

  return {
    checks,
    detail: detailParts.join(" / "),
  };

}
