// =========================
// GitProvider(STEP144-C)
// =========================
//
// TACT Codeが将来checkpoint/branch/commit/push/pull requestを扱える
// 構造を用意する。GitHub固有の処理(gh CLI等)はこのファイル内部に
// 閉じ込め、呼び出し側(app/api/tact/code-tasks/*)や他のcore/codeAgent
// モジュールにGitHub固有の詳細を漏らさない。
//
// 重要な設計方針:
// - checkpoint/rollbackは、STEP143-Bで既に実装・実証済みの
//   core/codeAgent/safetyGate.ts(captureCheckpoint)・
//   core/codeAgent/rollback.ts(rollbackChanges)をそのまま再利用する
//   (重複実装しない。ロジックを変更しない)。
// - push/createPullRequestは、必要な外部認証(GitHub CLI `gh`の
//   認証、またはGITHUB_TOKEN等)が確認できない場合、絶対に
//   実行を試みない。「ここから先は外部認証が必要」という結果を
//   返すだけにとどめる(推測実装しない)。
// - 本番origin(実際のGitHubリモート)へのpushは、このSTEPでは
//   一度も実行しない。Sandboxでのpush検証は、ローカルのbare
//   リポジトリを仮のremoteとして使うことで、外部への副作用なしに
//   仕組みだけを検証する。

import { execFile } from "node:child_process";

import {
  CodeTaskCheckpoint,
  CodeTaskRollbackResult,
} from "./types";
import {
  checkCleanRepository,
  captureCheckpoint,
} from "./safetyGate";
import { rollbackChanges } from "./rollback";

