// =========================
// TACT Context Source — Local Workspace Browser Adapter (LW-P1)
// =========================
//
// LW-P0のContextSource contractを、File System Access API上に実装する。
// Browser固有型(FileSystemDirectoryHandle等)はこのファイル(および
// browserTypes.d.ts・errors.ts)に閉じ込め、core/tact-context-source/
// 直下の共通型(types.ts)には一切持ち込まない。
//
// 安全設計(LW-P1絶対条件):
// - showDirectoryPicker()はユーザー操作(button click等)からのみ
//   呼び出される想定。このファイル自身はどこからも自動実行しない。
// - permission確認はqueryPermission()(ユーザー操作不要・無音)を基本とし、
//   requestPermission()(ユーザー操作が必要)はconnect()内でのみ呼ぶ。
//   「持続していたhandleのpermissionを無音で確認する」ためだけに
//   requestPermission()を呼ぶことはしない(checkStoredPermission()参照)。
// - list/search/scanはLW-P0のshouldExcludeEntry/shouldTraverseDirectory
//   を必ず経由し、node_modules/.git/.env等には一切降りない。
// - read()はLW-P1では意図的に無効化していた(常にエラーを投げる)。
//   LW-P2でtext系拡張子に限定した安全なfile本文readを有効化した。
//   relativePath validation・default exclude再確認・directory
//   reject・拡張子/size/content上限・permission再確認は、
//   すべてこのファイル内で行う(呼び出し元の実装漏れに依存しない)。
// - search()はLW-P1のmetadata一致(fileName)に加え、LW-P2で
//   relativePath/extension一致、および軽量content index(対応
//   拡張子・size上限内のfileのみ)による本文一致を追加した。
//   file本文はここでbrowser memory上のindexとしてのみ扱い、
//   LLM/Search API/外部へは一切送信しない。
// - LW-P3: resolveWorkspaceContext()を追加した。明示的なWorkspace
//   参照意図がある場合のみ(resolver.tsのdetectExplicitWorkspaceIntent())
//   metadata scan/content indexingを行い、決定論的rankingで絞り込んだ
//   上限件数だけをperformSafeRead()経由で読む。LLM/Search APIは
//   一切呼ばず、directoryHandle以外(server等)へは何も送信しない
//   (このファイルはあくまでbounded LocalWorkspaceEvidence[]を作る
//   だけで、Research requestへの送信は呼び出し元UIの責務)。

import {
  isRelativePathExcluded,
  shouldExcludeEntry,
  validateRelativePath,
} from "../filtering";
import {
  resolveSearchLimit,
  searchEntriesByMetadata,
} from "../search";
import type {
  ContextSourceEntryMetadata,
  ContextSourceEntryType,
  ContextSourceReadResult,
  ContextSourceSearchParams,
  ContextSource,
} from "../types";
import {
  buildContentIndexEntry,
  isIndexableEntry,
  searchContentIndex,
  MAX_INDEX_ENTRIES,
  type LocalWorkspaceContentIndex,
} from "./contentIndex";
import {
  isSupportedReadExtension,
  truncateReadContent,
  MAX_READ_FILE_SIZE_BYTES,
} from "./readPolicy";
import {
  boundWorkspaceEvidenceByCharBudget,
  detectExplicitWorkspaceIntent,
  extractWorkspaceQueryTerms,
  rankWorkspaceCandidates,
  selectFilesWithinReadLimit,
} from "./resolver";
import { contextSourceReadResultToEvidence } from "./toEvidence";
import {
  LOCAL_WORKSPACE_DEFAULT_PERMISSIONS,
  type LocalWorkspaceConnection,
  type LocalWorkspaceEvidence,
  type LocalWorkspaceResolvedContext,
} from "./types";
import {
  LocalWorkspaceCancelledError,
  LocalWorkspaceExcludedPathError,
  LocalWorkspaceFileNotFoundError,
  LocalWorkspaceFileTooLargeError,
  LocalWorkspaceInvalidPathError,
  LocalWorkspaceIsDirectoryError,
  LocalWorkspaceNotConnectedError,
  LocalWorkspacePermissionDeniedError,
  LocalWorkspaceUnsupportedError,
  LocalWorkspaceUnsupportedFileTypeError,
} from "./errors";

