// =========================
// TACT Design — pptx往復テスト(Export → 独立検証 → Import)
// =========================
//
// 対象: components/design/pptxExport.ts、
// components/design/pptxImport.ts(いずれも新規)。
//
// 環境制約: LLM/API呼び出しは一切行わない。実際にpptxgenjs/jszipで
// バイナリの.pptxを生成・解析する(モックではない、決定論的な
// Reality Test寄りの検証)。ネットワークやファイルシステムへの書き込み
// は行わない(生成物はメモリ上のBlob/ArrayBufferのみ)。

import JSZip from "jszip";
import { exportDocumentModelToPptx } from "../../../components/design/pptxExport";
import { importPptxToDocumentModel } from "../../../components/design/pptxImport";
import type { DocumentModel } from "../../../components/design/types";
import { check, summarize, type CheckResult } from "../lib/check";

function sampleDocument(): DocumentModel {

  return {
    id: "doc-roundtrip",
    title: "Roundtrip Test",
    pages: [
      {
        id: "page-0",
        index: 0,
        elements: [
          {
            id: "page-0-text-0",
            type: "text",
            position: { x: 40, y: 40 },
            size: { width: 400, height: 60 },
            content: "TACT Design Roundtrip Test",
            style: { fontSize: 24, fontWeight: "bold", color: "#111827" },
          },
          {
            id: "page-0-shape-0",
            type: "shape",
            shapeVariant: "rectangle",
            position: { x: 40, y: 120 },
            size: { width: 160, height: 100 },
            style: { backgroundColor: "#E5E7EB" },
          },
        ],
      },
      {
        id: "page-1",
        index: 1,
        elements: [
          {
            id: "page-1-shape-0",
            type: "shape",
            shapeVariant: "circle",
            position: { x: 60, y: 60 },
            size: { width: 120, height: 120 },
            style: { backgroundColor: "#DBEAFE" },
          },
        ],
      },
    ],
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const document = sampleDocument();

  let blob: Blob | undefined;
  let exportError: unknown;

  try {
    blob = await exportDocumentModelToPptx(document);
  } catch (error) {
    exportError = error;
  }

  results.push(
    check(
      "[Export-1] exportDocumentModelToPptx()が例外を投げずにBlobを生成する",
      !!blob && exportError === undefined,
      exportError ? String(exportError) : undefined
    )
  );

  if (!blob) {
    return summarize("design-pptxRoundtrip (TACT Design)", results);
  }

  results.push(
    check(
      "[Export-2] 生成物が空でない(実際にバイト列が書き出されている)",
      blob.size > 1000,
      `size=${blob.size}`
    )
  );

  const arrayBuffer = await blob.arrayBuffer();

  // =========================
  // 独立検証: Claude Codeのstdoutを信用しないのと同じ考え方で、
  // pptxExport.tsの戻り値を、別の経路(jszipで直接zip構造を読む)から
  // 独立に検証する。
  // =========================

  let zip: JSZip | undefined;
  let zipError: unknown;

  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch (error) {
    zipError = error;
  }

  results.push(
    check(
      "[Verify-1] 生成物は有効なzipアーカイブとして開ける(.pptxの実体はzip)",
      !!zip && zipError === undefined,
      zipError ? String(zipError) : undefined
    )
  );

  if (zip) {

    results.push(
      check(
        "[Verify-2] pptxとして最低限必要な[Content_Types].xmlが存在する",
        Object.keys(zip.files).includes("[Content_Types].xml")
      )
    );

    const slideFiles = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name)
    );

    results.push(
      check(
        "[Verify-3] DocumentModelのPage数(2枚)と同じ数のslideNNN.xmlが生成される",
        slideFiles.length === 2,
        `slideFiles=${JSON.stringify(slideFiles)}`
      )
    );

    const slide1Xml = await zip.files["ppt/slides/slide1.xml"]?.async("text");

    results.push(
      check(
        "[Verify-4] slide1.xmlに、実際に設定したテキスト内容がそのまま含まれる" +
          "(pptxgenjs経由でも文字化け・欠落なく書き出されている)",
        !!slide1Xml && slide1Xml.includes("TACT Design Roundtrip Test")
      )
    );

  }

  // =========================
  // Import側: Export済みのpptxを、pptxImport.tsで読み戻す。
  // =========================

  const importResult = await importPptxToDocumentModel(arrayBuffer, "Reimported");

  results.push(
    check(
      "[Import-1] Export済み.pptxをimportPptxToDocumentModel()が正常に読み込める",
      importResult.success === true,
      importResult.error
    )
  );

  if (importResult.success && importResult.documentModel) {

    results.push(
      check(
        "[Import-2] 復元されたDocumentModelのPage数がExport元と一致する(2枚)",
        importResult.documentModel.pages.length === 2
      )
    );

    const firstPageElements = importResult.documentModel.pages[0]?.elements ?? [];

    results.push(
      check(
        "[Import-3] 1ページ目に、テキストを含む要素が少なくとも1つ復元される",
        firstPageElements.some(
          (el) => el.type === "text" && el.content?.includes("TACT Design Roundtrip Test")
        ),
        `elements=${JSON.stringify(firstPageElements)}`
      )
    );

    const textElement = firstPageElements.find(
      (el) => el.type === "text" && el.content?.includes("TACT Design Roundtrip Test")
    );

    // EMU⇔px変換・pptxgenjsの内部丸めがあるため、厳密な一致ではなく
    // 妥当な誤差範囲(数px)であることだけを確認する(推測ではなく、
    // 単位変換の往復誤差として許容範囲を明示する)。
    const TOLERANCE_PX = 5;

    results.push(
      check(
        "[Import-4] 復元された位置(x, y)が、Export元の値と数px以内の誤差で一致する" +
          "(EMU⇔px変換の丸め誤差のみ許容し、大きくズレていないことを確認する)",
        !!textElement &&
          Math.abs(textElement.position.x - 40) <= TOLERANCE_PX &&
          Math.abs(textElement.position.y - 40) <= TOLERANCE_PX,
        textElement ? `position=${JSON.stringify(textElement.position)}` : "not found"
      )
    );

    results.push(
      check(
        "[Import-5] 復元できなかった情報(スタイル・図形種別等)についてwarningsが" +
          "空でない(=復元できないことを正直に伝える、推測で埋めない)",
        importResult.warnings.length > 0
      )
    );

  }

  // 不正なデータに対しては、クラッシュせず失敗として扱う。
  const invalidResult = await importPptxToDocumentModel(
    new TextEncoder().encode("not a real pptx file").buffer as ArrayBuffer
  );

  results.push(
    check(
      "[Import-6] 不正なデータ(zipですらない)を渡した場合、例外を投げずsuccess:falseを返す",
      invalidResult.success === false && typeof invalidResult.error === "string"
    )
  );

  return summarize("design-pptxRoundtrip (TACT Design)", results);

}
