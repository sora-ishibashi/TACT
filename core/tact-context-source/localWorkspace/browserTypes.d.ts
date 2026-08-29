// =========================
// File System Access API — Ambient Type Augmentation (LW-P1)
// =========================
//
// TypeScript 5.9のlib.dom.d.tsには、File System Access APIのうち
// FileSystemHandle/FileSystemDirectoryHandle/FileSystemFileHandleの
// 基本形は含まれているが、以下は含まれていない(2026-08時点):
//   - FileSystemHandle.queryPermission()/requestPermission()
//   - FileSystemDirectoryHandle.entries()/keys()/values()(非同期反復)
//   - window.showDirectoryPicker()
//
// ここではこれらだけを既存interfaceへの宣言マージで追加する
// (新しい型を作るのではなく、標準APIの型定義を補完するだけ)。
// 実装(実際にこれらのAPIを呼ぶ部分)はbrowserAdapter.tsに置き、
// このファイルは型のみを持つ。

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor
  ): Promise<PermissionState>;

  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor
  ): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemHandle>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?:
    | FileSystemHandle
    | "desktop"
    | "documents"
    | "downloads"
    | "music"
    | "pictures"
    | "videos";
}

interface Window {
  showDirectoryPicker?(
    options?: DirectoryPickerOptions
  ): Promise<FileSystemDirectoryHandle>;
}
