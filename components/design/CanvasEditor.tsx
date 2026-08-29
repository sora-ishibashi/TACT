"use client";

// =========================
// CanvasEditor (TACT Design: PowerPoint資料編集基盤)
// =========================
//
// 開発指示 Section6-B「直接編集」を実現する、書き込み可能なCanvas。
// 既存の読み取り専用DocumentRenderer.tsx(STEP47〜、AIPanelプロトタイプ
// が使い続ける)は変更せず、別コンポーネントとして新設する。
//
// 対応する直接編集操作(開発指示 Section10 Canvas/Object/Text):
//   - Canvas: テキスト・長方形・円・線・画像の追加(ツールバー)
//   - Object: 移動・リサイズ・削除・複製・前面/背面・整列・グループ化
//     (複製/前面背面/整列/グループ化はPropertiesPanel.tsx側のボタンから、
//     移動/リサイズ/削除/選択はこのCanvasEditor上で直接行う)
//   - Text: ダブルクリックでインライン編集(フォント/太字等の書式は
//     PropertiesPanel.tsxが担当)
//
// 責務分離: このコンポーネントはdocumentModelOps.tsの関数を呼ぶだけで、
// DocumentModelの変更ロジック自体は一切持たない(mockDesignAgent.tsの
// applyDocumentOperationと同じ「編集ロジックは1箇所」という既存方針)。
//
// LLM/API呼び出しは一切行わない。画像はユーザーがローカルから選択した
// ファイルをFileReaderで読み込むだけで、TACT Design自身が新しい画像を
// 生成・取得することはない(開発指示 Section7の絶対原則)。

import { useRef, useState } from "react";
import { DocumentElement, DocumentPage, ShapeVariant } from "./types";
import {
  addImageElement,
  addShapeElement,
  addTextElement,
  deleteElement,
  moveElementWithChildren,
  resizeElement,
  updateElementContent,
} from "./documentModelOps";
import { SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX } from "./canvasConstants";
import type { DocumentModel } from "./types";

const SELECTION_COLOR = "#2563eb";
const MIN_ELEMENT_SIZE = 8;

type DragState = {
  elementId: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

type ResizeState = {
  elementId: string;
  startX: number;
  startY: number;
  originWidth: number;
  originHeight: number;
};

function ElementContent({ element }: { element: DocumentElement }) {

  switch (element.type) {

    case "text":
      return (
        <p
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            fontSize: (element.style?.fontSize as number) ?? 16,
            fontWeight: (element.style?.fontWeight as string) ?? "normal",
            fontStyle: (element.style?.fontStyle as string) ?? "normal",
            color: (element.style?.color as string) ?? "#111827",
            textAlign: (element.style?.textAlign as "left" | "center" | "right") ?? "left",
          }}
        >
          {element.content}
        </p>
      );

    case "shape": {

      if (element.shapeVariant === "line") {
        return (
          <div
            style={{
              width: "100%",
              height: "100%",
              backgroundColor: (element.style?.backgroundColor as string) ?? "#9CA3AF",
            }}
          />
        );
      }

      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            backgroundColor: (element.style?.backgroundColor as string) ?? "#E5E7EB",
            borderRadius: element.shapeVariant === "circle" ? "50%" : 4,
          }}
        />
      );

    }

    case "image":
      return element.asset?.preview?.thumbnailUrl ? (
        <img
          src={element.asset.preview.thumbnailUrl}
          alt={element.asset.metadata?.title ?? ""}
          draggable={false}
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center border border-dashed border-gray-300 bg-gray-50 text-[10px] text-gray-400">
          (画像)
        </div>
      );

    case "list":
      return (
        <ul className="m-0 list-disc pl-5 text-sm text-gray-700">
          {(element.items ?? []).map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );

    case "table":
      return (
        <div className="flex h-full w-full items-center justify-center border border-gray-200 bg-gray-50 text-[11px] text-gray-500">
          表({element.tableData?.rows?.length ?? 0}行)
        </div>
      );

    case "group":
      return null;

    default:
      return (
        <div className="flex h-full w-full items-center justify-center text-[10px] text-gray-400">
          ({element.type})
        </div>
      );

  }

}

type Props = {
  documentModel: DocumentModel;
  onDocumentModelChange: (next: DocumentModel) => void;
  page: DocumentPage;
  selectedElementIds: string[];
  onSelectionChange: (ids: string[]) => void;
};

