// =========================
// TACT Context Source — Local Workspace Context Resolver (Adapter
// integration, LW-P3)
// =========================
//
// 対象: core/tact-context-source/localWorkspace/browserAdapter.tsの
// resolveWorkspaceContext()(明示的意図判定 + metadata scan +
// content index構築 + 決定論的ranking + bounded read + Evidence変換の
// 統合)。
//
// 環境制約: 実Browser/実File System Access API/DOMは一切使わない
// (jsdom等の追加依存も導入しない)。tests/tact/contextSource/
// fakeFileSystem.tsのin-memory test doubleのみを使う
// (Category B、Mock-based Evaluation)。LLM/Search API呼び出しも0。

import "dotenv/config";
import { createBrowserLocalWorkspaceAdapter } from "../../../core/tact-context-source/localWorkspace/browserAdapter";
import { FakeDirectoryHandle, FakeFileHandle } from "./fakeFileSystem";
import { check, summarize, type CheckResult } from "../lib/check";

function asHandle(handle: FakeDirectoryHandle): FileSystemDirectoryHandle {
  return handle as unknown as FileSystemDirectoryHandle;
}

function buildWorkspace(): FakeDirectoryHandle {

  const memoTxt = new FakeFileHandle({
    name: "memo.txt",
    content: "This project measures SROI for the community program.",
  });
  const researchMd = new FakeFileHandle({
    name: "research.md",
    content: "# Research notes\n\nSROI methodology overview and findings.",
  });
  const readmeMd = new FakeFileHandle({ name: "readme.md", content: "# hello world" });

  const nodeModulesFile = new FakeFileHandle({ name: "pkg.js", content: "sroi in a excluded dir" });
  const nodeModules = new FakeDirectoryHandle("node_modules", [nodeModulesFile]);

  return new FakeDirectoryHandle("workspace-root", [
    memoTxt,
    researchMd,
    readmeMd,
    nodeModules,
  ]);

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // 明示的意図 + SROI query -> 関連fileのみ発見・bounded read
  // ==========================================================

  {
    const root = buildWorkspace();
    const adapter = createBrowserLocalWorkspaceAdapter({
      directoryHandle: asHandle(root),
      workspaceId: "ws-1",
    });

    await adapter.connect();

    const result = await adapter.resolveWorkspaceContext(
      "ローカルのSROI資料を参考に、地域スポーツ活動の社会的価値について調査して"
    );

    const paths = result.evidence.map((item) => item.provenance.relativePath).sort();

    results.push(
      check(
        "[Test1-1] usedはtrue(SROI関連fileが発見・readされた)",
        result.used === true
      )
    );

    results.push(
      check(
        "[Test1-2] memo.txt/research.mdがEvidenceとして返る(readme.md/node_modulesは含まれない)",
        paths.includes("memo.txt") &&
          paths.includes("research.md") &&
          !paths.includes("readme.md") &&
          !paths.some((p) => p.startsWith("node_modules"))
      )
    );

    results.push(
      check(
        "[Test1-3] evidence本文が実際のfile内容を保持する",
        result.evidence.some((item) => item.evidence.evidence.includes("SROI"))
      )
    );

    results.push(
      check(
        "[Test1-4] provenance.workspaceIdがadapter生成時のworkspaceIdと一致する",
        result.evidence.every((item) => item.provenance.workspaceId === "ws-1")
      )
    );

  }

  // ==========================================================
  // 明示的意図なし -> search/read自体が発生しない(0件で安全に継続)
  // ==========================================================

  {
    const root = buildWorkspace();
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(root) });

    await adapter.connect();

    const result = await adapter.resolveWorkspaceContext("トヨタについて調べて");

    results.push(
      check(
        "[Test2-1] 明示的意図が無い通常Researchはused:false・reason:no_intent",
        result.used === false && result.evidence.length === 0 && result.reason === "no_intent"
      )
    );

  }

  // ==========================================================
  // 明示的opt-out -> 参照意図があっても利用しない
  // ==========================================================

  {
    const root = buildWorkspace();
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(root) });

    await adapter.connect();

    const result = await adapter.resolveWorkspaceContext(
      "ローカルは使わずに、SROIについて調べて"
    );

    results.push(
      check(
        "[Test2-2] 明示的opt-out時はused:false・reason:opted_out(参照語があっても利用しない)",
        result.used === false && result.evidence.length === 0 && result.reason === "opted_out"
      )
    );

  }

  // ==========================================================
  // Workspace未接続 -> directoryHandleへアクセスせず安全に0件
  // ==========================================================

  {
    const adapter = createBrowserLocalWorkspaceAdapter();

    const result = await adapter.resolveWorkspaceContext("ローカル資料を参考に調べて");

    results.push(
      check(
        "[Test3-1] 未接続時はused:false・reason:not_connected",
        result.used === false && result.evidence.length === 0 && result.reason === "not_connected"
      )
    );

  }

  // ==========================================================
  // Permission失効 -> requestPermissionを呼ばず安全に0件
  // ==========================================================

  {
    const root = buildWorkspace();
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(root) });

    await adapter.connect();

    root.permissionState = "denied";
    const requestCallsBefore = root.requestPermissionCalls;

    const result = await adapter.resolveWorkspaceContext("ローカルのSROI資料を参考に調べて");

    results.push(
      check(
        "[Test4-1] permission失効時はused:false・reason:permission_revoked",
        result.used === false && result.evidence.length === 0 && result.reason === "permission_revoked"
      )
    );

    results.push(
      check(
        "[Test4-2] permission失効時、requestPermission()を呼ばない(無音でユーザー操作を要求しない)",
        root.requestPermissionCalls === requestCallsBefore
      )
    );

  }

  // ==========================================================
  // 明示的意図はあるが該当fileが1件も無い -> 0件のまま安全に継続
  // ==========================================================

  {
    const emptyRoot = new FakeDirectoryHandle("empty-workspace", [
      new FakeFileHandle({ name: "unrelated.txt", content: "nothing relevant here" }),
    ]);
    const adapter = createBrowserLocalWorkspaceAdapter({ directoryHandle: asHandle(emptyRoot) });

    await adapter.connect();

    const result = await adapter.resolveWorkspaceContext("ローカルのSROI資料を参考に調べて");

    results.push(
      check(
        "[Test5-1] 該当なしの場合、無理にfileを選ばずused:false・0件のまま",
        result.used === false && result.evidence.length === 0 && result.reason === "no_candidates"
      )
    );

  }

  return summarize("contextSource/workspaceResolverAdapter", results);

}