// =========================
// Support detection
// =========================

export function isFileSystemAccessSupported(): boolean {

  return (
    typeof window !== "undefined" &&
    typeof window.showDirectoryPicker === "function"
  );

}

// =========================
// Permission helpers
// =========================
//
// checkStoredPermission(): queryPermission()のみ(ユーザー操作不要)。
// IndexedDBから復元したhandleのpermissionを、ページ読み込み時などに
// 無音で確認するためのもの。ここではrequestPermission()を絶対に
// 呼ばない(呼び出し元がユーザー操作なしで勝手にダイアログを
// 出さないようにするための最重要ガード)。
export async function checkStoredPermission(
  handle: FileSystemDirectoryHandle
): Promise<PermissionState> {

  return handle.queryPermission({ mode: "read" });

}

// connect()内でのみ使う。requestPermission()を呼ぶため、必ず
// ユーザー操作(button click等)を起点にした呼び出し経路からのみ
// 到達するようにする(useLocalWorkspace.ts側の責務)。
async function ensureReadPermission(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {

  const current = await handle.queryPermission({ mode: "read" });

  if (current === "granted") {
    return true;
  }

  const requested = await handle.requestPermission({ mode: "read" });

  return requested === "granted";

}

// =========================
// Path / metadata helpers
// =========================

async function resolveDirectoryHandle(
  root: FileSystemDirectoryHandle,
  relativePath?: string
): Promise<FileSystemDirectoryHandle> {

  if (!relativePath) {
    return root;
  }

  const validation = validateRelativePath(relativePath);

  if (!validation.ok) {
    throw new Error(`Invalid relativePath (${validation.reason}): ${relativePath}`);
  }

  const segments = relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);

  let current = root;

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment);
  }

  return current;

}

// read()・content indexing両方から使う、file単体解決helper。
// resolveDirectoryHandle()と違いdirectory部分のみ辿り、最後は
// getFileHandle()で確定させる(directoryをfileとして開こうとした場合は
// ここでbrowser側のエラーが伝播する)。
async function resolveFileHandle(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<FileSystemFileHandle> {

  const segments = relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);

  const fileName = segments.pop();

  if (!fileName) {
    throw new LocalWorkspaceFileNotFoundError(relativePath);
  }

  let current = root;

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment);
  }

  return current.getFileHandle(fileName);

}

function extractExtension(name: string): string | undefined {

  const lastDot = name.lastIndexOf(".");

  if (lastDot <= 0 || lastDot === name.length - 1) {
    return undefined;
  }

  return name.slice(lastDot + 1).toLowerCase();

}

async function readFileMetadata(
  handle: FileSystemFileHandle,
  name: string,
  relativePath: string
): Promise<ContextSourceEntryMetadata> {

  // getFile()自体はファイル本文を読まない(File objectのmetadataを
  // 取得するだけ)。本文取得はFile.text()等を呼んで初めて発生するが、
  // LW-P1のread()は常にエラーを投げるため、本文取得経路はどこからも
  // 到達しない。
  const file = await handle.getFile();

  return {
    name,
    relativePath,
    type: "file",
    size: file.size,
    modifiedAt: new Date(file.lastModified).toISOString(),
    mimeType: file.type || undefined,
    extension: extractExtension(name),
  };

}

// =========================
// Recursive walk(scan/search共通)
// =========================
//
// LW-P0のshouldExcludeEntry/shouldTraverseDirectoryを必ず経由する。
// symlink containmentは保証しない(LW-P0で明記済みの残存リスク)ため、
// symlinkループ等による無限走査を避ける安全弁として、件数上限
// (MAX_SCAN_ENTRIES)と深さ上限(MAX_SCAN_DEPTH)の両方を設ける。

export const MAX_SCAN_ENTRIES = 5000;
export const MAX_SCAN_DEPTH = 12;

