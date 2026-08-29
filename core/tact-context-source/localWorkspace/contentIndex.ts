// =========================
// TACT Context Source — Local Workspace Content Index (LW-P2)
// =========================
//
// 「SROI」のようなqueryから、fileName/relativePathだけでなく本文の
// 内容も候補として発見できるようにするための、軽量なlocal content
// index。LLM/Search APIは一切使わず、ユーザーのbrowser内で完結する
// (API原価0)。
//
// ここはpure functionのみ(index構造の型・検索ロジック)を置き、実際に
// file本文を読んでindexを構築する処理(FileSystemFileHandle経由)は
// browserAdapter.ts側の責務とする(DOM/Browser API依存をここに
// 持ち込まない)。
//
// 重要: 全file本文をLLM/APIへ送ることは禁止。ここで構築したindexは
// browser memory上にのみ存在し、どこにも送信しない。

import type { ContextSourceEntryMetadata } from "../types";
import { isSupportedReadExtension } from "./readPolicy";

// indexingの対象とするfile 1件あたりの最大size(byte)。read()単体の
// 上限(MAX_READ_FILE_SIZE_BYTES)より意図的に小さくする。検索1回で
// 複数fileの本文をmemoryへ載せるため、read()単体より保守的にする。
export const MAX_INDEX_FILE_SIZE_BYTES = 256 * 1024; // 256KB

// 1回の検索でindex化するfile件数の上限(件数上限)。Workspaceが
// 大きい場合でも、検索1回のコストを有限に保つ。
export const MAX_INDEX_ENTRIES = 300;

// 1fileあたりindexへ取り込む文字数の上限(全文をindex化しない)。
export const MAX_INDEX_CONTENT_CHARS_PER_FILE = 20_000;

export interface LocalWorkspaceContentIndexEntry {
  relativePath: string;
  // 検索用に小文字化した内容の先頭MAX_INDEX_CONTENT_CHARS_PER_FILE文字。
  // 元の大文字/小文字は保持しない(この配列はUI表示に使わない、
  // 検索専用のindex)。
  contentLower: string;
}

export type LocalWorkspaceContentIndex = LocalWorkspaceContentIndexEntry[];

// entryがcontent indexingの対象かどうか(fileであり、対応拡張子であり、
// sizeが上限以内)。呼び出し元(browserAdapter.ts)は、この判定を通った
// entryについてのみfile本文を読む。
export function isIndexableEntry(entry: ContextSourceEntryMetadata): boolean {

  if (entry.type !== "file") {
    return false;
  }

  if (!isSupportedReadExtension(entry.extension)) {
    return false;
  }

  if (typeof entry.size === "number" && entry.size > MAX_INDEX_FILE_SIZE_BYTES) {
    return false;
  }

  return true;

}

export function buildContentIndexEntry(
  relativePath: string,
  content: string
): LocalWorkspaceContentIndexEntry {

  return {
    relativePath,
    contentLower: content.slice(0, MAX_INDEX_CONTENT_CHARS_PER_FILE).toLowerCase(),
  };

}

// index内を本文検索し、一致したrelativePathの配列を返す(呼び出し元が
// 元のContextSourceEntryMetadataへ引き当てる)。query空文字は常に
// 空配列(全件一致という意図しない巨大結果を防ぐ)。
export function searchContentIndex(
  index: LocalWorkspaceContentIndex,
  query: string,
  limit: number
): string[] {

  const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";

  if (!normalizedQuery || limit <= 0) {
    return [];
  }

  const matches: string[] = [];

  for (const item of index) {

    if (item.contentLower.includes(normalizedQuery)) {

      matches.push(item.relativePath);

      if (matches.length >= limit) {
        break;
      }

    }

  }

  return matches;

}
