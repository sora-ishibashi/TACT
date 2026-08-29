// =========================
// TACT Context Source — Local Workspace Read Policy (LW-P2)
// =========================
//
// Safe Readの対象拡張子・サイズ/文字数上限を定義するpure function群。
// DOM/Browser API/Node fsのいずれにも依存しない(実際のfile読み取りは
// browserAdapter.tsの責務)。将来Research/Design/Meeting/Code等から
// 共通利用できるよう、Browser固有型を一切引数・戻り値に含めない。
//
// MVP対象は安全なtext系拡張子に限定する。binary/PDF/Office/imageは
// 今回は読まない(既存fileAnalysis/Attachment parserへの統合も今回は
// しない)。

// text系のみ。バイナリ/PDF/Office/画像は含めない。
export const SUPPORTED_READ_EXTENSIONS: readonly string[] = [
  "txt",
  "md",
  "csv",
  "json",
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "html",
  "yml",
  "yaml",
];

// read()で1fileとして許容する最大size(byte)。これを超える場合は
// 「読まずにreject」する(巨大fileを無制限にmemoryへ載せないため)。
export const MAX_READ_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

// read()が返すcontentの最大文字数。これを超える場合はtruncateし、
// truncated=trueを返す(全文を無制限にmemory/戻り値へ載せないため)。
export const MAX_READ_CONTENT_CHARS = 200_000;

const SUPPORTED_READ_EXTENSION_SET = new Set(SUPPORTED_READ_EXTENSIONS);

export function isSupportedReadExtension(extension: string | undefined): boolean {

  if (!extension) {
    return false;
  }

  return SUPPORTED_READ_EXTENSION_SET.has(extension.toLowerCase());

}

export function isWithinMaxReadSize(size: number | undefined): boolean {

  if (typeof size !== "number") {
    // sizeが不明な場合は安全側(読み取り可能)とみなす。実際のsize
    // 判定はFile.size取得後にbrowserAdapter.ts側で再確認する。
    return true;
  }

  return size <= MAX_READ_FILE_SIZE_BYTES;

}

export interface TruncateTextResult {
  content: string;
  truncated: boolean;
}

export function truncateReadContent(text: string): TruncateTextResult {

  if (text.length <= MAX_READ_CONTENT_CHARS) {
    return { content: text, truncated: false };
  }

  return { content: text.slice(0, MAX_READ_CONTENT_CHARS), truncated: true };

}