export default function CanvasEditor({
  documentModel,
  onDocumentModelChange,
  page,
  selectedElementIds,
  onSelectionChange,
}: Props) {

  const dragStateRef = useRef<DragState | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  function handleElementPointerDown(
    e: React.PointerEvent,
    element: DocumentElement
  ) {

    e.stopPropagation();

    if (editingTextId && editingTextId !== element.id) {
      commitTextEdit();
    }

    if (e.shiftKey) {

      onSelectionChange(
        selectedElementIds.includes(element.id)
          ? selectedElementIds.filter((id) => id !== element.id)
          : [...selectedElementIds, element.id]
      );

      return;

    }

    if (!selectedElementIds.includes(element.id)) {
      onSelectionChange([element.id]);
    }

    dragStateRef.current = {
      elementId: element.id,
      startX: e.clientX,
      startY: e.clientY,
      originX: element.position.x,
      originY: element.position.y,
    };

    (e.currentTarget as Element).setPointerCapture(e.pointerId);

  }

  function handleElementPointerMove(e: React.PointerEvent) {

    const drag = dragStateRef.current;

    if (!drag) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    onDocumentModelChange(
      moveElementWithChildren(documentModel, drag.elementId, {
        x: drag.originX + dx,
        y: drag.originY + dy,
      })
    );

  }

  function handleElementPointerUp(e: React.PointerEvent) {

    dragStateRef.current = null;

    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      // ブラウザによってはreleasePointerCaptureが失敗することがあるが、
      // 操作自体には影響しないため無視する(useDraggable.tsと同じ方針)。
    }

  }

  function handleResizePointerDown(
    e: React.PointerEvent,
    element: DocumentElement
  ) {

    e.stopPropagation();

    resizeStateRef.current = {
      elementId: element.id,
      startX: e.clientX,
      startY: e.clientY,
      originWidth: element.size.width,
      originHeight: element.size.height,
    };

    (e.currentTarget as Element).setPointerCapture(e.pointerId);

  }

  function handleResizePointerMove(e: React.PointerEvent) {

    const resize = resizeStateRef.current;

    if (!resize) return;

    const dx = e.clientX - resize.startX;
    const dy = e.clientY - resize.startY;

    onDocumentModelChange(
      resizeElement(documentModel, resize.elementId, {
        width: Math.max(MIN_ELEMENT_SIZE, resize.originWidth + dx),
        height: Math.max(MIN_ELEMENT_SIZE, resize.originHeight + dy),
      })
    );

  }

  function handleResizePointerUp(e: React.PointerEvent) {

    resizeStateRef.current = null;

    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      // 上記と同じ理由で無視する。
    }

  }

  function handleCanvasBackgroundPointerDown() {

    if (editingTextId) commitTextEdit();

    onSelectionChange([]);

  }

  function handleDoubleClick(element: DocumentElement) {

    if (element.type !== "text") return;

    setEditingTextId(element.id);
    setEditingText(element.content ?? "");

  }

  function commitTextEdit() {

    if (editingTextId) {

      onDocumentModelChange(
        updateElementContent(documentModel, editingTextId, editingText)
      );

    }

    setEditingTextId(null);

  }

  function handleKeyDown(e: React.KeyboardEvent) {

    if (editingTextId) return;

    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      selectedElementIds.length > 0
    ) {

      e.preventDefault();

      let next = documentModel;

      for (const id of selectedElementIds) {
        next = deleteElement(next, id);
      }

      onDocumentModelChange(next);
      onSelectionChange([]);

    }

  }

  function handleAddText() {
    onDocumentModelChange(addTextElement(documentModel, page.id));
  }

  function handleAddShape(variant: ShapeVariant) {
    onDocumentModelChange(addShapeElement(documentModel, page.id, variant));
  }

  function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {

    const file = e.target.files?.[0];

    if (!file) return;

    const reader = new FileReader();

    reader.onload = () => {

      if (typeof reader.result === "string") {
        onDocumentModelChange(
          addImageElement(documentModel, page.id, reader.result)
        );
      }

    };

    reader.readAsDataURL(file);

    // 同じファイルを連続で選択してもonChangeが発火するようにリセットする。
    e.target.value = "";

  }

  return (

    <div
      className="flex h-full flex-col outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >

      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-gray-200 bg-white px-3 py-2">

        <button
          type="button"
          onClick={handleAddText}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          + テキスト
        </button>

        <button
          type="button"
          onClick={() => handleAddShape("rectangle")}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          + 長方形
        </button>

        <button
          type="button"
          onClick={() => handleAddShape("circle")}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          + 円
        </button>

        <button
          type="button"
          onClick={() => handleAddShape("line")}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          + 線
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          + 画像
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleImageFileChange}
        />

      </div>

      {/* Canvas */}
      <div
        className="flex-1 overflow-auto bg-gray-100 p-10"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) handleCanvasBackgroundPointerDown();
        }}
      >

        <div
          style={{
            width: SLIDE_WIDTH_PX,
            height: SLIDE_HEIGHT_PX,
            position: "relative",
          }}
          className="mx-auto bg-white shadow-md"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) handleCanvasBackgroundPointerDown();
          }}
        >

          {page.elements.map((element) => {

            const isSelected = selectedElementIds.includes(element.id);
            const isEditing = editingTextId === element.id;

            return (

              <div
                key={element.id}
                data-element-id={element.id}
                onPointerDown={(e) => handleElementPointerDown(e, element)}
                onPointerMove={handleElementPointerMove}
                onPointerUp={handleElementPointerUp}
                onDoubleClick={() => handleDoubleClick(element)}
                style={{
                  position: "absolute",
                  left: element.position.x,
                  top: element.position.y,
                  width: element.size.width,
                  height: element.size.height,
                  cursor: "move",
                  outline: isSelected
                    ? `2px solid ${SELECTION_COLOR}`
                    : "1px dashed transparent",
                  outlineOffset: 2,
                  touchAction: "none",
                }}
                className="hover:outline-1 hover:outline-dashed hover:outline-gray-300"
              >

                {isEditing ? (

                  <textarea
                    autoFocus
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onBlur={commitTextEdit}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{
                      width: "100%",
                      height: "100%",
                      resize: "none",
                      fontSize: (element.style?.fontSize as number) ?? 16,
                    }}
                    className="border border-blue-400 p-0 outline-none"
                  />

                ) : (

                  <ElementContent element={element} />

                )}

                {isSelected && !isEditing && (

                  <div
                    onPointerDown={(e) => handleResizePointerDown(e, element)}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={handleResizePointerUp}
                    style={{
                      position: "absolute",
                      right: -6,
                      bottom: -6,
                      width: 12,
                      height: 12,
                      backgroundColor: SELECTION_COLOR,
                      borderRadius: "50%",
                      cursor: "nwse-resize",
                      touchAction: "none",
                    }}
                  />

                )}

              </div>

            );

          })}

        </div>

      </div>

    </div>

  );

}
