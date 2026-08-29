"use client";

// =========================
// PropertiesPanel (TACT Design: PowerPoint資料編集基盤)
// =========================
//
// 開発指示 Section10 Object/Text要件を担当する下部/右ペイン。
// 選択中のObjectに対して、
//   Object: 移動(数値入力)・リサイズ(数値入力)・削除・複製・
//           前面へ・背面へ・整列・グループ化/解除
//   Text:   フォントサイズ・太字・斜体・色・左右中央揃え
// を提供する。DocumentModelの変更ロジックはdocumentModelOps.tsに
// 委譲する(重複実装しない)。
//
// 単一選択時はObject+Text両方のコントロールを表示し、複数選択時は
// グループ化ボタンのみを表示する(複数要素へのスタイル一括適用は
// 今回のMVPでは扱わない)。

import {
  alignElementToSlide,
  bringToFront,
  deleteElement,
  duplicateElement,
  groupElements,
  resizeElement,
  moveElement,
  sendToBack,
  ungroupElement,
  updateElementStyle,
  type AlignDirection,
} from "./documentModelOps";
import { SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX } from "./canvasConstants";
import type { DocumentModel, DocumentPage } from "./types";

type Props = {
  documentModel: DocumentModel;
  onDocumentModelChange: (next: DocumentModel) => void;
  page: DocumentPage;
  selectedElementIds: string[];
  onSelectionChange: (ids: string[]) => void;
};

const ALIGN_BUTTONS: { direction: AlignDirection; label: string }[] = [
  { direction: "left", label: "左揃え" },
  { direction: "centerX", label: "左右中央" },
  { direction: "right", label: "右揃え" },
  { direction: "top", label: "上揃え" },
  { direction: "centerY", label: "上下中央" },
  { direction: "bottom", label: "下揃え" },
];

const FONT_FAMILIES = ["", "Arial", "Georgia", "Meiryo", "Yu Gothic"];

