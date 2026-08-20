// =========================
// TACT Code Rollback(STEP143-B: H)
// =========================
//
// 前提: checkpointが存在しない場合はRollbackを実行しない
// (「既存のHuman変更を破壊してはいけない」という制約を優先する。
// 実行前の内容が分からない状態でファイルを書き換えることは、
// Rollbackという名目であっても危険な操作になりうるため)。
//
// ファイルごとのRollback方針:
// 1. checkpoint.targetFileContentsに実行前の内容が保存されている
//    ファイル(=このTaskのtargetFiles) → その内容へ直接書き戻す
//    (最も正確・安全)。
//    - 実行前の内容がnull(=実行前は存在しなかった)場合は、
//      ファイルを削除する。
// 2. targetFilesではない(=Scope Violationで見つかった)ファイルで、
//    checkpoint.gitStatusPorcelain上「実行前は変更されていなかった」
//    もの → `git checkout HEAD -- file` で安全に戻せる
//    (実行前の状態 = 最後のコミットの状態と一致するため)。
// 3. 上記どちらでもない(=targetFilesでもなく、実行前から既に
//    dirtyだった他のファイル) → 実行前の内容を保持していないため、
//    安全にRollbackできない。このファイルには一切手を触れず、
//    "unavailable"として報告するだけにとどめる。

import { execFile } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

import {
  CodeTaskCheckpoint,
  CodeTaskRollbackFileResult,
  CodeTaskRollbackResult,
} from "./types";

function runGit(
  args: string[],
  cwd: string
): Promise<{ exitCode: number | null; stderr: string }> {

  return new Promise((resolve) => {

    execFile(
      "git",
      args,
      { cwd, timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
      (error, _stdout, stderr) => {

        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;

        resolve({ exitCode, stderr: stderr ?? "" });

      }
    );

  });

}

function wasDirtyBeforeExecution(
  file: string,
  checkpoint: CodeTaskCheckpoint
): boolean {

  const normalized = file.replace(/\\/g, "/");

  return checkpoint.gitStatusPorcelain
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\S+\s+/, ""))
    .some((entry) => entry.replace(/\\/g, "/") === normalized);

}

export async function rollbackChanges(
  repositoryPath: string,
  checkpoint: CodeTaskCheckpoint | undefined,
  changedFiles: string[]
): Promise<CodeTaskRollbackResult> {

  if (!checkpoint) {

    return {
      attempted: false,
      success: false,
      files: [],
      detail:
        "checkpoint unavailable. Rollback was not attempted " +
        "(執筆前の状態が分からないため、安全のため何もしていない)。",
    };

  }

  const results: CodeTaskRollbackFileResult[] = [];

  for (const file of changedFiles) {

    const normalized = file.replace(/\\/g, "/");

    const capturedContent =
      Object.prototype.hasOwnProperty.call(
        checkpoint.targetFileContents,
        file
      )
        ? checkpoint.targetFileContents[file]
        : checkpoint.targetFileContents[normalized];

    const wasCapturedAsTargetFile =
      Object.prototype.hasOwnProperty.call(
        checkpoint.targetFileContents,
        file
      ) ||
      Object.prototype.hasOwnProperty.call(
        checkpoint.targetFileContents,
        normalized
      );

    if (wasCapturedAsTargetFile) {

      try {

        const absolutePath = path.join(repositoryPath, file);

        if (capturedContent === null) {

          // 実行前は存在しなかったファイル → 削除する。
          await unlink(absolutePath).catch(() => {
            // 既に存在しない場合は何もしなくてよい。
          });

        } else {

          await writeFile(absolutePath, capturedContent, "utf-8");

        }

        results.push({
          file,
          method: "restored_from_checkpoint",
          success: true,
        });

      } catch (error) {

        results.push({
          file,
          method: "restored_from_checkpoint",
          success: false,
          detail: error instanceof Error ? error.message : String(error),
        });

      }

      continue;

    }

    if (!wasDirtyBeforeExecution(file, checkpoint)) {

      // 実行前はクリーンだった(=最後のcommitと一致していた)ファイル。
      // git checkoutで安全に戻せる。
      const result = await runGit(
        ["checkout", checkpoint.headCommit, "--", file],
        repositoryPath
      );

      results.push({
        file,
        method: "git_checkout_clean",
        success: result.exitCode === 0,
        detail: result.exitCode === 0 ? undefined : result.stderr.trim(),
      });

      continue;

    }

    // targetFilesでもなく、実行前から既にdirtyだった他のファイル。
    // 実行前の内容を保持していないため、安全にRollbackできない。
    results.push({
      file,
      method: "unavailable",
      success: false,
      detail:
        "このファイルは対象ファイルではなく、実行前から既に" +
        "未コミットの変更が存在していたため、実行前の内容を" +
        "保持していない。既存のHuman変更を破壊しないため、" +
        "このファイルには一切手を触れていない。",
    });

  }

  const allSucceeded =
    results.length > 0 && results.every((r) => r.success);

  return {
    attempted: true,
    success: allSucceeded,
    files: results,
    detail: allSucceeded
      ? `${results.length}件のファイルをRollbackした。`
      : "一部またはすべてのファイルをRollbackできなかった。" +
        "filesの各要素を確認してください。",
  };

}