interface WalkBudget {
  remaining: number;
}

async function* walkEntries(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string,
  depth: number,
  budget: WalkBudget
): AsyncGenerator<ContextSourceEntryMetadata> {

  if (depth > MAX_SCAN_DEPTH) {
    return;
  }

  for await (const [name, handle] of dirHandle.entries()) {

    if (budget.remaining <= 0) {
      return;
    }

    const type: ContextSourceEntryType = handle.kind === "directory" ? "directory" : "file";

    if (shouldExcludeEntry({ name, type })) {
      continue;
    }

    const relativePath = basePath ? `${basePath}/${name}` : name;

    if (type === "file") {

      budget.remaining -= 1;
      yield await readFileMetadata(handle as FileSystemFileHandle, name, relativePath);

    } else {

      budget.remaining -= 1;
      yield { name, relativePath, type: "directory" };

      yield* walkEntries(handle as FileSystemDirectoryHandle, relativePath, depth + 1, budget);

    }

  }

}

// read()の本体。LW-P3のresolveWorkspaceContext()からも同じ安全確認
// パイプライン(path validation・default exclude・directory reject・
// 拡張子/size/content上限・permission再確認)を経由させるため、
// アダプター factory外の独立関数として切り出す(read()メソッドと
// resolveWorkspaceContext()の両方から呼ぶ。`this`束縛に依存しない)。
async function performSafeRead(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<ContextSourceReadResult> {

  const validation = validateRelativePath(relativePath);

  if (!validation.ok) {
    throw new LocalWorkspaceInvalidPathError(relativePath, validation.reason);
  }

  if (isRelativePathExcluded(relativePath)) {
    throw new LocalWorkspaceExcludedPathError(relativePath);
  }

  // permission再確認(無音のqueryPermissionのみ。requestPermission()は
  // ここから絶対に呼ばない。permissionが失効している場合は
  // needs_permission状態としてUI側の再許可操作を待つ)。
  const permission = await root.queryPermission({ mode: "read" });

  if (permission !== "granted") {
    throw new LocalWorkspacePermissionDeniedError();
  }

  const segments = relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  const fileName = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);

  let dirHandle = root;

  try {

    for (const segment of dirSegments) {
      dirHandle = await dirHandle.getDirectoryHandle(segment);
    }

  } catch {
    throw new LocalWorkspaceFileNotFoundError(relativePath);
  }

  let fileHandle: FileSystemFileHandle;

  try {

    fileHandle = await dirHandle.getFileHandle(fileName);

  } catch {

    // getFileHandle()が失敗した場合、対象が実はdirectoryである
    // 可能性を区別する(directoryはreject、存在しない場合は
    // safe failureとして別Errorにする)。
    let isDirectory = false;

    try {
      await dirHandle.getDirectoryHandle(fileName);
      isDirectory = true;
    } catch {
      isDirectory = false;
    }

    if (isDirectory) {
      throw new LocalWorkspaceIsDirectoryError(relativePath);
    }

    throw new LocalWorkspaceFileNotFoundError(relativePath);

  }

  const extension = extractExtension(fileName);

  if (!isSupportedReadExtension(extension)) {
    throw new LocalWorkspaceUnsupportedFileTypeError(relativePath, extension);
  }

  const file = await fileHandle.getFile();

  if (file.size > MAX_READ_FILE_SIZE_BYTES) {
    throw new LocalWorkspaceFileTooLargeError(relativePath, file.size);
  }

  // UTF-8 text前提(File.text()はUTF-8としてdecodeする)。
  const rawText = await file.text();
  const { content, truncated } = truncateReadContent(rawText);

  const entry: ContextSourceEntryMetadata = {
    name: fileName,
    relativePath,
    type: "file",
    size: file.size,
    modifiedAt: new Date(file.lastModified).toISOString(),
    mimeType: file.type || undefined,
    extension,
  };

  return { entry, content, truncated };

}

