// =========================
// itemTitleSplit (STEP56, STEP59で共有ファイルへ抽出)
// =========================
//
// keyFindings/recommendations/nextActionsのlist item文字列
// (currentOutputToDocumentModel.tsが既に「タイトル：説明」という
// 1つの文字列に結合している。renderKeyFinding/renderTextItemPlain
// 参照)を、「：」(全角/半角)だけを根拠に安全に分割するロジック。
//
// STEP56でDocumentRenderer.tsx(表示)に実装されたが、STEP59で
// currentOutputToDocumentModel.ts(レイアウトのheight見積もり)からも
// 同じ判定が必要になったため、二重実装を避けてこのファイルへ
// 共有した。表示にもレイアウト計算にも依存しない、純粋な文字列
// 判定だけを置く(DocumentRenderer.tsx→currentOutputToDocumentModel.ts
// のような依存方向を作らないための、意図的な第三のファイル)。
//
// 安全側の設計(STEP56から変更なし):
// - タイトル候補が40文字を超える場合は分割しない(長い文の途中に
//   偶然「：」がある場合の誤爆を避ける)。
// - タイトル/説明のどちらかが空になる場合は分割しない。
// - 対象はkeyFindings/recommendations/nextActions roleのlistのみ
//   (section本文の箇条書き等、意味が異なる可能性がある一般的な
//   リストには適用しない)。

import { DocumentElementRole } from "./types";

export const ITEM_TITLE_SPLIT_PATTERN = /^([^：:]{1,40})[：:]\s*(.+)$/;

export const ITEM_TITLE_SPLIT_ROLES = new Set<DocumentElementRole>([
  "keyFindings",
  "recommendations",
  "nextActions",
]);

export function canSplitItemTitle(
  role: DocumentElementRole | undefined
): boolean {

  return role !== undefined && ITEM_TITLE_SPLIT_ROLES.has(role);

}

export function splitItemTitle(
  item: string
): { title: string; rest: string } | null {

  const match = item.match(ITEM_TITLE_SPLIT_PATTERN);

  if (!match) return null;

  const title = match[1].trim();
  const rest = match[2].trim();

  if (!title || !rest) return null;

  return { title, rest };

}
