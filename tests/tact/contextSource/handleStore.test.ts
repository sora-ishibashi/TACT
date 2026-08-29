// =========================
// TACT Context Source — Local Workspace Handle Store Regression (LW-P1)
// =========================
//
// 対象: core/tact-context-source/localWorkspace/handleStore.ts。
// Node実行環境(indexedDBが存在しない)でも例外を投げず安全側
// (no-op / null)へfallbackすることを確認する。実IndexedDB/実DOMは
// 使わない。Supabase/DBへは一切書き込まない(このモジュール自体が
// IndexedDBしか扱わない)。

import "dotenv/config";
import {
  clearWorkspaceHandle,
  isIndexedDbSupported,
  loadWorkspaceHandle,
  saveWorkspaceHandle,
} from "../../../core/tact-context-source/localWorkspace/handleStore";
import { FakeDirectoryHandle } from "./fakeFileSystem";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Test1-1] Node環境(indexedDBなし)ではisIndexedDbSupported()=false",
      isIndexedDbSupported() === false
    )
  );

  const record = {
    workspaceId: "ws-1",
    rootLabel: "workspace-root",
    connectedAt: new Date().toISOString(),
    directoryHandle: new FakeDirectoryHandle("workspace-root") as unknown as FileSystemDirectoryHandle,
  };

  let saveThrew = false;

  try {
    await saveWorkspaceHandle(record);
  } catch {
    saveThrew = true;
  }

  results.push(
    check(
      "[Test2-1] IndexedDB非対応環境でもsaveWorkspaceHandle()は例外を投げない(no-op)",
      saveThrew === false
    )
  );

  const loaded = await loadWorkspaceHandle();

  results.push(
    check(
      "[Test2-2] IndexedDB非対応環境ではloadWorkspaceHandle()はnullを返す",
      loaded === null
    )
  );

  let clearThrew = false;

  try {
    await clearWorkspaceHandle();
  } catch {
    clearThrew = true;
  }

  results.push(
    check(
      "[Test2-3] IndexedDB非対応環境でもclearWorkspaceHandle()は例外を投げない(no-op)",
      clearThrew === false
    )
  );

  return summarize("contextSource/handleStore", results);

}