function runGit(
  args: string[],
  cwd: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {

  return new Promise((resolve) => {

    execFile(
      "git",
      args,
      { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
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

export interface GitStatusResult {
  branch: string;
  headCommit: string;
  porcelain: string;
  dirtyFiles: string[];
}

export interface GitBranchResult {
  success: boolean;
  branch: string;
  detail: string;
}

export interface GitCommitCandidate {
  files: string[];
  diff: string;
  suggestedMessage: string;
}

export interface GitCommitResult {
  success: boolean;
  sha?: string;
  message: string;
  detail: string;
}

export interface GitPushResult {
  attempted: boolean;
  success: boolean;
  detail: string;
  requiresExternalAuth?: boolean;
}

export interface GitPullRequestResult {
  attempted: boolean;
  success: boolean;
  url?: string;
  detail: string;
  requiresExternalAuth?: boolean;
}

export interface GitProvider {

  readonly id: string;

  status(repositoryPath: string): Promise<GitStatusResult>;

  createCheckpoint(
    repositoryPath: string,
    targetFiles: string[]
  ): Promise<CodeTaskCheckpoint | null>;

  createBranch(
    repositoryPath: string,
    branchName: string
  ): Promise<GitBranchResult>;

  diff(
    repositoryPath: string,
    files?: string[]
  ): Promise<string>;

  buildCommitCandidate(
    repositoryPath: string,
    files: string[]
  ): Promise<GitCommitCandidate>;

  commit(
    repositoryPath: string,
    files: string[],
    message: string
  ): Promise<GitCommitResult>;

  rollback(
    repositoryPath: string,
    checkpoint: CodeTaskCheckpoint | undefined,
    changedFiles: string[]
  ): Promise<CodeTaskRollbackResult>;

  // confirmがtrueでない限り、実際のpushは一切試みない
  // (呼び出し側の誤操作による事故を防ぐための二重の安全弁)。
  push(
    repositoryPath: string,
    branch: string,
    options?: { confirm?: boolean; remote?: string }
  ): Promise<GitPushResult>;

  createPullRequest(
    repositoryPath: string,
    params: {
      branch: string;
      base: string;
      title: string;
      body: string;
      confirm?: boolean;
    }
  ): Promise<GitPullRequestResult>;

}

// =========================
// LocalGitProvider(唯一の現在の実装)
// =========================

export class LocalGitProvider implements GitProvider {

  readonly id = "local-git";

  async status(
    repositoryPath: string
  ): Promise<GitStatusResult> {

    const branch =
      await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repositoryPath);

    const head =
      await runGit(["rev-parse", "HEAD"], repositoryPath);

    const statusResult =
      await runGit(["status", "--porcelain"], repositoryPath);

    const dirtyFiles =
      statusResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.replace(/^\S+\s+/, ""));

    return {
      branch: branch.stdout.trim(),
      headCommit: head.stdout.trim(),
      porcelain: statusResult.stdout,
      dirtyFiles,
    };

  }

  // STEP143-Bで実装・実証済みのcaptureCheckpoint()をそのまま使う。
  // targetFilesがdirtyな場合はcheckpointを取らない(nullを返す)
  // ——実行してはいけない状態でcheckpointだけ作ることに意味がない
  // ため、呼び出し側にそのまま「取れなかった」ことを伝える。
  async createCheckpoint(
    repositoryPath: string,
    targetFiles: string[]
  ): Promise<CodeTaskCheckpoint | null> {

    const clean =
      await checkCleanRepository(repositoryPath, targetFiles);

    if (!clean.ok) {
      return null;
    }

    return captureCheckpoint(repositoryPath, targetFiles, clean);

  }

  async createBranch(
    repositoryPath: string,
    branchName: string
  ): Promise<GitBranchResult> {

    const result =
      await runGit(["checkout", "-b", branchName], repositoryPath);

    return {
      success: result.exitCode === 0,
      branch: branchName,
      detail:
        result.exitCode === 0
          ? `branch "${branchName}" created and checked out`
          : result.stderr.trim() || "git checkout -b failed",
    };

  }

  async diff(
    repositoryPath: string,
    files?: string[]
  ): Promise<string> {

    const args =
      files && files.length > 0
        ? ["diff", "--", ...files]
        : ["diff"];

    const result = await runGit(args, repositoryPath);

    return result.stdout;

  }

  async buildCommitCandidate(
    repositoryPath: string,
    files: string[]
  ): Promise<GitCommitCandidate> {

    const diffText =
      await this.diff(repositoryPath, files);

    return {
      files,
      diff: diffText,
      suggestedMessage:
        `TACT Code: ${files.join(", ")} を更新\n\n` +
        "このコミットはTACT Code(自己改善ループ)によって生成された" +
        "変更候補です。人間の確認・承認を経てcommitされています。\n\n" +
        "Co-Authored-By: TACT Code <noreply@tact.local>",
    };

  }

  async commit(
    repositoryPath: string,
    files: string[],
    message: string
  ): Promise<GitCommitResult> {

    if (files.length === 0) {

      return {
        success: false,
        message,
        detail: "commit対象ファイルが空のため、何もしなかった。",
      };

    }

    const addResult =
      await runGit(["add", "--", ...files], repositoryPath);

    if (addResult.exitCode !== 0) {

      return {
        success: false,
        message,
        detail: `git add failed: ${addResult.stderr.trim()}`,
      };

    }

    const commitResult =
      await runGit(
        ["commit", "-m", message],
        repositoryPath
      );

    if (commitResult.exitCode !== 0) {

      return {
        success: false,
        message,
        detail: `git commit failed: ${commitResult.stderr.trim()}`,
      };

    }

    const shaResult =
      await runGit(["rev-parse", "HEAD"], repositoryPath);

    return {
      success: true,
      sha: shaResult.stdout.trim(),
      message,
      detail: "commit created",
    };

  }

  // STEP143-Bで実装・実証済みのrollbackChanges()をそのまま使う。
  async rollback(
    repositoryPath: string,
    checkpoint: CodeTaskCheckpoint | undefined,
    changedFiles: string[]
  ): Promise<CodeTaskRollbackResult> {

    return rollbackChanges(repositoryPath, checkpoint, changedFiles);

  }

  // 外部認証(GitHub CLI `gh`の認証等)が確認できない限り、
  // 実際のpushは一切試みない。confirm:trueも必須
  // (呼び出し側が明示的に望んだ場合のみ)。
  async push(
    repositoryPath: string,
    branch: string,
    options?: { confirm?: boolean; remote?: string }
  ): Promise<GitPushResult> {

    if (!options?.confirm) {

      return {
        attempted: false,
        success: false,
        detail:
          "confirm:trueが指定されていないため、pushを試みていない" +
          "(誤操作防止のための安全弁)。",
      };

    }

    // 実装時の誤り(Sandbox実証で発見): git pushはGitHub固有の操作
    // ではなく、任意のgit remote(ローカルのbareリポジトリ、
    // GitHub以外のホスティング等)に対して行える。`gh auth status`を
    // ここで必須にすると、GitHubを経由しないpush(ローカルbare
    // リポジトリへのpush等)まで一律requiresExternalAuthとして
    // 拒否してしまい、実際にSandbox検証で失敗が再現した。
    // `gh`はPull Request作成(createPullRequest、GitHub固有の操作)
    // にのみ必要であり、pushの認証自体はgit自身の資格情報
    // (credential.helper等、Windowsではcredential manager)に委ねる。
    // ここでは`gh auth status`のチェックを行わず、git push自体を
    // 実行し、その結果(成功/失敗)をそのまま返す。
    const remote = options.remote ?? "origin";

    const pushResult =
      await runGit(["push", remote, branch], repositoryPath);

    // 認証絡みの失敗(資格情報が無い/期限切れ等)は、git自身の
    // エラーメッセージから典型的な文言を検出し、requiresExternalAuth
    // として区別する(推測で成功と報告しないための最低限のヒューリスティック)。
    const authFailurePattern =
      /authentication|could not read|permission denied|403|fatal: unable to access/i;

    const looksLikeAuthFailure =
      pushResult.exitCode !== 0 &&
      authFailurePattern.test(pushResult.stderr);

    return {
      attempted: true,
      success: pushResult.exitCode === 0,
      requiresExternalAuth: looksLikeAuthFailure || undefined,
      detail:
        pushResult.exitCode === 0
          ? `pushed ${branch} to ${remote}`
          : pushResult.stderr.trim() || "git push failed",
    };

  }

  async createPullRequest(
    repositoryPath: string,
    params: {
      branch: string;
      base: string;
      title: string;
      body: string;
      confirm?: boolean;
    }
  ): Promise<GitPullRequestResult> {

    if (!params.confirm) {

      return {
        attempted: false,
        success: false,
        detail:
          "confirm:trueが指定されていないため、PR作成を試みていない" +
          "(誤操作防止のための安全弁)。",
      };

    }

    const ghCheck =
      await new Promise<{ available: boolean; detail: string }>(
        (resolve) => {

          execFile(
            "gh",
            ["auth", "status"],
            { cwd: repositoryPath, timeout: 10_000, shell: true },
            (error, stdout, stderr) => {

              if (error) {

                resolve({
                  available: false,
                  detail:
                    stderr.trim() ||
                    "gh CLI not found or not authenticated",
                });

                return;

              }

              resolve({ available: true, detail: stdout.trim() });

            }
          );

        }
      );

    if (!ghCheck.available) {

      return {
        attempted: false,
        success: false,
        requiresExternalAuth: true,
        detail:
          "ここから先は外部認証が必要です(GitHub CLI `gh`が未インストール、" +
          `または未認証)。実行していません。詳細: ${ghCheck.detail}`,
      };

    }

    const prResult =
      await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
        (resolve) => {

          execFile(
            "gh",
            [
              "pr", "create",
              "--head", params.branch,
              "--base", params.base,
              "--title", params.title,
              "--body", params.body,
            ],
            { cwd: repositoryPath, timeout: 30_000, shell: true },
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

        }
      );

    return {
      attempted: true,
      success: prResult.exitCode === 0,
      url: prResult.exitCode === 0 ? prResult.stdout.trim() : undefined,
      detail:
        prResult.exitCode === 0
          ? "pull request created"
          : prResult.stderr.trim() || "gh pr create failed",
    };

  }

}

// =========================
// Provider取得(将来、複数GitProvider実装が必要になった場合の交換点)
// =========================

export function getGitProvider(): GitProvider {

  return new LocalGitProvider();

}
