// =========================
// TACT Context Source — Entry Tree (LW-P1)
// =========================
//
// list()/scan()が返す「relativePathを持つ平坦な配列」から、UI表示用の
// 木構造を組み立てるpure function。DOM/Browser API/Node fsのいずれにも
// 依存しない(Local Workspaceに限らず、将来Drive/GitHub等の
// ContextSourceでも共通利用できる)。

import type { ContextSourceEntryMetadata, ContextSourceEntryType } from "./types";

export interface ContextSourceTreeNode {
  name: string;
  relativePath: string;
  type: ContextSourceEntryType;
  // fileの場合、元のmetadataをそのまま保持する。中間ディレクトリ
  // ノード(entries配列に直接含まれていなかったが、他entryのpathから
  // 存在が分かったdirectory)ではundefinedのままになりうる。
  entry?: ContextSourceEntryMetadata;
  children?: ContextSourceTreeNode[];
}

function splitRelativePath(relativePath: string): string[] {
  return relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

// entriesの順序に依存しない決定論的な出力にするため、常に名前順で
// ソートする(directory優先・同種内は名前昇順)。
function sortChildren(nodes: ContextSourceTreeNode[]): ContextSourceTreeNode[] {

  return [...nodes].sort((a, b) => {

    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }

    return a.name.localeCompare(b.name);

  });

}

export function buildContextSourceEntryTree(
  entries: ContextSourceEntryMetadata[]
): ContextSourceTreeNode[] {

  const nodesByPath = new Map<string, ContextSourceTreeNode>();
  const childrenByParentPath = new Map<string, ContextSourceTreeNode[]>();

  function ensureNode(
    relativePath: string,
    name: string,
    type: ContextSourceEntryType,
    entry?: ContextSourceEntryMetadata
  ): ContextSourceTreeNode {

    const existing = nodesByPath.get(relativePath);

    if (existing) {

      // 既にdirectoryの中間ノードとして作られていた場合でも、
      // 対応するentry(size/modifiedAt等)が後から見つかったら補完する。
      if (entry && !existing.entry) {
        existing.entry = entry;
      }

      return existing;

    }

    const node: ContextSourceTreeNode = { name, relativePath, type, entry };
    nodesByPath.set(relativePath, node);

    return node;

  }

  function attachToParent(node: ContextSourceTreeNode, segments: string[]): void {

    const parentSegments = segments.slice(0, -1);
    const parentPath = parentSegments.join("/");

    if (!childrenByParentPath.has(parentPath)) {
      childrenByParentPath.set(parentPath, []);
    }

    const siblings = childrenByParentPath.get(parentPath)!;

    if (!siblings.includes(node)) {
      siblings.push(node);
    }

  }

  for (const entry of entries) {

    const segments = splitRelativePath(entry.relativePath);

    if (segments.length === 0) {
      continue;
    }

    // 中間ディレクトリ(entriesに直接含まれていない可能性がある祖先)を
    // 補完する。例: "a/b/c.txt"だけが渡された場合でも"a"・"a/b"の
    // ノードを生成する。
    for (let depth = 1; depth < segments.length; depth++) {

      const ancestorSegments = segments.slice(0, depth);
      const ancestorPath = ancestorSegments.join("/");
      const ancestorNode = ensureNode(
        ancestorPath,
        ancestorSegments[ancestorSegments.length - 1],
        "directory"
      );

      attachToParent(ancestorNode, ancestorSegments);

    }

    const node = ensureNode(entry.relativePath, entry.name, entry.type, entry);
    attachToParent(node, segments);

  }

  function resolveChildren(node: ContextSourceTreeNode): void {

    const children = childrenByParentPath.get(node.relativePath);

    if (!children || children.length === 0) {
      return;
    }

    for (const child of children) {
      resolveChildren(child);
    }

    node.children = sortChildren(children);

  }

  const roots = childrenByParentPath.get("") ?? [];

  for (const root of roots) {
    resolveChildren(root);
  }

  return sortChildren(roots);

}
