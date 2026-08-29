// =========================
// TACT Context Source — Fake File System Access API (test double, LW-P1)
// =========================
//
// browserAdapter.tsを、実Browser/実File System Access APIに一切依存
// せずテストするための最小のin-memory test double。
// FileSystemHandle/FileSystemDirectoryHandle/FileSystemFileHandle
// (browserTypes.d.tsで拡張された形)を構造的に満たすだけで、実際の
// ファイルシステムやDOMには触れない。

export type FakeEntry = FakeFileHandle | FakeDirectoryHandle;

export class FakeFileHandle implements FileSystemFileHandle {

  readonly kind = "file" as const;
  readonly name: string;

  queryPermissionCalls = 0;
  requestPermissionCalls = 0;

  private readonly content: string;
  private readonly mimeType: string;
  private readonly lastModifiedMs: number;
  private permissionState: PermissionState;

  constructor(params: {
    name: string;
    content?: string;
    mimeType?: string;
    lastModifiedMs?: number;
    permissionState?: PermissionState;
  }) {

    this.name = params.name;
    this.content = params.content ?? "";
    this.mimeType = params.mimeType ?? "text/plain";
    this.lastModifiedMs = params.lastModifiedMs ?? Date.parse("2026-08-29T00:00:00.000Z");
    this.permissionState = params.permissionState ?? "granted";

  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === (this as unknown as FileSystemHandle);
  }

  async queryPermission(): Promise<PermissionState> {
    this.queryPermissionCalls += 1;
    return this.permissionState;
  }

  async requestPermission(): Promise<PermissionState> {
    this.requestPermissionCalls += 1;
    return this.permissionState;
  }

  async getFile(): Promise<File> {
    return new File([this.content], this.name, {
      type: this.mimeType,
      lastModified: this.lastModifiedMs,
    });
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    throw new Error("FakeFileHandle is read-only: createWritable() is not implemented");
  }

}

export class FakeDirectoryHandle implements FileSystemDirectoryHandle {

  readonly kind = "directory" as const;
  readonly name: string;

  queryPermissionCalls = 0;
  requestPermissionCalls = 0;
  permissionState: PermissionState;
  // requestPermission()がqueryPermission()と異なる結果を返すケース
  // (例: prompt→request後にgranted)をテストするための、任意の上書き値。
  // 省略時はpermissionStateと同じ値を返す。
  requestPermissionResult?: PermissionState;

  private readonly children: Map<string, FakeEntry>;

  constructor(
    name: string,
    children: FakeEntry[] = [],
    permissionState: PermissionState = "granted",
    requestPermissionResult?: PermissionState
  ) {

    this.name = name;
    this.children = new Map(children.map((child) => [child.name, child]));
    this.permissionState = permissionState;
    this.requestPermissionResult = requestPermissionResult;

  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === (this as unknown as FileSystemHandle);
  }

  async queryPermission(): Promise<PermissionState> {
    this.queryPermissionCalls += 1;
    return this.permissionState;
  }

  async requestPermission(): Promise<PermissionState> {
    this.requestPermissionCalls += 1;
    return this.requestPermissionResult ?? this.permissionState;
  }

  async getDirectoryHandle(name: string): Promise<FileSystemDirectoryHandle> {

    const child = this.children.get(name);

    if (!child || child.kind !== "directory") {
      throw new Error(`FakeDirectoryHandle: no such directory "${name}"`);
    }

    return child;

  }

  async getFileHandle(name: string): Promise<FileSystemFileHandle> {

    const child = this.children.get(name);

    if (!child || child.kind !== "file") {
      throw new Error(`FakeDirectoryHandle: no such file "${name}"`);
    }

    return child;

  }

  async removeEntry(): Promise<void> {
    throw new Error("FakeDirectoryHandle is read-only: removeEntry() is not implemented");
  }

  async resolve(): Promise<string[] | null> {
    return null;
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    for (const [name, handle] of this.children) {
      yield [name, handle as unknown as FileSystemHandle];
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const name of this.children.keys()) {
      yield name;
    }
  }

  async *values(): AsyncIterableIterator<FileSystemHandle> {
    for (const handle of this.children.values()) {
      yield handle as unknown as FileSystemHandle;
    }
  }

}
