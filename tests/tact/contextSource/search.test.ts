// =========================
// TACT Context Source — Metadata Search Regression (LW-P2)
// =========================
//
// 対象: core/tact-context-source/search.ts
// (searchEntriesByMetadata・resolveSearchLimit)。
//
// 環境制約: DOM/IndexedDB/File System Access APIは一切使わない。
// LLM/Search API呼び出しも0(pure functionのみのCategory A Test)。

import "dotenv/config";
import {
  DEFAULT_SEARCH_RESULT_LIMIT,
  MAX_SEARCH_RESULT_LIMIT,
  resolveSearchLimit,
  searchEntriesByMetadata,
} from "../../../core/tact-context-source/search";
import type { ContextSourceEntryMetadata } from "../../../core/tact-context-source/types";
import { check, summarize, type CheckResult } from "../lib/check";

function entry(overrides: Partial<ContextSourceEntryMetadata>): ContextSourceEntryMetadata {
  return {
    name: "file.txt",
    relativePath: "file.txt",
    type: "file",
    ...overrides,
  };
}

const FIXTURE_ENTRIES: ContextSourceEntryMetadata[] = [
  entry({
    name: "sroi-memo.txt",
    relativePath: "notes/sroi-memo.txt",
    extension: "txt",
    size: 10,
    modifiedAt: "2026-08-01T00:00:00.000Z",
  }),
  entry({
    name: "readme.md",
    relativePath: "readme.md",
    extension: "md",
    size: 20,
    modifiedAt: "2026-08-02T00:00:00.000Z",
  }),
  entry({
    name: "index.ts",
    relativePath: "src/index.ts",
    extension: "ts",
    size: 30,
    modifiedAt: "2026-08-03T00:00:00.000Z",
  }),
  entry({
    name: "src",
    relativePath: "src",
    type: "directory",
  }),
];

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // fileName一致
  // ==========================================================

  results.push(
    check(
      "[Test1-1] fileNameの部分一致で発見できる",
      searchEntriesByMetadata(FIXTURE_ENTRIES, "readme").some(
        (e) => e.relativePath === "readme.md"
      )
    )
  );

  // ==========================================================
  // relativePath一致
  // ==========================================================

  results.push(
    check(
      "[Test2-1] relativePath(nested)の部分一致で発見できる",
      searchEntriesByMetadata(FIXTURE_ENTRIES, "notes/sroi").some(
        (e) => e.relativePath === "notes/sroi-memo.txt"
      )
    )
  );

  // ==========================================================
  // extension一致
  // ==========================================================

  results.push(
    check(
      "[Test3-1] extensionの一致で発見できる(拡張子検索)",
      searchEntriesByMetadata(FIXTURE_ENTRIES, "ts").some(
        (e) => e.relativePath === "src/index.ts"
      )
    )
  );

  // ==========================================================
  // 大文字小文字を区別しない
  // ==========================================================

  results.push(
    check(
      "[Test4-1] 大文字queryでも小文字fileNameを発見できる(case insensitive)",
      searchEntriesByMetadata(FIXTURE_ENTRIES, "README").some(
        (e) => e.relativePath === "readme.md"
      )
    )
  );

  // ==========================================================
  // 一致なし
  // ==========================================================

  results.push(
    check(
      "[Test5-1] 一致しないqueryは空配列を返す",
      searchEntriesByMetadata(FIXTURE_ENTRIES, "no-such-file-xyz").length === 0
    )
  );

  results.push(
    check(
      "[Test5-2] 空文字queryは空配列を返す(全件一致にしない)",
      searchEntriesByMetadata(FIXTURE_ENTRIES, "").length === 0 &&
        searchEntriesByMetadata(FIXTURE_ENTRIES, "   ").length === 0
    )
  );

  // ==========================================================
  // 件数上限
  // ==========================================================

  const manyEntries: ContextSourceEntryMetadata[] = Array.from({ length: 500 }, (_, i) =>
    entry({ name: `match-${i}.txt`, relativePath: `match-${i}.txt`, extension: "txt" })
  );

  results.push(
    check(
      "[Test6-1] limit指定時、結果件数がlimitを超えない",
      searchEntriesByMetadata(manyEntries, "match", { limit: 10 }).length === 10
    )
  );

  results.push(
    check(
      "[Test6-2] limit未指定時はDEFAULT_SEARCH_RESULT_LIMIT件を超えない",
      searchEntriesByMetadata(manyEntries, "match").length <= DEFAULT_SEARCH_RESULT_LIMIT
    )
  );

  results.push(
    check(
      "[Test6-3] resolveSearchLimitはMAX_SEARCH_RESULT_LIMITを超える指定を切り詰める",
      resolveSearchLimit(999999) === MAX_SEARCH_RESULT_LIMIT
    )
  );

  results.push(
    check(
      "[Test6-4] resolveSearchLimitは0以下・非数値をDEFAULT_SEARCH_RESULT_LIMITへfallbackする",
      resolveSearchLimit(0) === DEFAULT_SEARCH_RESULT_LIMIT &&
        resolveSearchLimit(-5) === DEFAULT_SEARCH_RESULT_LIMIT &&
        resolveSearchLimit(Number.NaN) === DEFAULT_SEARCH_RESULT_LIMIT
    )
  );

  // ==========================================================
  // 巨大結果セットでも安全に処理する(例外を投げない)
  // ==========================================================

  const hugeEntries: ContextSourceEntryMetadata[] = Array.from({ length: 20000 }, (_, i) =>
    entry({ name: `huge-match-${i}.txt`, relativePath: `huge-match-${i}.txt`, extension: "txt" })
  );

  results.push(
    check(
      "[Test7-1] 20000件のentriesを渡しても例外を投げず、limitで打ち切る",
      searchEntriesByMetadata(hugeEntries, "huge-match", { limit: 50 }).length === 50
    )
  );

  return summarize("contextSource/search", results);

}
