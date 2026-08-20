// =========================
// TACT Code Safety Gate(STEP143-B)
// =========================
//
// STEP143-Aで発見された問題(対象ファイルが既にdirtyな状態で
// Coding Agentを実行すると、人間の既存変更とTACT Codeの新規変更の
// 境界が曖昧になり、Task単位で安全にRollbackできない)に対応する。
//
// 責務:
// - A. Git Checkpoint機構: 実行直前の状態を「読み取るだけ」で記録する
//   (既存の未コミット変更を勝手にcommitしない)。
// - B. Clean Repository Gate: 対象ファイルにdirtyな変更が既に
//   存在する場合、Claude Codeを起動せずblockedとする。
// - D. Change Scope Gate: 実行後、targetFiles以外が変更されて
//   いないかを確認する。
// - E. Dangerous Change Detection: Migration・Auth・Secret・
//   Brain/Optimizer/CodeAgent自身等、危険な領域が変更されていないかを
//   確認する。

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { CodeTaskCheckpoint, CodeTaskDangerousChangeCheck, CodeTaskScopeCheck } from "./types";

function runGit(
  args: string[],
  cwd: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {

  return new Promise((resolve) => {

    execFile(
      "git",
      args,
      { cwd, timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
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

// `git status --porcelain`の1行から、変更されたファイルパスだけを取り出す。
// core/codeAgent/claudeCodeAdapter.tsのsnapshotChangedFiles()と同じ
// パース方式(重複実装を避けるため、将来的に共通化する余地はあるが、
// 今回はモジュール境界を跨いだ依存を増やさないため、それぞれで
// 小さく持つ)。
function parsePorcelainFiles(porcelain: string): string[] {

  return porcelain
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\S+\s+/, ""))
    // porcelainのrename表記("old -> new")はnew側だけを使う。
    .map((entry) => {
      const arrowIndex = entry.indexOf(" -> ");
      return arrowIndex === -1 ? entry : entry.slice(arrowIndex + 4);
    });

}

// =========================
// B. Clean Repository Gate
// =========================

export interface CleanRepositoryCheckResult {
  ok: boolean;
  reason?: string;
  branch: string;
  headCommit: string;
  statusPorcelain: string;
  dirtyFilesOverall: string[];
  dirtyTargetFiles: string[];
}

export async function checkCleanRepository(
  repositoryPath: string,
  targetFiles: string[]
): Promise<CleanRepositoryCheckResult> {

  const branchResult =
    await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repositoryPath);

  if (branchResult.exitCode !== 0) {

    return {
      ok: false,
      reason:
        "not_a_git_repository_or_no_head: " +
        (branchResult.stderr.trim() || "git rev-parse failed"),
      branch: "",
      headCommit: "",
      statusPorcelain: "",
      dirtyFilesOverall: [],
      dirtyTargetFiles: [],
    };

  }

  const headResult =
    await runGit(["rev-parse", "HEAD"], repositoryPath);

  if (headResult.exitCode !== 0) {

    return {
      ok: false,
      reason:
        "no_head_commit: " +
        (headResult.stderr.trim() || "git rev-parse HEAD failed"),
      branch: branchResult.stdout.trim(),
      headCommit: "",
      statusPorcelain: "",
      dirtyFilesOverall: [],
      dirtyTargetFiles: [],
    };

  }

  const statusResult =
    await runGit(["status", "--porcelain"], repositoryPath);

  if (statusResult.exitCode !== 0) {

    return {
      ok: false,
      reason:
        "cannot_read_working_tree_status: " +
        (statusResult.stderr.trim() || "git status failed"),
      branch: branchResult.stdout.trim(),
      headCommit: headResult.stdout.trim(),
      statusPorcelain: "",
      dirtyFilesOverall: [],
      dirtyTargetFiles: [],
    };

  }

  const dirtyFilesOverall =
    parsePorcelainFiles(statusResult.stdout);

  const normalizedTargets =
    targetFiles.map((f) => f.replace(/\\/g, "/"));

  const dirtyTargetFiles =
    dirtyFilesOverall.filter((f) =>
      normalizedTargets.includes(f.replace(/\\/g, "/"))
    );

  if (dirtyTargetFiles.length > 0) {

    return {
      ok: false,
      reason: "dirty_repository",
      branch: branchResult.stdout.trim(),
      headCommit: headResult.stdout.trim(),
      statusPorcelain: statusResult.stdout,
      dirtyFilesOverall,
      dirtyTargetFiles,
    };

  }

  return {
    ok: true,
    branch: branchResult.stdout.trim(),
    headCommit: headResult.stdout.trim(),
    statusPorcelain: statusResult.stdout,
    dirtyFilesOverall,
    dirtyTargetFiles: [],
  };

}

// =========================
// A. Git Checkpoint機構
// =========================
//
// checkCleanRepository()がok:trueを返した(=targetFilesはdirtyでない)
// 後にのみ呼ぶ想定。targetFilesの実行直前の内容を読み取るだけで、
// commitは一切行わない。

export async function captureCheckpoint(
  repositoryPath: string,
  targetFiles: string[],
  clean: CleanRepositoryCheckResult
): Promise<CodeTaskCheckpoint> {

  const targetFileContents: Record<string, string | null> = {};

  for (const file of targetFiles) {

    try {

      const content =
        await readFile(
          path.join(repositoryPath, file),
          "utf-8"
        );

      targetFileContents[file] = content;

    } catch {

      // ファイルが存在しない(=このTaskで新規作成される予定)場合はnull。
      targetFileContents[file] = null;

    }

  }

  return {
    branch: clean.branch,
    headCommit: clean.headCommit,
    gitStatusPorcelain: clean.statusPorcelain,
    targetFileContents,
    capturedAt: new Date().toISOString(),
  };

}

// =========================
// D. Change Scope Gate
// =========================

export function checkScope(
  targetFiles: string[],
  changedFiles: string[]
): CodeTaskScopeCheck {

  const normalizedTargets =
    new Set(targetFiles.map((f) => f.replace(/\\/g, "/")));

  const violationFiles =
    changedFiles.filter(
      (f) => !normalizedTargets.has(f.replace(/\\/g, "/"))
    );

  return {
    targetFiles,
    changedFiles,
    violationFiles,
  };

}

// =========================
// E. Dangerous Change Detection
// =========================
//
// 「対象ファイルとして正しく指定されていたとしても、そもそも
// 危険な領域である」場合も検出できるよう、targetFiles/scope
// violationの区別なく、変更された全ファイルに対して判定する。

const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [

  {
    pattern: /^supabase\/migrations\//,
    reason: "Supabase migration",
  },

  {
    pattern: /schema\.sql$/i,
    reason: "DB schema",
  },

  {
    pattern: /^core\/auth\//,
    reason: "Auth",
  },

  {
    pattern: /\.env(\.|$)/,
    reason: "環境変数/Secret",
  },

  {
    pattern: /^package\.json$/,
    reason: "package.json",
  },

  {
    pattern: /^package-lock\.json$/,
    reason: "package-lock.json",
  },

  {
    pattern: /^core\/codeAgent\//,
    reason: "CodeAgent自身(TACT Code)",
  },

  {
    pattern: /^core\/brain\//,
    reason: "Brain自身",
  },

  {
    pattern: /^core\/optimizer\//,
    reason: "Optimizer自身",
  },

  {
    pattern: /^app\/api\/tact\/code-tasks\//,
    reason: "Approval Gate / Execution Policy(TACT Code API自身)",
  },

  {
    pattern: /^\.git\//,
    reason: "Git設定",
  },

];

export function checkDangerousChanges(
  changedFiles: string[]
): CodeTaskDangerousChangeCheck {

  const flaggedFiles: string[] = [];
  const reasons: string[] = [];

  for (const file of changedFiles) {

    const normalized = file.replace(/\\/g, "/");

    for (const { pattern, reason } of DANGEROUS_PATTERNS) {

      if (pattern.test(normalized)) {

        flaggedFiles.push(file);
        reasons.push(`${file}: ${reason}`);
        break;

      }

    }

  }

  return { flaggedFiles, reasons };

}
