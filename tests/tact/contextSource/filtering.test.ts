// =========================
// TACT Context Source — Filtering / Permission Regression (LW-P0)
// =========================
//
// 対象: core/tact-context-source/types.ts(ContextSourcePermissions・
// READ_ONLY_PERMISSIONS)・core/tact-context-source/filtering.ts
// (shouldExcludeEntry・shouldTraverseDirectory・validateRelativePath)。
//
// 環境制約: DOM/IndexedDB/File System Access APIは一切使わない。
// LLM/Search API呼び出しも0(pure functionのみのCategory A Test)。

import "dotenv/config";
import {
  READ_ONLY_PERMISSIONS,
} from "../../../core/tact-context-source/types";
import {
  shouldExcludeEntry,
  shouldTraverseDirectory,
  validateRelativePath,
} from "../../../core/tact-context-source/filtering";
import { LOCAL_WORKSPACE_DEFAULT_PERMISSIONS } from "../../../core/tact-context-source/localWorkspace/types";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Permission defaults
  // ==========================================================

  results.push(
    check(
      "[Test1-1] READ_ONLY_PERMISSIONSはread=true・他=falseのdefault",
      READ_ONLY_PERMISSIONS.read === true &&
        READ_ONLY_PERMISSIONS.write === false &&
        READ_ONLY_PERMISSIONS.delete === false &&
        READ_ONLY_PERMISSIONS.git === false &&
        READ_ONLY_PERMISSIONS.terminal === false
    )
  );

  results.push(
    check(
      "[Test1-2] LOCAL_WORKSPACE_DEFAULT_PERMISSIONSも同じread-only default",
      LOCAL_WORKSPACE_DEFAULT_PERMISSIONS.read === true &&
        LOCAL_WORKSPACE_DEFAULT_PERMISSIONS.write === false &&
        LOCAL_WORKSPACE_DEFAULT_PERMISSIONS.delete === false &&
        LOCAL_WORKSPACE_DEFAULT_PERMISSIONS.git === false &&
        LOCAL_WORKSPACE_DEFAULT_PERMISSIONS.terminal === false
    )
  );

  results.push(
    check(
      "[Test1-3] READ_ONLY_PERMISSIONSはfreezeされ、書き換えても値が変わらない(安全なdefault)",
      (() => {
        try {
          // strict modeでは代入がTypeErrorを投げるが、投げない実行系でも
          // 値自体は変わらないことを保証する(どちらでもtestは通す)。
          (READ_ONLY_PERMISSIONS as { write: boolean }).write = true;
        } catch {
          // ignore: freeze由来のTypeErrorは許容される挙動
        }
        return READ_ONLY_PERMISSIONS.write === false;
      })()
    )
  );

  // ==========================================================
  // Default excludes(directory)
  // ==========================================================

  results.push(
    check(
      "[Test2-1] node_modulesディレクトリは除外される(traverse不可)",
      shouldTraverseDirectory("node_modules") === false &&
        shouldExcludeEntry({ name: "node_modules", type: "directory" }) === true
    )
  );

  results.push(
    check(
      "[Test2-2] .gitディレクトリは除外される",
      shouldTraverseDirectory(".git") === false &&
        shouldExcludeEntry({ name: ".git", type: "directory" }) === true
    )
  );

  results.push(
    check(
      "[Test2-3] dist/buildディレクトリは除外される",
      shouldExcludeEntry({ name: "dist", type: "directory" }) === true &&
        shouldExcludeEntry({ name: "build", type: "directory" }) === true
    )
  );

  results.push(
    check(
      "[Test2-4] 通常のdirectory(src)は除外されない",
      shouldExcludeEntry({ name: "src", type: "directory" }) === false &&
        shouldTraverseDirectory("src") === true
    )
  );

  // ==========================================================
  // Default excludes(sensitive files)
  // ==========================================================

  results.push(
    check(
      "[Test3-1] .env / .env.localは除外される",
      shouldExcludeEntry({ name: ".env", type: "file" }) === true &&
        shouldExcludeEntry({ name: ".env.local", type: "file" }) === true
    )
  );

  results.push(
    check(
      "[Test3-2] *.pem / *.keyは除外される",
      shouldExcludeEntry({ name: "server.pem", type: "file" }) === true &&
        shouldExcludeEntry({ name: "id_rsa.key", type: "file" }) === true
    )
  );

  results.push(
    check(
      "[Test3-3] 隠しファイル(.DS_Store等)は安全側defaultで除外される",
      shouldExcludeEntry({ name: ".DS_Store", type: "file" }) === true
    )
  );

  results.push(
    check(
      "[Test3-4] 通常のfile(index.ts)は許可される",
      shouldExcludeEntry({ name: "index.ts", type: "file" }) === false
    )
  );

  // ==========================================================
  // Path traversal validation
  // ==========================================================

  results.push(
    check(
      "[Test4-1] \"../\"を含むrelativePathはreject(Unix形式)",
      validateRelativePath("../secret.txt").ok === false &&
        validateRelativePath("../secret.txt").reason === "path_traversal"
    )
  );

  results.push(
    check(
      "[Test4-2] \"..\\\\\"を含むrelativePathはreject(Windows形式)",
      validateRelativePath("..\\secret.txt").ok === false &&
        validateRelativePath("..\\secret.txt").reason === "path_traversal"
    )
  );

  results.push(
    check(
      "[Test4-3] 途中に\"..\"を含むネストしたpathもreject",
      validateRelativePath("a/../../b").ok === false
    )
  );

  results.push(
    check(
      "[Test4-4] 絶対path(先頭スラッシュ・Windows drive letter)はreject",
      validateRelativePath("/etc/passwd").ok === false &&
        validateRelativePath("C:\\Users\\secret").ok === false
    )
  );

  results.push(
    check(
      "[Test4-5] 正常なrelativePath(src/index.ts)は許可される",
      validateRelativePath("src/index.ts").ok === true
    )
  );

  results.push(
    check(
      "[Test4-6] validateRelativePathは決定論的(同じ入力→同じ結果)",
      JSON.stringify(validateRelativePath("a/b/c.txt")) ===
        JSON.stringify(validateRelativePath("a/b/c.txt")) &&
        validateRelativePath("a/b/c.txt").ok === true
    )
  );

  return summarize("contextSource/filtering", results);

}
