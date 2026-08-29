"use client";

// =========================
// SlidePanel (TACT Design: PowerPoint資料編集基盤)
// =========================
//
// 開発指示 Section10 Slide要件(一覧・新規・削除・複製・並び替え・
// 選択)を担当する左ペイン。DocumentModelの変更ロジック自体は
// documentModelOps.tsに委譲し(重複実装しない)、このコンポーネントは
// 一覧表示とボタン配置だけを担う。
//
// 並び替えは隣接swap(上へ/下へボタン)のみを提供する。ドラッグ&ドロップ
// による自由な並び替えは今回のMVPでは扱わない(開発指示Section20
// 「不要な将来機能の過剰実装」の回避)。

import { addSlide, deleteSlide, duplicateSlide, moveSlide } from "./documentModelOps";
import type { DocumentModel } from "./types";

type Props = {
  documentModel: DocumentModel;
  onDocumentModelChange: (next: DocumentModel) => void;
  currentPageId: string | null;
  onSelectPage: (pageId: string) => void;
};

export default function SlidePanel({
  documentModel,
  onDocumentModelChange,
  currentPageId,
  onSelectPage,
}: Props) {

  function handleAddSlide() {

    const currentIndex = documentModel.pages.findIndex(
      (p) => p.id === currentPageId
    );

    const next = addSlide(
      documentModel,
      currentIndex === -1 ? undefined : currentIndex
    );

    onDocumentModelChange(next);

    // 新しく挿入されたSlideを選択する(currentIndex直後の位置)。
    const insertedAt = currentIndex === -1 ? next.pages.length - 1 : currentIndex + 1;
    const inserted = next.pages[insertedAt];

    if (inserted) onSelectPage(inserted.id);

  }

  function handleDeleteSlide(pageId: string) {

    if (documentModel.pages.length <= 1) return;

    const index = documentModel.pages.findIndex((p) => p.id === pageId);
    const next = deleteSlide(documentModel, pageId);

    onDocumentModelChange(next);

    if (currentPageId === pageId) {

      const fallback = next.pages[Math.min(index, next.pages.length - 1)];

      if (fallback) onSelectPage(fallback.id);

    }

  }

  function handleDuplicateSlide(pageId: string) {

    const next = duplicateSlide(documentModel, pageId);
    onDocumentModelChange(next);

    const sourceIndex = documentModel.pages.findIndex((p) => p.id === pageId);
    const duplicated = next.pages[sourceIndex + 1];

    if (duplicated) onSelectPage(duplicated.id);

  }

  function handleMoveSlide(pageId: string, direction: "up" | "down") {
    onDocumentModelChange(moveSlide(documentModel, pageId, direction));
  }

  return (

    <div className="flex h-full w-48 shrink-0 flex-col border-r border-gray-200 bg-gray-50">

      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <span className="text-xs font-semibold text-gray-500">Slides</span>
        <button
          type="button"
          onClick={handleAddSlide}
          title="新規スライド"
          className="rounded px-1.5 text-sm text-gray-600 hover:bg-gray-200"
        >
          +
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">

        {documentModel.pages.map((page, index) => {

          const isSelected = page.id === currentPageId;

          return (

            <div
              key={page.id}
              onClick={() => onSelectPage(page.id)}
              className={
                "cursor-pointer rounded-md border p-2 text-xs " +
                (isSelected
                  ? "border-blue-400 bg-white ring-1 ring-blue-200"
                  : "border-gray-200 bg-white hover:border-gray-300")
              }
            >

              <div className="flex items-center justify-between">

                <span className="font-medium text-gray-700">
                  {index + 1}
                </span>

                <span className="text-[10px] text-gray-400">
                  {page.elements.length}件
                </span>

              </div>

              <div className="mt-1.5 flex items-center gap-1">

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleMoveSlide(page.id, "up");
                  }}
                  disabled={index === 0}
                  title="上へ"
                  className="rounded border border-gray-200 px-1 text-[10px] text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                >
                  ↑
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleMoveSlide(page.id, "down");
                  }}
                  disabled={index === documentModel.pages.length - 1}
                  title="下へ"
                  className="rounded border border-gray-200 px-1 text-[10px] text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                >
                  ↓
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDuplicateSlide(page.id);
                  }}
                  title="複製"
                  className="rounded border border-gray-200 px-1 text-[10px] text-gray-500 hover:bg-gray-100"
                >
                  ⧉
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteSlide(page.id);
                  }}
                  disabled={documentModel.pages.length <= 1}
                  title="削除"
                  className="ml-auto rounded border border-gray-200 px-1 text-[10px] text-red-500 hover:bg-red-50 disabled:opacity-30"
                >
                  ✕
                </button>

              </div>

            </div>

          );

        })}

      </div>

    </div>

  );

}
