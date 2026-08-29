// =========================
// projectFile (TACT Design: PowerPoint資料編集基盤)
// =========================
//
// Project(開発指示Section10「新規資料作成・資料を開く・保存・
// 名前変更」)の永続化方式。
//
// 絶対条件(開発指示Section20「不要なDB再設計は行わない」)により、
// 今回は新しいDBテーブル・APIを作らず、ブラウザのファイル
// ダウンロード/アップロードによる「.tactdesign.json」ファイルとして
// 保存・再読み込みする(TACT Design独自のDocumentModelをそのまま
// JSONとして書き出すだけ)。
//
// 将来、実際のDB永続化(core/tact-project/等の既存Projectの仕組みを
// 拡張する形)に置き換える場合も、DocumentModel自体の構造は変えずに
// 保存先だけを差し替えられる(このファイルの責務を丸ごと置き換える
// だけでよい設計)。

import type { DocumentModel } from "./types";

const FILE_EXTENSION = ".tactdesign.json";

export function buildProjectFilename(documentModel: DocumentModel): string {

  const sanitized = documentModel.title
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 60);

  return `${sanitized || "tact-design"}${FILE_EXTENSION}`;

}

export function serializeDocumentModel(documentModel: DocumentModel): string {

  return JSON.stringify(documentModel, null, 2);

}

export interface ParseProjectFileResult {
  success: boolean;
  documentModel?: DocumentModel;
  error?: string;
}

// 最小限の構造チェックのみ行う(型ガードとしては緩いが、既存
// mockDesignAgent.ts等と同じく、不正な形式は安全にエラー扱いにし、
// クラッシュしないことを優先する)。
export function parseDocumentModel(json: string): ParseProjectFileResult {

  try {

    const parsed = JSON.parse(json);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.id !== "string" ||
      typeof parsed.title !== "string" ||
      !Array.isArray(parsed.pages)
    ) {

      return {
        success: false,
        error: "TACT Designのプロジェクトファイルとして認識できませんでした。",
      };

    }

    return { success: true, documentModel: parsed as DocumentModel };

  } catch (error) {

    return {
      success: false,
      error: `ファイルの読み込みに失敗しました: ${String(error)}`,
    };

  }

}
