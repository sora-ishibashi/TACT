// =========================
// TACT Context Source — Local Workspace Browser Adapter Errors (LW-P1)
// =========================
//
// 呼び出し元(useLocalWorkspace.ts)が「なぜ接続できなかったか」を
// 分岐できるよう、型付きのErrorを用意する。文字列比較ではなく
// instanceof判定で分岐できるようにする。

export class LocalWorkspaceUnsupportedError extends Error {
  constructor() {
    super("File System Access API is not supported in this browser.");
    this.name = "LocalWorkspaceUnsupportedError";
  }
}

export class LocalWorkspaceCancelledError extends Error {
  constructor() {
    super("The user cancelled the folder picker.");
    this.name = "LocalWorkspaceCancelledError";
  }
}

export class LocalWorkspacePermissionDeniedError extends Error {
  constructor() {
    super("Read permission for the selected folder was not granted.");
    this.name = "LocalWorkspacePermissionDeniedError";
  }
}

export class LocalWorkspaceNotConnectedError extends Error {
  constructor() {
    super("The Local Workspace adapter is not connected yet.");
    this.name = "LocalWorkspaceNotConnectedError";
  }
}

// LW-P1では、ファイル本文read(content)を一切実行しない
// (「ファイル内容はまだ読まない/LLM=0/Search=0」という今回の安全条件を、
// UI側の実装漏れに依存せずコードレベルで保証するため)。ContextSource
// contract(read()必須)自体は満たしつつ、実際に呼ばれた場合は必ず
// このErrorを投げる。LW-P2でread()を有効化したため、このErrorは
// 現在どこからも投げられないが、過去のPhaseとの互換性のためClass自体は
// 残す。
export class LocalWorkspaceReadNotEnabledError extends Error {
  constructor() {
    super(
      "Local Workspace file content reading is not enabled yet (planned for a later phase)."
    );
    this.name = "LocalWorkspaceReadNotEnabledError";
  }
}

// =========================
// Safe Read errors (LW-P2)
// =========================
//
// read()呼び出し元(useLocalWorkspace.ts等)が、拒否理由をinstanceof判定
// で分岐できるようにする。文字列比較には依存しない。

export class LocalWorkspaceInvalidPathError extends Error {
  readonly relativePath: string;
  constructor(relativePath: string, reason?: string) {
    super(`Invalid relativePath${reason ? ` (${reason})` : ""}: ${relativePath}`);
    this.name = "LocalWorkspaceInvalidPathError";
    this.relativePath = relativePath;
  }
}

// default excluded directory(node_modules/.git等)配下、隠しファイル、
// 機微ファイル名パターン(.env/*.pem/*.key等)への直接read()を拒否する。
export class LocalWorkspaceExcludedPathError extends Error {
  readonly relativePath: string;
  constructor(relativePath: string) {
    super(`Reading this path is not allowed: ${relativePath}`);
    this.name = "LocalWorkspaceExcludedPathError";
    this.relativePath = relativePath;
  }
}

export class LocalWorkspaceIsDirectoryError extends Error {
  readonly relativePath: string;
  constructor(relativePath: string) {
    super(`Cannot read a directory as a file: ${relativePath}`);
    this.name = "LocalWorkspaceIsDirectoryError";
    this.relativePath = relativePath;
  }
}

export class LocalWorkspaceFileNotFoundError extends Error {
  readonly relativePath: string;
  constructor(relativePath: string) {
    super(`File not found: ${relativePath}`);
    this.name = "LocalWorkspaceFileNotFoundError";
    this.relativePath = relativePath;
  }
}

export class LocalWorkspaceUnsupportedFileTypeError extends Error {
  readonly relativePath: string;
  readonly extension?: string;
  constructor(relativePath: string, extension?: string) {
    super(
      `Reading files with extension "${extension ?? "(none)"}" is not supported yet: ${relativePath}`
    );
    this.name = "LocalWorkspaceUnsupportedFileTypeError";
    this.relativePath = relativePath;
    this.extension = extension;
  }
}

export class LocalWorkspaceFileTooLargeError extends Error {
  readonly relativePath: string;
  readonly size: number;
  constructor(relativePath: string, size: number) {
    super(`File is too large to read: ${relativePath} (${size} bytes)`);
    this.name = "LocalWorkspaceFileTooLargeError";
    this.relativePath = relativePath;
    this.size = size;
  }
}
