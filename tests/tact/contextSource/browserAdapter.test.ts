// =========================
// TACT Context Source — Local Workspace Browser Adapter Regression (LW-P1)
// =========================
//
// 対象: core/tact-context-source/localWorkspace/browserAdapter.ts
// (isFileSystemAccessSupported・checkStoredPermission・
// createBrowserLocalWorkspaceAdapter)。
//
// 環境制約: 実Browser/実File System Access API/DOMは一切使わない
// (jsdom等の追加依存も導入しない)。tests/tact/contextSource/
// fakeFileSystem.tsのin-memory test doubleのみを使う
// (Category B、Mock-based Evaluation)。LLM/Search API呼び出しも0。

import "dotenv/config";
import {
  checkStoredPermission,
  createBrowserLocalWorkspaceAdapter,
  isFileSystemAccessSupported,
} from "../../../core/tact-context-source/localWorkspace/browserAdapter";
import {
  LocalWorkspaceCancelledError,
  LocalWorkspaceNotConnectedError,
  LocalWorkspacePermissionDeniedError,
  LocalWorkspaceUnsupportedError,
} from "../../../core/tact-context-source/localWorkspace/errors";
import { LOCAL_WORKSPACE_DEFAULT_PERMISSIONS } from "../../../core/tact-context-source/localWorkspace/types";
import { FakeDirectoryHandle, FakeFileHandle } from "./fakeFileSystem";
import { check, summarize, type CheckResult } from "../lib/check";

function asHandle(handle: FakeDirectoryHandle): FileSystemDirectoryHandle {
  return handle as unknown as FileSystemDirectoryHandle;
}

function buildWorkspace(): FakeDirectoryHandle {

  const pkgFile = new FakeFileHandle({ name: "file.js", content: "module.exports = {}" });
  const pkgDir = new FakeDirectoryHandle("pkg", [pkgFile]);
  const nodeModules = new FakeDirectoryHandle("node_modules", [pkgDir]);
  const gitDir = new FakeDirectoryHandle(".git", [
    new FakeFileHandle({ name: "HEAD", content: "ref: refs/heads/main" }),
  ]);
  const envFile = new FakeFileHandle({ name: ".env", content: "SECRET=1" });
  const hiddenFile = new FakeFileHandle({ name: ".DS_Store", content: "" });
  const readme = new FakeFileHandle({
    name: "readme.md",
    content: "# hello",
    mimeType: "text/markdown",
    lastModifiedMs: Date.parse("2026-08-20T00:00:00.000Z"),
  });
  const indexTs = new FakeFileHandle({ name: "index.ts", content: "export {}" });
  const srcDir = new FakeDirectoryHandle("src", [indexTs]);

  return new FakeDirectoryHandle("workspace-root", [
    readme,
    envFile,
    hiddenFile,
    nodeModules,
    gitDir,
    srcDir,
  ]);

}