export interface LocalWorkspaceScanResult {
  entries: ContextSourceEntryMetadata[];
  fileCount: number;
  // 件数上限に到達し、全件を走査しきれなかった場合true。
  truncated: boolean;
  scannedAt: string;
}

// =========================
// Adapter factory
// =========================

export interface CreateBrowserLocalWorkspaceAdapterOptions {
  // 既存のhandle(IndexedDBから復元した場合等)を渡すと、connect()は
  // showDirectoryPicker()を呼ばずpermission確認のみを行う。
  directoryHandle?: FileSystemDirectoryHandle;
  // 省略時は新規に生成する(IndexedDB永続化はhandleStore.ts側の責務)。
  workspaceId?: string;
}

export interface LocalWorkspaceBrowserAdapter extends ContextSource {
  readonly directoryHandle: FileSystemDirectoryHandle | null;
  // ContextSource.connect()の戻り値(ContextSourceConnection)を、
  // より具体的なLocalWorkspaceConnection(rootLabelを含む)へ
  // 共変(covariant)に上書きする。呼び出し側がキャストなしで
  // rootLabelへアクセスできるようにするための型上の宣言のみであり、
  // 実装(下のcreateBrowserLocalWorkspaceAdapter())は元々
  // LocalWorkspaceConnectionを返している。
  connect(): Promise<LocalWorkspaceConnection>;
  scan(relativePath?: string): Promise<LocalWorkspaceScanResult>;
  // LW-P3: Research userInputから、明示的なWorkspace参照意図がある
  // 場合のみbounded LocalWorkspaceEvidence[]を組み立てる。
  resolveWorkspaceContext(query: string): Promise<LocalWorkspaceResolvedContext>;
}

function createWorkspaceId(): string {

  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `local-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`;

}

