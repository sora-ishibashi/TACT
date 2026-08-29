// =========================
// pptxImport (TACT Design: PowerPoint資料編集基盤、ベストエフォート)
// =========================
//
// .pptxファイルから、DocumentModelへの最小限の逆変換(Import)を
// 行う。既存core/fileAnalysis/extractFileContent.tsのextractPptx()
// (jszipでpptx内部のXMLをテキストだけ抜き出す、STEP実装済み)と
// 同じ「jszip + 正規表現によるXML抽出」という軽量な方式をそのまま
// 踏襲し、新しいXML parserライブラリは追加しない。
//
// 絶対条件として明示する制約(開発指示Section21「往復テスト」・
// 完了Reportの「未実装機能」で報告する前提):
// - 位置(a:off)・サイズ(a:ext)・テキスト(a:t)のみを復元する。
// - フォント・色・太字/斜体等の詳細スタイルは復元しない
//   (常に既定スタイルの新しいtext要素として扱う)。
// - 図形の種類(rect/ellipse/line等)は判別せず、テキストを持つ
//   図形はtype:"text"、持たない図形はtype:"shape"
//   (shapeVariant:"rectangle")として一律扱う。
// - 画像・表・スライドマスター・アニメーションは復元しない。
// - これはexportDocumentModelToPptx()が書き出した.pptxとの完全な
//   往復(pixel-perfect roundtrip)を保証するものではない
//   (PowerPoint本体で作成された任意の.pptxの構造の幅広さに対応する
//   ことが目的ではなく、TACT Design発の.pptxを再読み込みできる
//   ことを最優先の確認対象とする)。

import JSZip from "jszip";
import { DocumentElement, DocumentModel, DocumentPage } from "./types";
import { PX_PER_INCH } from "./canvasConstants";

const EMU_PER_INCH = 914400;

function emuToPx(emu: number): number {
  return (emu / EMU_PER_INCH) * PX_PER_INCH;
}

// core/fileAnalysis/extractFileContent.tsのdecodeXmlEntities()と同じ、
// 最小限のXMLエンティティデコード(新しいXML parserは導入しない)。
function decodeXmlEntities(text: string): string {

  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

}

interface ParsedShape {
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  text: string;
}

// <p:sp>...</p:sp>ブロック1つから、位置・サイズ・テキストだけを
// 正規表現で読み取る(完全なXML木構造は構築しない、最小限の抽出)。
function parseShapeBlock(block: string): ParsedShape {

  const offMatch = block.match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const extMatch = block.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);

  const texts = Array.from(block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map(
    (m) => decodeXmlEntities(m[1])
  );

  return {
    x: offMatch ? emuToPx(Number(offMatch[1])) : null,
    y: offMatch ? emuToPx(Number(offMatch[2])) : null,
    width: extMatch ? emuToPx(Number(extMatch[1])) : null,
    height: extMatch ? emuToPx(Number(extMatch[2])) : null,
    text: texts.join("\n"),
  };

}

function parseSlideXml(xml: string, pageId: string): DocumentPage {

  // <p:sp>ブロック(テキストボックス・図形)を非貪欲マッチで分割する。
  // ネストしたp:spは通常のスライドXMLには現れないため、単純な
  // 非貪欲正規表現で十分実用的に分割できる(extractPptx()と同じ
  // 「厳密なXML木構造より、実用的な最小限の抽出」という方針)。
  const shapeBlocks = Array.from(xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)).map(
    (m) => m[0]
  );

  const elements: DocumentElement[] = [];

  shapeBlocks.forEach((block, index) => {

    const parsed = parseShapeBlock(block);

    // 位置・サイズがどちらも読み取れなかった場合(プレースホルダー
    // 定義のみ等)は、意味のある復元ができないため対象外にする
    // (存在しない座標を推測で埋めない)。
    if (parsed.x === null || parsed.y === null || parsed.width === null || parsed.height === null) {
      return;
    }

    const base = {
      id: `${pageId}-imported-${index}`,
      position: { x: parsed.x, y: parsed.y },
      size: { width: parsed.width, height: parsed.height },
    };

    if (parsed.text.trim()) {

      elements.push({
        ...base,
        type: "text",
        content: parsed.text,
        style: { fontSize: 16, fontWeight: "normal" },
      });

    } else {

      elements.push({
        ...base,
        type: "shape",
        shapeVariant: "rectangle",
        style: { backgroundColor: "#E5E7EB" },
      });

    }

  });

  return { id: pageId, index: 0, elements };

}

export interface PptxImportResult {
  success: boolean;
  documentModel?: DocumentModel;
  error?: string;
  // 復元できなかった情報(画像・表・詳細スタイル等)がある場合、
  // ユーザーへ正直に伝えるための注記(推測で埋めない)。
  warnings: string[];
}

export async function importPptxToDocumentModel(
  data: ArrayBuffer | Uint8Array,
  title = "Imported Presentation"
): Promise<PptxImportResult> {

  try {

    const zip = await JSZip.loadAsync(data);

    const slideFiles = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {

        const numA = Number(a.match(/slide(\d+)\.xml/)?.[1] ?? "0");
        const numB = Number(b.match(/slide(\d+)\.xml/)?.[1] ?? "0");

        return numA - numB;

      });

    if (slideFiles.length === 0) {

      return {
        success: false,
        error: "有効なスライドが見つかりませんでした(ppt/slides/slideN.xmlが存在しない)。",
        warnings: [],
      };

    }

    const pages: DocumentPage[] = [];
    let hasImage = false;
    let hasTable = false;

    for (let i = 0; i < slideFiles.length; i++) {

      const xml = await zip.files[slideFiles[i]].async("text");

      if (/<p:pic>/.test(xml)) hasImage = true;
      if (/<a:tbl>/.test(xml)) hasTable = true;

      const page = parseSlideXml(xml, `page-${i}`);
      pages.push({ ...page, index: i });

    }

    const warnings: string[] = [
      "フォント・色・太字/斜体等の詳細スタイルは復元されません(既定スタイルの新規text要素として扱われます)。",
      "図形の種類(長方形/円/線)は区別されず、テキストの無い図形はすべて長方形として扱われます。",
    ];

    if (hasImage) {
      warnings.push("このファイルには画像が含まれていますが、今回のImportでは画像は復元されません。");
    }

    if (hasTable) {
      warnings.push("このファイルには表が含まれていますが、今回のImportでは表は復元されません。");
    }

    return {
      success: true,
      documentModel: {
        id: `imported-${Date.now()}`,
        title,
        pages,
      },
      warnings,
    };

  } catch (error) {

    return {
      success: false,
      error: `PowerPointファイルの読み込みに失敗しました: ${String(error)}`,
      warnings: [],
    };

  }

}
