// =========================
// TACT Context Source — Entry Tree Regression (LW-P1)
// =========================
//
// 対象: core/tact-context-source/entryTree.ts(buildContextSourceEntryTree)。
// 平坦なContextSourceEntryMetadata[]から、UI表示用のtree構造を組み立てる
// pure functionの決定論的な出力を確認する(DOM/Browser API不使用)。

import "dotenv/config";
import { buildContextSourceEntryTree } from "../../../core/tact-context-source/entryTree";
import type { ContextSourceEntryMetadata } from "../../../core/tact-context-source/types";
import { check, summarize, type CheckResult } from "../lib/check";

function file(relativePath: string, name: string): ContextSourceEntryMetadata {
  return { name, relativePath, type: "file" };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const entries: ContextSourceEntryMetadata[] = [
    file("readme.md", "readme.md"),
    file("src/index.ts", "index.ts"),
    file("src/utils/helpers.ts", "helpers.ts"),
  ];

  const tree = buildContextSourceEntryTree(entries);

  results.push(
    check(
      "[Test1-1] root直下は名前順(directory優先)でreadme.mdとsrcの2件になる",
      tree.length === 2 && tree[0].name === "src" && tree[0].type === "directory" && tree[1].name === "readme.md"
    )
  );

  const srcNode = tree.find((node) => node.name === "src");

  results.push(
    check(
      "[Test1-2] 中間ディレクトリ(src/utils)がentriesに無くても補完される",
      srcNode?.children?.some((child) => child.name === "utils" && child.type === "directory") === true
    )
  );

  const utilsNode = srcNode?.children?.find((child) => child.name === "utils");

  results.push(
    check(
      "[Test1-3] nested fileはrelativePathを保持したまま子ノードとして配置される",
      utilsNode?.children?.[0]?.relativePath === "src/utils/helpers.ts" &&
        utilsNode?.children?.[0]?.entry?.relativePath === "src/utils/helpers.ts"
    )
  );

  const again = buildContextSourceEntryTree(entries);

  results.push(
    check(
      "[Test2-1] 同じ入力なら決定論的に同じ構造になる",
      JSON.stringify(tree) === JSON.stringify(again)
    )
  );

  results.push(
    check(
      "[Test3-1] 空配列を渡してもエラーにならず空配列を返す",
      buildContextSourceEntryTree([]).length === 0
    )
  );

  return summarize("contextSource/entryTree", results);

}