export default function PropertiesPanel({
  documentModel,
  onDocumentModelChange,
  page,
  selectedElementIds,
  onSelectionChange,
}: Props) {

  if (selectedElementIds.length === 0) {

    return (
      <div className="w-64 shrink-0 border-l border-gray-200 bg-gray-50 p-4 text-xs text-gray-400">
        要素を選択してください。
      </div>
    );

  }

  if (selectedElementIds.length > 1) {

    return (

      <div className="w-64 shrink-0 space-y-3 border-l border-gray-200 bg-gray-50 p-4">

        <p className="text-xs font-semibold text-gray-500">
          {selectedElementIds.length}個選択中
        </p>

        <button
          type="button"
          onClick={() => {

            const next = groupElements(documentModel, page.id, selectedElementIds);
            onDocumentModelChange(next);

            const newGroup = next.pages
              .find((p) => p.id === page.id)
              ?.elements.find((el) => el.type === "group" && el.childIds?.every((id) => selectedElementIds.includes(id)));

            onSelectionChange(newGroup ? [newGroup.id] : []);

          }}
          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100"
        >
          グループ化
        </button>

        <button
          type="button"
          onClick={() => {

            let next = documentModel;

            for (const id of selectedElementIds) {
              next = deleteElement(next, id);
            }

            onDocumentModelChange(next);
            onSelectionChange([]);

          }}
          className="w-full rounded-md border border-red-200 bg-white px-2 py-1.5 text-xs text-red-600 hover:bg-red-50"
        >
          削除
        </button>

      </div>

    );

  }

  const elementId = selectedElementIds[0];
  const element = page.elements.find((el) => el.id === elementId);

  if (!element) {

    return (
      <div className="w-64 shrink-0 border-l border-gray-200 bg-gray-50 p-4 text-xs text-gray-400">
        選択中の要素が見つかりません。
      </div>
    );

  }

  function updateStyle(changes: Record<string, unknown>) {
    onDocumentModelChange(updateElementStyle(documentModel, elementId, changes));
  }

  function updatePosition(axis: "x" | "y", value: number) {

    if (!element) return;

    onDocumentModelChange(
      moveElement(documentModel, elementId, {
        ...element.position,
        [axis]: value,
      })
    );

  }

  function updateSize(axis: "width" | "height", value: number) {

    if (!element) return;

    onDocumentModelChange(
      resizeElement(documentModel, elementId, {
        ...element.size,
        [axis]: value,
      })
    );

  }

  const style = element.style ?? {};
  const isText = element.type === "text";
  const isGroup = element.type === "group";

  return (

    <div className="w-64 shrink-0 space-y-4 overflow-y-auto border-l border-gray-200 bg-gray-50 p-4">

      <div>
        <p className="mb-1.5 text-xs font-semibold text-gray-500">Position / Size</p>
        <div className="grid grid-cols-2 gap-1.5">

          <label className="text-[10px] text-gray-500">
            X
            <input
              type="number"
              value={Math.round(element.position.x)}
              onChange={(e) => updatePosition("x", Number(e.target.value))}
              className="mt-0.5 w-full rounded border border-gray-300 px-1.5 py-1 text-xs"
            />
          </label>

          <label className="text-[10px] text-gray-500">
            Y
            <input
              type="number"
              value={Math.round(element.position.y)}
              onChange={(e) => updatePosition("y", Number(e.target.value))}
              className="mt-0.5 w-full rounded border border-gray-300 px-1.5 py-1 text-xs"
            />
          </label>

          <label className="text-[10px] text-gray-500">
            幅
            <input
              type="number"
              value={Math.round(element.size.width)}
              onChange={(e) => updateSize("width", Number(e.target.value))}
              className="mt-0.5 w-full rounded border border-gray-300 px-1.5 py-1 text-xs"
            />
          </label>

          <label className="text-[10px] text-gray-500">
            高さ
            <input
              type="number"
              value={Math.round(element.size.height)}
              onChange={(e) => updateSize("height", Number(e.target.value))}
              className="mt-0.5 w-full rounded border border-gray-300 px-1.5 py-1 text-xs"
            />
          </label>

        </div>
      </div>

      {isText && (

        <div>
          <p className="mb-1.5 text-xs font-semibold text-gray-500">Text</p>

          <select
            value={(style.fontFamily as string) ?? ""}
            onChange={(e) => updateStyle({ fontFamily: e.target.value || undefined })}
            className="mb-1.5 w-full rounded border border-gray-300 px-1.5 py-1 text-xs"
          >
            {FONT_FAMILIES.map((f) => (
              <option key={f} value={f}>{f || "(既定フォント)"}</option>
            ))}
          </select>

          <div className="mb-1.5 flex items-center gap-1.5">

            <input
              type="number"
              value={(style.fontSize as number) ?? 16}
              onChange={(e) => updateStyle({ fontSize: Number(e.target.value) })}
              className="w-16 rounded border border-gray-300 px-1.5 py-1 text-xs"
            />

            <button
              type="button"
              onClick={() =>
                updateStyle({ fontWeight: style.fontWeight === "bold" ? "normal" : "bold" })
              }
              className={
                "rounded border px-2 py-1 text-xs font-bold " +
                (style.fontWeight === "bold"
                  ? "border-blue-400 bg-blue-50 text-blue-700"
                  : "border-gray-300 text-gray-700")
              }
            >
              B
            </button>

            <button
              type="button"
              onClick={() =>
                updateStyle({ fontStyle: style.fontStyle === "italic" ? "normal" : "italic" })
              }
              className={
                "rounded border px-2 py-1 text-xs italic " +
                (style.fontStyle === "italic"
                  ? "border-blue-400 bg-blue-50 text-blue-700"
                  : "border-gray-300 text-gray-700")
              }
            >
              I
            </button>

            <input
              type="color"
              value={(style.color as string) ?? "#111827"}
              onChange={(e) => updateStyle({ color: e.target.value })}
              className="h-7 w-7 rounded border border-gray-300 p-0"
            />

          </div>

          <div className="flex gap-1">

            {(["left", "center", "right"] as const).map((align) => (

              <button
                key={align}
                type="button"
                onClick={() => updateStyle({ textAlign: align })}
                className={
                  "flex-1 rounded border px-2 py-1 text-xs " +
                  (style.textAlign === align
                    ? "border-blue-400 bg-blue-50 text-blue-700"
                    : "border-gray-300 text-gray-700")
                }
              >
                {align === "left" ? "左" : align === "center" ? "中央" : "右"}
              </button>

            ))}

          </div>

        </div>

      )}

      <div>
        <p className="mb-1.5 text-xs font-semibold text-gray-500">整列(スライド基準)</p>
        <div className="grid grid-cols-3 gap-1">

          {ALIGN_BUTTONS.map(({ direction, label }) => (

            <button
              key={direction}
              type="button"
              title={label}
              onClick={() =>
                onDocumentModelChange(
                  alignElementToSlide(
                    documentModel,
                    elementId,
                    direction,
                    SLIDE_WIDTH_PX,
                    SLIDE_HEIGHT_PX
                  )
                )
              }
              className="rounded border border-gray-300 bg-white px-1 py-1 text-[10px] text-gray-600 hover:bg-gray-100"
            >
              {label}
            </button>

          ))}

        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold text-gray-500">Object</p>
        <div className="grid grid-cols-2 gap-1.5">

          <button
            type="button"
            onClick={() => onDocumentModelChange(bringToFront(documentModel, elementId))}
            className="rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100"
          >
            前面へ
          </button>

          <button
            type="button"
            onClick={() => onDocumentModelChange(sendToBack(documentModel, elementId))}
            className="rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100"
          >
            背面へ
          </button>

          <button
            type="button"
            onClick={() => onDocumentModelChange(duplicateElement(documentModel, elementId))}
            className="rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100"
          >
            複製
          </button>

          {isGroup ? (

            <button
              type="button"
              onClick={() => {
                onDocumentModelChange(ungroupElement(documentModel, elementId));
                onSelectionChange([]);
              }}
              className="rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100"
            >
              グループ解除
            </button>

          ) : (

            <button
              type="button"
              onClick={() => {
                onDocumentModelChange(deleteElement(documentModel, elementId));
                onSelectionChange([]);
              }}
              className="rounded border border-red-200 bg-white px-2 py-1.5 text-xs text-red-600 hover:bg-red-50"
            >
              削除
            </button>

          )}

        </div>

        {isGroup && (

          <button
            type="button"
            onClick={() => {
              onDocumentModelChange(deleteElement(documentModel, elementId));
              onSelectionChange([]);
            }}
            className="mt-1.5 w-full rounded border border-red-200 bg-white px-2 py-1.5 text-xs text-red-600 hover:bg-red-50"
          >
            グループごと削除
          </button>

        )}

      </div>

    </div>

  );

}
