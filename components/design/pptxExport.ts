// =========================
// pptxExport (TACT Design: PowerPoint資料編集基盤)
// =========================
//
// DocumentModel(TACT Design独自のInternal Representation)を、
// 実際に編集可能な.pptxファイルへ変換する。
//
// 既存の components/output/buildOutputPptx.ts(STEP41、TACTの
// currentOutputを直接pptx化する既存実装)と同じライブラリ
// (pptxgenjs、クライアント側でBlobを直接生成する既定パターン)を
// 踏襲するが、変換元がDocumentModel(絶対座標を持つ構造化データ)で
// あるため、buildOutputPptx.tsのような「本文を上から流し込む」変換
// ロジックとは別の実装になる(重複ではなく、入力形式が異なるための
// 別実装)。
//
// デザインの作り込みはしない(既存buildOutputPptx.tsと同じ方針):
// TACT Designが持つ座標・サイズ・スタイルをそのままpptxの図形へ
// 変換するだけで、新しい配色・レイアウトをAIが判断することはない。

import PptxGenJS from "pptxgenjs";
import { DocumentElement, DocumentModel } from "./types";
import { PX_PER_INCH, SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX, pxToInch } from "./canvasConstants";

// CSS px指定のfontSizeを、PowerPointが使うpt単位へ変換する
// (96dpi(CSS標準) → 72dpi(pt標準)の一般的な換算比率0.75を使う)。
const PX_TO_PT = 0.75;

function toHexColor(color: string | undefined, fallback: string): string {

  if (!color) return fallback;

  return color.startsWith("#") ? color.slice(1) : color;

}

function addElementToSlide(
  slide: PptxGenJS.Slide,
  element: DocumentElement
): void {

  const x = pxToInch(element.position.x);
  const y = pxToInch(element.position.y);
  const w = pxToInch(element.size.width);
  const h = pxToInch(element.size.height);

  const style = element.style ?? {};

  switch (element.type) {

    case "text": {

      slide.addText(element.content ?? "", {
        x, y, w, h,
        fontSize: ((style.fontSize as number) ?? 16) * PX_TO_PT,
        bold: style.fontWeight === "bold",
        italic: style.fontStyle === "italic",
        color: toHexColor(style.color as string, "111827"),
        align: (style.textAlign as "left" | "center" | "right") ?? "left",
        valign: "top",
      });

      break;

    }

    case "list": {

      const items = element.items ?? [];

      if (items.length === 0) break;

      slide.addText(
        items.map((item) => ({ text: item, options: { bullet: true, breakLine: true } })),
        {
          x, y, w, h,
          fontSize: ((style.fontSize as number) ?? 14) * PX_TO_PT,
          color: toHexColor(style.color as string, "374151"),
          valign: "top",
        }
      );

      break;

    }

    case "table": {

      const headers = element.tableData?.headers ?? [];
      const rows = element.tableData?.rows ?? [];

      if (headers.length === 0 && rows.length === 0) break;

      const tableRows: PptxGenJS.TableRow[] = [
        headers.map((header) => ({
          text: header,
          options: { bold: true, fill: { color: "F3F4F6" } },
        })),
        ...rows.map((row) => row.map((cell) => ({ text: cell }))),
      ];

      slide.addTable(tableRows, {
        x, y, w,
        fontSize: 11,
        border: { type: "solid", color: "D1D5DB", pt: 0.5 },
        autoPage: false,
      });

      break;

    }

    case "shape": {

      // "line"は、CanvasEditor.tsx上でも細い矩形として描画している
      // (pptxgenjsのShapeType.lineは対角線として描画され、Canvas上の
      // 見た目と一致しない)。EditorとExportの見た目を一致させるため、
      // 意図的に細いrectangleとして書き出す。
      const shapeType =
        element.shapeVariant === "circle"
          ? "ellipse"
          : "rect";

      slide.addShape(shapeType, {
        x, y, w, h,
        fill: { color: toHexColor(style.backgroundColor as string, "E5E7EB") },
        line: { color: toHexColor(style.backgroundColor as string, "E5E7EB") },
      });

      break;

    }

    case "image": {

      const dataUrl = element.asset?.preview?.thumbnailUrl;

      if (!dataUrl) break;

      slide.addImage({ data: dataUrl, x, y, w, h });

      break;

    }

    case "group":
    default:
      // groupはchildIdsが指す実体要素が別途page.elementsとして
      // 個別に出力されるため、group要素自体は何も描画しない
      // (documentModelOps.tsのgroupElements()コメント参照:
      // 子要素は削除されず個別のDocumentElementとして残る)。
      break;

  }

}

export async function exportDocumentModelToPptx(
  documentModel: DocumentModel
): Promise<Blob> {

  const pptx = new PptxGenJS();

  pptx.defineLayout({
    name: "TACT_DESIGN",
    width: SLIDE_WIDTH_PX / PX_PER_INCH,
    height: SLIDE_HEIGHT_PX / PX_PER_INCH,
  });

  pptx.layout = "TACT_DESIGN";

  for (const page of documentModel.pages) {

    const slide = pptx.addSlide();

    for (const element of page.elements) {
      addElementToSlide(slide, element);
    }

  }

  const blob = await pptx.write({ outputType: "blob" });

  return blob as Blob;

}

export function buildPptxFilename(documentModel: DocumentModel): string {

  const sanitized = documentModel.title
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 60);

  return `${sanitized || "tact-design"}.pptx`;

}