async function expectRejects(
  fn: () => Promise<unknown>
): Promise<unknown> {

  try {
    await fn();
  } catch (error) {
    return error;
  }

  return undefined;

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // Unsupported browser
  // ==========================================================

  results.push(
    check(
      "[Test1-1] Node環境(windowなし)ではisFileSystemAccessSupported()=false",
      isFileSystemAccessSupported() === false
    )
  );

  (globalThis as unknown as { window?: unknown }).window = {};

  results.push(
    check(
      "[Test1-2] windowはあるがshowDirectoryPickerが無い場合もfalse(旧Browser相当)",
      isFileSystemAccessSupported() === false
    )
  );

  delete (globalThis as unknown as { window?: unknown }).window;

  {
    const adapter = createBrowserLocalWorkspaceAdapter();
    const error = await expectRejects(() => adapter.connect());

    results.push(
      check(
        "[Test1-3] 非対応環境でconnect()はLocalWorkspaceUnsupportedErrorをthrowする",
        error instanceof LocalWorkspaceUnsupportedError
      )
    );
  }

  // ==========================================================
  // Permission: connect / persisted handle
  // ==========================================================

  {
    const root = buildWorkspace();
    const adapter = createBrowserLocalWorkspaceAdapter({
      directoryHandle: asHandle(root),
      workspaceId: "ws-granted",
    });

    const connection = await adapter.connect();

    results.push(
      check(
        "[Test2-1] 既にgrantedなhandleではrequestPermission()を呼ばない(queryPermissionのみ)",
        root.queryPermissionCalls === 1 && root.requestPermissionCalls === 0
      )
    );

    results.push(
      check(
        "[Test2-2] connect()成功後のpermissionsはread-only default",
        JSON.stringify(connection.permissions) === JSON.stringify(LOCAL_WORKSPACE_DEFAULT_PERMISSIONS)
      )
    );
  }

  {
    const root = new FakeDirectoryHandle("prompt-then-grant", [], "prompt", "granted");
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(root) });

    await adapter.connect();

    results.push(
      check(
        "[Test2-3] permission=promptの場合はrequestPermission()を1回呼び、grantedなら接続成功する",
        root.requestPermissionCalls === 1
      )
    );
  }

  {
    const root = new FakeDirectoryHandle("prompt-then-deny", [], "prompt", "denied");
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(root) });
    const error = await expectRejects(() => adapter.connect());

    results.push(
      check(
        "[Test2-4] permission拒否(denied)時はLocalWorkspacePermissionDeniedErrorをthrowする",
        error instanceof LocalWorkspacePermissionDeniedError
      )
    );
  }

  {
    const root = new FakeDirectoryHandle("expired", [], "prompt");

    const state = await checkStoredPermission(asHandle(root));

    results.push(
      check(
        "[Test2-5] checkStoredPermission()はqueryPermissionのみ呼び、requestPermissionは呼ばない(無音確認・権限失効時も安全)",
        state === "prompt" && root.queryPermissionCalls === 1 && root.requestPermissionCalls === 0
      )
    );
  }

  {
    (globalThis as unknown as { window?: unknown }).window = {
      showDirectoryPicker: async () => {
        const abortError = new DOMException("The user aborted a request.", "AbortError");
        throw abortError;
      },
    };

    const adapter = createBrowserLocalWorkspaceAdapter();
    const error = await expectRejects(() => adapter.connect());

    delete (globalThis as unknown as { window?: unknown }).window;

    results.push(
      check(
        "[Test2-6] ユーザーがフォルダ選択ダイアログをキャンセルした場合はLocalWorkspaceCancelledErrorをthrowする",
        error instanceof LocalWorkspaceCancelledError
      )
    );
  }

  // ==========================================================
  // Disconnect
  // ==========================================================

  {
    const root = buildWorkspace();
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(root) });

    await adapter.connect();
    await adapter.disconnect();

    const error = await expectRejects(() => adapter.list());

    results.push(
      check(
        "[Test3-1] disconnect()後はlist()がLocalWorkspaceNotConnectedErrorをthrowする(状態が実際に変わる)",
        error instanceof LocalWorkspaceNotConnectedError
      )
    );
  }

  // ==========================================================
  // Metadata scan (list)
  // ==========================================================

  {
    const root = buildWorkspace();
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(root) });

    await adapter.connect();

    const rootEntries = await adapter.list();
    const names = rootEntries.map((entry) => entry.name).sort();

    results.push(
      check(
        "[Test4-1] node_modules/.git/.env/隠しファイルはlist()結果に含まれない",
        !names.includes("node_modules") &&
          !names.includes(".git") &&
          !names.includes(".env") &&
          !names.includes(".DS_Store")
      )
    );

    results.push(
      check(
        "[Test4-2] 通常のfile/directory(readme.md・src)はlist()結果に含まれる",
        names.includes("readme.md") && names.includes("src")
      )
    );

    const readmeEntry = rootEntries.find((entry) => entry.name === "readme.md");

    results.push(
      check(
        "[Test4-3] fileのmetadata(relativePath/type/size/modifiedAt/extension/mimeType)が取得される",
        readmeEntry?.relativePath === "readme.md" &&
          readmeEntry?.type === "file" &&
          typeof readmeEntry?.size === "number" &&
          readmeEntry?.modifiedAt === "2026-08-20T00:00:00.000Z" &&
          readmeEntry?.extension === "md" &&
          readmeEntry?.mimeType === "text/markdown"
      )
    );

    const srcEntries = await adapter.list("src");

    results.push(
      check(
        "[Test4-4] list(relativePath)は指定directory配下を返し、relativePathがnested形式になる",
        srcEntries.length === 1 &&
          srcEntries[0].name === "index.ts" &&
          srcEntries[0].relativePath === "src/index.ts"
      )
    );
  }

  // ==========================================================
  // Recursive scan: excluded directoryへ降りない
  // ==========================================================

  {
    const root = buildWorkspace();
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(root) });

    await adapter.connect();

    const result = await adapter.scan();
    const relativePaths = result.entries.map((entry) => entry.relativePath);

    results.push(
      check(
        "[Test5-1] scan()はnode_modules配下(node_modules/pkg/file.js)へ降りない",
        !relativePaths.some((path) => path.startsWith("node_modules"))
      )
    );

    results.push(
      check(
        "[Test5-2] scan()は除外対象外のnested file(src/index.ts)は収集する",
        relativePaths.includes("src/index.ts")
      )
    );

    results.push(
      check(
        "[Test5-3] scan()のfileCountはfile種別のみをカウントする",
        result.fileCount === result.entries.filter((entry) => entry.type === "file").length &&
          result.fileCount > 0
      )
    );
  }

  // ==========================================================
  // Search
  // ==========================================================

  {
    const root = buildWorkspace();
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(root) });

    await adapter.connect();

    const matches = await adapter.search({ query: "index" });

    results.push(
      check(
        "[Test6-1] search()はnameに一致するnested fileを返す",
        matches.some((entry) => entry.relativePath === "src/index.ts")
      )
    );

    const excludedMatches = await adapter.search({ query: "file.js" });

    results.push(
      check(
        "[Test6-2] search()も除外directory配下(node_modules)は対象にしない",
        excludedMatches.length === 0
      )
    );
  }

  // ==========================================================
  // Permission invariant(write/delete/git/terminal=0はLW-P2でも変わらない)
  // ==========================================================
  //
  // read()の詳細な挙動(対応拡張子・size上限・traversal reject等)は
  // LW-P2でread.test.tsへ分離した(このfileはconnect/list/scan/searchの
  // metadata経路のみを対象とする)。

  {
    const root = buildWorkspace();
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(root) });

    await adapter.connect();

    results.push(
      check(
        "[Test7-1] adapter.permissionsは常にread-only(write/delete/git/terminal=false)",
        adapter.permissions.read === true &&
          adapter.permissions.write === false &&
          adapter.permissions.delete === false &&
          adapter.permissions.git === false &&
          adapter.permissions.terminal === false
      )
    );

    const result = await adapter.read("readme.md");

    results.push(
      check(
        "[Test7-2] LW-P2: 対応拡張子(md)・許可済みWorkspace内のread()は本文を返す(詳細はcontextSource/read.test.ts)",
        result.content === "# hello" && result.entry.relativePath === "readme.md"
      )
    );
  }

  return summarize("contextSource/browserAdapter", results);

}
