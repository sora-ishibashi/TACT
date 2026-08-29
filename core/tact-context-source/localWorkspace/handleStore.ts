// =========================
// TACT Context Source — Local Workspace Handle Persistence (LW-P1)
// =========================
//
// FileSystemDirectoryHandleをIndexedDBへ保存し、再訪時に復元できる
// ようにする。Supabase/DBへは一切保存しない(LW-P1絶対条件)。
//
// MVPでは同時に1つのLocal Workspaceのみをサポートする
// (Workspace一覧管理はLW-P1のスコープ外)ため、固定keyで1レコードのみ
// 扱う。
//
// 重要: ここで保存したhandleのpermissionは、ブラウザ側の都合で
// いつでも失効しうる。復元後は必ずbrowserAdapter.tsの
// checkStoredPermission()(queryPermissionのみ・無音)で確認してから
// 使う。requestPermission()をここから呼ぶことはしない
// (ユーザー操作なしで権限突破しないため)。
//
// IndexedDB自体が使えない環境(非対応browser、プライベートモード等)
// では、全関数が例外を投げずに安全側(no-op / null)へfallbackする。

const DB_NAME = "tact-local-workspace";
const DB_VERSION = 1;
const STORE_NAME = "connections";
const PRIMARY_KEY = "primary";

export interface StoredLocalWorkspaceRecord {
  workspaceId: string;
  rootLabel: string;
  connectedAt: string;
  directoryHandle: FileSystemDirectoryHandle;
}

export function isIndexedDbSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {

  return new Promise((resolve, reject) => {

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {

      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }

    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open tact-local-workspace IndexedDB"));

  });

}

export async function saveWorkspaceHandle(
  record: StoredLocalWorkspaceRecord
): Promise<void> {

  if (!isIndexedDbSupported()) {
    return;
  }

  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {

    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record, PRIMARY_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("Failed to persist Local Workspace handle"));

  });

  db.close();

}

export async function loadWorkspaceHandle(): Promise<StoredLocalWorkspaceRecord | null> {

  if (!isIndexedDbSupported()) {
    return null;
  }

  const db = await openDatabase();

  const record = await new Promise<StoredLocalWorkspaceRecord | null>((resolve, reject) => {

    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(PRIMARY_KEY);

    request.onsuccess = () =>
      resolve((request.result as StoredLocalWorkspaceRecord | undefined) ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to load Local Workspace handle"));

  });

  db.close();

  return record;

}

export async function clearWorkspaceHandle(): Promise<void> {

  if (!isIndexedDbSupported()) {
    return;
  }

  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {

    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(PRIMARY_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("Failed to clear Local Workspace handle"));

  });

  db.close();

}
