// =========================
// TACT Context Source — Local Workspace Content Index / Read Policy
// Regression (LW-P2)
// =========================
//
// 対象: core/tact-context-source/localWorkspace/contentIndex.ts
// (isIndexableEntry・buildContentIndexEntry・searchContentIndex)、
// core/tact-context-source/localWorkspace/readPolicy.ts
// (isSupportedReadExtension・isWithinMaxReadSize・truncateReadContent)。
//
// 環境制約: DOM/IndexedDB/File System Access APIは一切使わない。
// LLM/Search API呼び出しも0(pure functionのみのCategory A Test)。
// content indexはbrowser memory上にのみ存在し、どこにも送信しない
// (このTestFile自体もfetch/network呼び出しを一切行わない)。

import "dotenv/config";
import {
  MAX_INDEX_FILE_SIZE_BYTES,
  buildContentIndexEntry,
  isIndexableEntry,
  searchContentIndex,
  type LocalWorkspaceContentIndex,
} from "../../../core/tact-context-source/localWorkspace/contentIndex";
import {
  MAX_READ_CONTENT_CHARS,
  MAX_READ_FILE_SIZE_BYTES,
  SUPPORTED_READ_EXTENSIONS,
  isSupportedReadExtension,
  isWithinMaxReadSize,
  truncateReadContent,
} from "../../../core/tact-context-source/localWorkspace/readPolicy";
import type { ContextSourceEntryMetadata } from "../../../core/tact-context-source/types";
import { check, summarize, type CheckResult } from "../lib/check";

function fileEntry(overrides: Partial<ContextSourceEntryMetadata>): ContextSourceEntryMetadata {
  return {
    name: "file.txt",
    relativePath: "file.txt",
    type: "file",
    extension: "txt",
    size: 100,
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // readPolicy: 対応拡張子
  // ==========================================================

  results.push(
    check(
      "[Test1-1] MVP対象拡張子(txt/md/csv/json/ts/tsx/js/jsx/css/html/yml/yaml)が全てサポートされる",
      [
        "txt", "md", "csv", "json", "ts", "tsx", "js", "jsx", "css", "html", "yml", "yaml",
      ].every((ext) => isSupportedReadExtension(ext))
    )
  );

  results.push(
    check(
      "[Test1-2] SUPPORTED_READ_EXTENSIONSとisSupportedReadExtensionが一致する",
      SUPPORTED_READ_EXTENSIONS.every((ext) => isSupportedReadExtension(ext))
    )
  );

  results.push(
    check(
      "[Test1-3] binary/image/Office/PDF等の拡張子は非対応",
      !isSupportedReadExtension("png") &&
        !isSupportedReadExtension("pdf") &&
        !isSupportedReadExtension("docx") &&
        !isSupportedReadExtension("exe")
    )
  );

  results.push(
    check(
      "[Test1-4] 拡張子なし(undefined)は非対応",
      !isSupportedReadExtension(undefined)
    )
  );

  results.push(
    check(
      "[Test1-5] 拡張子判定は大文字小文字を区別しない",
      isSupportedReadExtension("TS") && isSupportedReadExtension("Md")
    )
  );

  // ==========================================================
  // readPolicy: size / content上限
  // ==========================================================

  results.push(
    check(
      "[Test2-1] size上限以内はtrue、超過はfalse",
      isWithinMaxReadSize(MAX_READ_FILE_SIZE_BYTES) === true &&
        isWithinMaxReadSize(MAX_READ_FILE_SIZE_BYTES + 1) === false
    )
  );

  results.push(
    check(
      "[Test2-2] size不明(undefined)は安全側(true)として扱う",
      isWithinMaxReadSize(undefined) === true
    )
  );

  {
    const shortText = "hello world";
    const shortResult = truncateReadContent(shortText);

    results.push(
      check(
        "[Test2-3] 上限以内のtextはtruncateされない",
        shortResult.content === shortText && shortResult.truncated === false
      )
    );

    const longText = "a".repeat(MAX_READ_CONTENT_CHARS + 100);
    const longResult = truncateReadContent(longText);

    results.push(
      check(
        "[Test2-4] 上限を超えるtextはMAX_READ_CONTENT_CHARSでtruncateされ、truncated=trueになる",
        longResult.content.length === MAX_READ_CONTENT_CHARS && longResult.truncated === true
      )
    );
  }

  // ==========================================================
  // contentIndex: indexing対象判定
  // ==========================================================

  results.push(
    check(
      "[Test3-1] 対応拡張子・size上限内のfileはindexing対象",
      isIndexableEntry(fileEntry({ extension: "md", size: 100 })) === true
    )
  );

  results.push(
    check(
      "[Test3-2] directoryはindexing対象外",
      isIndexableEntry(fileEntry({ type: "directory", extension: undefined })) === false
    )
  );

  results.push(
    check(
      "[Test3-3] 非対応拡張子(png)はindexing対象外",
      isIndexableEntry(fileEntry({ extension: "png" })) === false
    )
  );

  results.push(
    check(
      "[Test3-4] MAX_INDEX_FILE_SIZE_BYTESを超えるfileはindexing対象外",
      isIndexableEntry(fileEntry({ size: MAX_INDEX_FILE_SIZE_BYTES + 1 })) === false
    )
  );

  // ==========================================================
  // contentIndex: 検索
  // ==========================================================

  const index: LocalWorkspaceContentIndex = [
    buildContentIndexEntry("notes/memo.txt", "This project measures SROI for the program."),
    buildContentIndexEntry("docs/research.md", "# Research\nSROI methodology overview."),
    buildContentIndexEntry("readme.md", "# hello world"),
  ];

  results.push(
    check(
      "[Test4-1] 本文中の語(SROI)を含むfileをrelativePathで発見できる(大文字小文字区別なし)",
      new Set(searchContentIndex(index, "sroi", 10)).has("notes/memo.txt") &&
        new Set(searchContentIndex(index, "SROI", 10)).has("docs/research.md")
    )
  );

  results.push(
    check(
      "[Test4-2] 一致しないfileは含まれない",
      !searchContentIndex(index, "sroi", 10).includes("readme.md")
    )
  );

  results.push(
    check(
      "[Test4-3] 空文字queryは空配列を返す",
      searchContentIndex(index, "", 10).length === 0
    )
  );

  results.push(
    check(
      "[Test4-4] limitで結果件数が打ち切られる",
      searchContentIndex(index, "sroi", 1).length === 1
    )
  );

  results.push(
    check(
      "[Test4-5] limit<=0は空配列を返す(安全側)",
      searchContentIndex(index, "sroi", 0).length === 0
    )
  );

  return summarize("contextSource/contentIndex", results);

}
