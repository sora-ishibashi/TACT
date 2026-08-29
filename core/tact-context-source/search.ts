// =========================
// TACT Context Source — Metadata Search (LW-P2)
// =========================
//
// 目的: 既に取得済みのContextSourceEntryMetadata配列(scan/list結果)から、
// LLM/Search APIを一切使わずclient-side deterministicにfileName/
// relativePath/extensionを検索するpure function。DOM/Browser API/
// Node fsのいずれにも依存しないため、Local Workspaceに限らず将来
// Drive/GitHub等の他ContextSourceでも共通利用できる
// (core/tact-context-source/index.ts経由で公開する)。
//
// ここでは「本文検索」は扱わない(本文はfile本文を読む必要があり、
// Browser固有のFileSystemHandleに依存するため、Local Workspace固有の
// localWorkspace/contentIndex.tsに置く)。

import type { ContextSourceEntryMetadata } from "./types";

// 呼び出し元がlimitを指定しない場合のdefault、および指定してもこれ以上
// 大きくできない上限。「巨大結果を安全に処理する」ため、どちらも
// 有限の定数にする。
export const DEFAULT_SEARCH_RESULT_LIMIT = 200;
export const MAX_SEARCH_RESULT_LIMIT = 1000;

export interface MetadataSearchOptions {
  limit?: number;
}

function normalizeSearchQuery(query: string): string {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}

export function resolveSearchLimit(limit?: number): number {

  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_SEARCH_RESULT_LIMIT;
  }

  return Math.min(Math.floor(limit), MAX_SEARCH_RESULT_LIMIT);

}

function matchesMetadata(entry: ContextSourceEntryMetadata, normalizedQuery: string): boolean {

  if (entry.name.toLowerCase().includes(normalizedQuery)) {
    return true;
  }

  if (entry.relativePath.toLowerCase().includes(normalizedQuery)) {
    return true;
  }

  if (entry.extension && entry.extension.toLowerCase().includes(normalizedQuery)) {
    return true;
  }

  return false;

}

// query空文字は常に空配列を返す(全件一致のような意図しない巨大結果を
// 防ぐ)。entriesは呼び出し元が既にshouldExcludeEntry等でfilter済みの
// 前提だが、念のためここでも追加のfilterは行わない(walker側の責務を
// 重複させない)。
export function searchEntriesByMetadata(
  entries: ContextSourceEntryMetadata[],
  query: string,
  options: MetadataSearchOptions = {}
): ContextSourceEntryMetadata[] {

  const normalizedQuery = normalizeSearchQuery(query);

  if (!normalizedQuery) {
    return [];
  }

  const limit = resolveSearchLimit(options.limit);
  const matches: ContextSourceEntryMetadata[] = [];

  for (const entry of entries) {

    if (matchesMetadata(entry, normalizedQuery)) {

      matches.push(entry);

      if (matches.length >= limit) {
        break;
      }

    }

  }

  return matches;

}