export function createBrowserLocalWorkspaceAdapter(
  options: CreateBrowserLocalWorkspaceAdapterOptions = {}
): LocalWorkspaceBrowserAdapter {

  let directoryHandle: FileSystemDirectoryHandle | null = options.directoryHandle ?? null;
  const workspaceId = options.workspaceId ?? createWorkspaceId();

  function requireDirectoryHandle(): FileSystemDirectoryHandle {

    if (!directoryHandle) {
      throw new LocalWorkspaceNotConnectedError();
    }

    return directoryHandle;

  }

  return {

    kind: "local_workspace",
    permissions: LOCAL_WORKSPACE_DEFAULT_PERMISSIONS,

    get directoryHandle() {
      return directoryHandle;
    },

    async connect(): Promise<LocalWorkspaceConnection> {

      let handle = directoryHandle;

      // 既存handle(IndexedDBから復元した場合等)が渡されている場合は、
      // showDirectoryPicker()を呼ぶ必要が無いため、対応browserかどうかの
      // 判定はpicker経路(handleが未取得の場合)にのみ適用する。
      if (!handle) {

        if (!isFileSystemAccessSupported()) {
          throw new LocalWorkspaceUnsupportedError();
        }

        const picker = window.showDirectoryPicker;

        if (!picker) {
          throw new LocalWorkspaceUnsupportedError();
        }

        try {
          handle = await picker({ mode: "read" });
        } catch (error) {

          if (error instanceof DOMException && error.name === "AbortError") {
            throw new LocalWorkspaceCancelledError();
          }

          throw error;

        }

      }

      const granted = await ensureReadPermission(handle);

      if (!granted) {
        throw new LocalWorkspacePermissionDeniedError();
      }

      directoryHandle = handle;

      const connection: LocalWorkspaceConnection = {
        id: workspaceId,
        kind: "local_workspace",
        label: handle.name,
        rootLabel: handle.name,
        connectedAt: new Date().toISOString(),
        permissions: LOCAL_WORKSPACE_DEFAULT_PERMISSIONS,
      };

      return connection;

    },

    async disconnect(): Promise<void> {
      directoryHandle = null;
    },

    async list(relativePath?: string): Promise<ContextSourceEntryMetadata[]> {

      const root = requireDirectoryHandle();
      const dirHandle = await resolveDirectoryHandle(root, relativePath);
      const results: ContextSourceEntryMetadata[] = [];

      for await (const [name, handle] of dirHandle.entries()) {

        const type: ContextSourceEntryType = handle.kind === "directory" ? "directory" : "file";

        if (shouldExcludeEntry({ name, type })) {
          continue;
        }

        const entryRelativePath = relativePath ? `${relativePath}/${name}` : name;

        if (type === "file") {
          results.push(
            await readFileMetadata(handle as FileSystemFileHandle, name, entryRelativePath)
          );
        } else {
          results.push({ name, relativePath: entryRelativePath, type: "directory" });
        }

      }

      return results;

    },

    // LW-P2: fileName/relativePath/extensionのmetadata一致に加え、
    // 対応拡張子・size上限内のfileについては軽量content indexを
    // その場で構築し、本文一致も候補に含める。全file本文をLLM/APIへ
    // 送ることはしない(index構築・検索ともにこのbrowser adapter内、
    // memory上で完結する)。
    async search(params: ContextSourceSearchParams): Promise<ContextSourceEntryMetadata[]> {

      const root = requireDirectoryHandle();
      const rawQuery = typeof params.query === "string" ? params.query.trim() : "";

      if (!rawQuery) {
        return [];
      }

      const limit = resolveSearchLimit(params.limit);

      // metadata一致の判定はcore/tact-context-source/search.tsへ委譲する
      // ため、まずbudget内で全entryのmetadataを集める(walkEntries自体が
      // shouldExcludeEntry/shouldTraverseDirectoryを経由済み)。
      const budget: WalkBudget = { remaining: MAX_SCAN_ENTRIES };
      const entries: ContextSourceEntryMetadata[] = [];

      for await (const entry of walkEntries(root, "", 0, budget)) {
        entries.push(entry);
      }

      const metadataMatches = searchEntriesByMetadata(entries, rawQuery, { limit });
      const matchedPaths = new Set(metadataMatches.map((entry) => entry.relativePath));
      const remainingForContent = limit - metadataMatches.length;

      if (remainingForContent <= 0) {
        return metadataMatches;
      }

      // content indexの対象候補: metadataで既に一致した件はcontent側では
      // 見なくてよい。件数上限(MAX_INDEX_ENTRIES)で、検索1回あたりに
      // 本文を読むfile数を有限に保つ。
      const candidates = entries
        .filter(
          (entry) => !matchedPaths.has(entry.relativePath) && isIndexableEntry(entry)
        )
        .slice(0, MAX_INDEX_ENTRIES);

      const index: LocalWorkspaceContentIndex = [];

      for (const candidate of candidates) {

        try {

          const fileHandle = await resolveFileHandle(root, candidate.relativePath);
          const file = await fileHandle.getFile();
          const text = await file.text();

          index.push({
            relativePath: candidate.relativePath,
            contentLower: text.toLowerCase(),
          });

        } catch {
          // 読めなかったfileはindexingをskipする(検索全体は失敗させない)。
          continue;
        }

      }

      const contentMatchPaths = new Set(
        searchContentIndex(index, rawQuery, remainingForContent)
      );
      const contentMatches = entries.filter((entry) =>
        contentMatchPaths.has(entry.relativePath)
      );

      return [...metadataMatches, ...contentMatches].slice(0, limit);

    },

    // LW-P2: 許可済みWorkspace内、対応text拡張子のfileに限りfile本文を
    // 返す。関連する全ての安全確認(path validation・default exclude・
    // directory reject・拡張子/size/content上限・permission再確認)は
    // performSafeRead()(このファイル冒頭で定義)へ委譲する。
    async read(relativePath: string): Promise<ContextSourceReadResult> {

      const root = requireDirectoryHandle();

      return performSafeRead(root, relativePath);

    },

    // =========================
    // Workspace Context Resolver (LW-P3)
    // =========================
    //
    // Research userInputから、明示的なWorkspace参照意図がある場合のみ
    // (detectExplicitWorkspaceIntent())、この1回の呼び出し内で
    // metadata scan + 軽量content indexを構築し、決定論的ranking
    // (rankWorkspaceCandidates())で候補を絞り込み、上限件数まで
    // performSafeRead()で本文を読む。LLM/Search APIは一切呼ばない。
    // 意図が検出されない場合、directoryHandleへは一切アクセスしない
    // (search/read自体が発生しない)。
    async resolveWorkspaceContext(query: string): Promise<LocalWorkspaceResolvedContext> {

      if (!directoryHandle) {
        return { used: false, evidence: [], candidateCount: 0, readCount: 0, reason: "not_connected" };
      }

      if (!detectExplicitWorkspaceIntent(query)) {
        return { used: false, evidence: [], candidateCount: 0, readCount: 0, reason: "no_intent" };
      }

      const root = directoryHandle;

      // permission再確認(無音のqueryPermissionのみ。失効時はここで
      // 安全に0件へfallbackする。requestPermission()はここから
      // 絶対に呼ばない——検索起点でユーザーへ無音の許可ダイアログを
      // 出さないため)。
      const permission = await root.queryPermission({ mode: "read" });

      if (permission !== "granted") {
        return { used: false, evidence: [], candidateCount: 0, readCount: 0, reason: "permission_revoked" };
      }

      const terms = extractWorkspaceQueryTerms(query);

      if (terms.length === 0) {
        return { used: false, evidence: [], candidateCount: 0, readCount: 0, reason: "no_candidates" };
      }

      const budget: WalkBudget = { remaining: MAX_SCAN_ENTRIES };
      const entries: ContextSourceEntryMetadata[] = [];

      for await (const entry of walkEntries(root, "", 0, budget)) {
        entries.push(entry);
      }

      // content indexは1回だけ構築する(search()と違い、term数分だけ
      // 繰り返しfileを読み直さない)。
      const indexCandidates = entries.filter(isIndexableEntry).slice(0, MAX_INDEX_ENTRIES);
      const contentIndex: LocalWorkspaceContentIndex = [];

      for (const candidate of indexCandidates) {

        try {

          const fileHandle = await resolveFileHandle(root, candidate.relativePath);
          const file = await fileHandle.getFile();
          const text = await file.text();

          contentIndex.push(buildContentIndexEntry(candidate.relativePath, text));

        } catch {
          continue;
        }

      }

      const ranked = rankWorkspaceCandidates(entries, contentIndex, terms);

      if (ranked.length === 0) {
        return { used: false, evidence: [], candidateCount: 0, readCount: 0, reason: "no_candidates" };
      }

      const toRead = selectFilesWithinReadLimit(ranked);
      const reads: LocalWorkspaceEvidence[] = [];

      for (const candidate of toRead) {

        try {

          const result = await performSafeRead(root, candidate.entry.relativePath);
          reads.push(contextSourceReadResultToEvidence(workspaceId, result));

        } catch {
          // 読めなかった候補はskipする(resolver全体は失敗させない、
          // 「0件でも安全にResearchを続行」の方針と同じ)。
          continue;
        }

      }

      const bounded = boundWorkspaceEvidenceByCharBudget(reads);

      return {
        used: bounded.length > 0,
        evidence: bounded,
        candidateCount: ranked.length,
        readCount: bounded.length,
        reason: bounded.length === 0 ? "no_candidates" : undefined,
      };

    },

    async scan(relativePath?: string): Promise<LocalWorkspaceScanResult> {

      const root = requireDirectoryHandle();
      const startHandle = await resolveDirectoryHandle(root, relativePath);
      const entries: ContextSourceEntryMetadata[] = [];
      const budget: WalkBudget = { remaining: MAX_SCAN_ENTRIES };

      for await (const entry of walkEntries(startHandle, relativePath ?? "", 0, budget)) {
        entries.push(entry);
      }

      return {
        entries,
        fileCount: entries.filter((entry) => entry.type === "file").length,
        truncated: budget.remaining <= 0,
        scannedAt: new Date().toISOString(),
      };

    },

  };

}
