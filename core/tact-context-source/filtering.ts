// =========================
// TACT Context Source — Filtering / Security (LW-P0)
// =========================
//
// 目的: 将来のwalker(Browser adapter / Local Agent adapterのどちらでも
// 使う想定)が、directoryへ「降りる前」に安全側の判断を下せるようにする
// pure function群。「取得後に除外する」実装は、除外対象の大きな
// directory(node_modules等)を先に全走査してしまいコストが高いため
// 採用しない。
//
// OS依存のabsolute path処理(path.resolve等)はここに一切持ち込まない。
// 判定は文字列としてのrelativePath/nameのみを対象にする。

// =========================
// Default excludes
// =========================

export const DEFAULT_EXCLUDED_DIRECTORY_NAMES: readonly string[] = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "tmp",
  "temp",
];

// 秘密情報の可能性が高いファイル名パターン。ここに一致するファイルは
// listにも含めない(=読み取り候補にすら出さない)。
const SENSITIVE_FILE_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.pem$/i,
  /\.key$/i,
];

export function isDefaultExcludedDirectoryName(name: string): boolean {
  return DEFAULT_EXCLUDED_DIRECTORY_NAMES.includes(name);
}

export function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

// 隠しファイル/ディレクトリ(dotfile)の安全側default: 明示的に許可する
// 仕組みをLW-P0では持たないため、常に除外する。
export function isHiddenEntryName(name: string): boolean {
  return name.startsWith(".");
}

export interface FilterableEntry {
  name: string;
  type: "file" | "directory";
}

// walkerがdirectoryへ降りる前に呼ぶ。falseの場合は列挙・再帰のどちらも
// 行わない(=中身は一切読まれない)。
export function shouldTraverseDirectory(name: string): boolean {

  if (isDefaultExcludedDirectoryName(name)) {
    return false;
  }

  if (isHiddenEntryName(name)) {
    return false;
  }

  return true;

}

// list/search結果に含めてよいかどうか(file/directory共通の最終判定)。
// directoryはshouldTraverseDirectory()と同じ基準を用いる(「一覧には
// 出すが中には降りない」という中間状態はLW-P0では設けない)。
export function shouldExcludeEntry(entry: FilterableEntry): boolean {

  if (entry.type === "directory") {
    return !shouldTraverseDirectory(entry.name);
  }

  if (isHiddenEntryName(entry.name)) {
    return true;
  }

  if (isSensitiveFileName(entry.name)) {
    return true;
  }

  return false;

}

// =========================
// Combined exclude check (relativePath全体、LW-P2)
// =========================
//
// read()等、「1つのfileへ直接アクセスする」経路向けの安全確認。
// 祖先directoryのいずれかがshouldTraverseDirectory()でfalseになる場合
// (node_modules配下・.git配下・隠しdirectory配下等)、およびfile名自体が
// 隠しファイル/機微ファイル名パターンに一致する場合、両方をtrueとする。
// walker(scan/list/search)を経由しない直接read呼び出しでも、
// 同じ除外基準を必ず通過させるためのもの。
export function isRelativePathExcluded(relativePath: string): boolean {

  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return true;
  }

  const directorySegments = segments.slice(0, -1);
  const fileName = segments[segments.length - 1];

  if (directorySegments.some((segment) => !shouldTraverseDirectory(segment))) {
    return true;
  }

  if (isHiddenEntryName(fileName) || isSensitiveFileName(fileName)) {
    return true;
  }

  return false;

}

// =========================
// Path traversal validation
// =========================
//
// relativePathの「文字列としての形」だけを検証する。実際のfs解決・
// symlink解決は行わない(Browser adapter/Local Agent adapter側の責務。
// symlink containmentはP0の保証対象外)。

export type PathValidationFailureReason =
  | "empty_path"
  | "null_byte"
  | "absolute_path"
  | "path_traversal"
  | "malformed_path";

export interface PathValidationResult {
  ok: boolean;
  reason?: PathValidationFailureReason;
}

const WINDOWS_DRIVE_LETTER_PATTERN = /^[a-zA-Z]:[\\/]/;

export function validateRelativePath(relativePath: string): PathValidationResult {

  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return { ok: false, reason: "empty_path" };
  }

  if (relativePath.includes("\0")) {
    return { ok: false, reason: "null_byte" };
  }

  if (relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    return { ok: false, reason: "absolute_path" };
  }

  if (WINDOWS_DRIVE_LETTER_PATTERN.test(relativePath)) {
    return { ok: false, reason: "absolute_path" };
  }

  const segments = relativePath.split(/[\\/]+/);

  // "../"・"..\"のどちらも、区切り文字で分割した時点で".."という
  // segmentとして現れるため、スラッシュ/バックスラッシュを区別せず
  // 同じ判定で弾ける。
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, reason: "path_traversal" };
  }

  if (segments.some((segment) => segment.trim().length === 0)) {
    return { ok: false, reason: "malformed_path" };
  }

  return { ok: true };

}
