// =========================
// TACT Design — documentModelOps(PowerPoint資料編集基盤)
// =========================
//
// 対象: components/design/documentModelOps.ts(新規)。
//
// 環境制約: LLM/API呼び出し・DOM操作は一切行わない。純粋関数のみを
// 決定論的に検証する。

import {
  addImageElement,
  addShapeElement,
  addSlide,
  addTextElement,
  alignElementToSlide,
  bringToFront,
  deleteElement,
  deleteSlide,
  duplicateElement,
  duplicateSlide,
  groupElements,
  moveElement,
  moveElementWithChildren,
  moveSlide,
  resizeElement,
  sendToBack,
  ungroupElement,
  updateElementContent,
  updateElementStyle,
} from "../../../components/design/documentModelOps";
import type { DocumentModel } from "../../../components/design/types";
import { check, summarize, type CheckResult } from "../lib/check";

function emptyDocument(): DocumentModel {
  return { id: "doc-1", title: "Test", pages: [] };
}

function oneSlideDocument(): DocumentModel {
  return addSlide(emptyDocument());
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---------- Slide操作 ----------

  {

    const doc = addSlide(emptyDocument());

    results.push(
      check("[Slide-1] addSlide()は空文書に1枚追加できる", doc.pages.length === 1)
    );

    const doc2 = addSlide(doc, 0);

    results.push(
      check(
        "[Slide-2] addSlide(afterIndex)は指定位置の直後に挿入する",
        doc2.pages.length === 2 && doc2.pages[0].id === doc.pages[0].id
      )
    );

    const doc3 = deleteSlide(doc2, doc2.pages[0].id);

    results.push(
      check("[Slide-3] deleteSlideは対象Pageを削除する", doc3.pages.length === 1)
    );

    // duplicateSlideは複製元と同じ内容の新規Pageを直後に挿入する。
    const base = oneSlideDocument();
    const dup = duplicateSlide(
      addTextElement(base, base.pages[0].id, "hello"),
      base.pages[0].id
    );

    results.push(
      check(
        "[Slide-4] duplicateSlideは複製元の直後に、同じ要素数のPageを追加する",
        dup.pages.length === 2 &&
          dup.pages[1].elements.length === dup.pages[0].elements.length
      )
    );

    const twoSlides = addSlide(oneSlideDocument());
    const [firstId, secondId] = twoSlides.pages.map((p) => p.id);
    const moved = moveSlide(twoSlides, secondId, "up");

    results.push(
      check(
        "[Slide-5] moveSlideは隣接swapで並び順を入れ替える",
        moved.pages[0].id === secondId && moved.pages[1].id === firstId
      )
    );

    const movedBeyond = moveSlide(twoSlides, firstId, "up");

    results.push(
      check(
        "[Slide-6] moveSlideは範囲外への移動を無視する(何も変更しない)",
        movedBeyond.pages[0].id === firstId
      )
    );

  }

  // ---------- Object追加 ----------

  {

    const doc = oneSlideDocument();
    const pageId = doc.pages[0].id;

    const withText = addTextElement(doc, pageId, "hello");

    results.push(
      check(
        "[Add-1] addTextElementはtype:'text'の要素を追加する",
        withText.pages[0].elements.length === 1 &&
          withText.pages[0].elements[0].type === "text" &&
          withText.pages[0].elements[0].content === "hello"
      )
    );

    const withRect = addShapeElement(doc, pageId, "rectangle");
    const withCircle = addShapeElement(doc, pageId, "circle");
    const withLine = addShapeElement(doc, pageId, "line");

    results.push(
      check(
        "[Add-2] addShapeElementはshapeVariantを正しく設定する",
        withRect.pages[0].elements[0].shapeVariant === "rectangle" &&
          withCircle.pages[0].elements[0].shapeVariant === "circle" &&
          withLine.pages[0].elements[0].shapeVariant === "line"
      )
    );

    const withImage = addImageElement(doc, pageId, "data:image/png;base64,AAAA");

    results.push(
      check(
        "[Add-3] addImageElementはtype:'image'、asset.source:'uploaded'の要素を追加する" +
          "(TACT Designが画像を生成・取得したのではなく、ユーザーが選択したファイルの参照であることを示す)",
        withImage.pages[0].elements[0].type === "image" &&
          withImage.pages[0].elements[0].asset?.source === "uploaded"
      )
    );

  }

  // ---------- Object編集 ----------

  {

    const doc0 = oneSlideDocument();
    const pageId = doc0.pages[0].id;
    const doc1 = addTextElement(doc0, pageId, "hello");
    const elementId = doc1.pages[0].elements[0].id;

    const moved = moveElement(doc1, elementId, { x: 100, y: 200 });

    results.push(
      check(
        "[Edit-1] moveElementは指定した要素のpositionだけを変更する",
        moved.pages[0].elements[0].position.x === 100 &&
          moved.pages[0].elements[0].position.y === 200
      )
    );

    const resized = resizeElement(doc1, elementId, { width: 50, height: 400 });

    results.push(
      check(
        "[Edit-2] resizeElementは指定した要素のsizeだけを変更する",
        resized.pages[0].elements[0].size.width === 50 &&
          resized.pages[0].elements[0].size.height === 400
      )
    );

    const resizedTooSmall = resizeElement(doc1, elementId, { width: -5, height: 0 });

    results.push(
      check(
        "[Edit-3] resizeElementは最小サイズ未満に縮小できない(負のサイズを作らない)",
        resizedTooSmall.pages[0].elements[0].size.width > 0 &&
          resizedTooSmall.pages[0].elements[0].size.height > 0
      )
    );

    const contentChanged = updateElementContent(doc1, elementId, "changed");

    results.push(
      check(
        "[Edit-4] updateElementContentはcontentだけを書き換える",
        contentChanged.pages[0].elements[0].content === "changed"
      )
    );

    const styled = updateElementStyle(doc1, elementId, { fontWeight: "bold" });

    results.push(
      check(
        "[Edit-5] updateElementStyleは既存styleを保ったまま指定分だけmergeする",
        styled.pages[0].elements[0].style?.fontWeight === "bold" &&
          styled.pages[0].elements[0].style?.fontSize === 16
      )
    );

    const deleted = deleteElement(doc1, elementId);

    results.push(
      check("[Edit-6] deleteElementは対象要素を削除する", deleted.pages[0].elements.length === 0)
    );

    const duplicated = duplicateElement(doc1, elementId);

    results.push(
      check(
        "[Edit-7] duplicateElementは複製要素を追加し、元の要素は変更しない" +
          "(座標も少しずらす)",
        duplicated.pages[0].elements.length === 2 &&
          duplicated.pages[0].elements[1].position.x ===
            doc1.pages[0].elements[0].position.x + 16
      )
    );

  }

  // ---------- z-order / align ----------

  {

    const doc0 = oneSlideDocument();
    const pageId = doc0.pages[0].id;
    const doc1 = addShapeElement(
      addShapeElement(doc0, pageId, "rectangle"),
      pageId,
      "circle"
    );

    const [firstId, secondId] = doc1.pages[0].elements.map((el) => el.id);

    const broughtFront = bringToFront(doc1, firstId);

    results.push(
      check(
        "[ZOrder-1] bringToFrontは配列内で対象を末尾(=最前面)へ移動する",
        broughtFront.pages[0].elements[broughtFront.pages[0].elements.length - 1].id === firstId
      )
    );

    const sentBack = sendToBack(doc1, secondId);

    results.push(
      check(
        "[ZOrder-2] sendToBackは配列内で対象を先頭(=最背面)へ移動する",
        sentBack.pages[0].elements[0].id === secondId
      )
    );

    const aligned = alignElementToSlide(doc1, firstId, "centerX", 960, 540);
    const element = aligned.pages[0].elements.find((el) => el.id === firstId)!;

    results.push(
      check(
        "[Align-1] alignElementToSlide('centerX')はスライド幅を基準に中央寄せする",
        element.position.x === (960 - element.size.width) / 2
      )
    );

  }

  // ---------- グループ化 ----------

  {

    const doc0 = oneSlideDocument();
    const pageId = doc0.pages[0].id;
    const doc1 = addShapeElement(
      addShapeElement(doc0, pageId, "rectangle"),
      pageId,
      "circle"
    );

    const [firstId, secondId] = doc1.pages[0].elements.map((el) => el.id);

    const grouped = groupElements(doc1, pageId, [firstId, secondId]);
    const groupElement = grouped.pages[0].elements.find((el) => el.type === "group");

    results.push(
      check(
        "[Group-1] groupElementsはtype:'group'の要素を追加し、子要素は削除しない" +
          "(データ損失を起こさない)",
        !!groupElement &&
          groupElement.childIds?.length === 2 &&
          grouped.pages[0].elements.some((el) => el.id === firstId) &&
          grouped.pages[0].elements.some((el) => el.id === secondId)
      )
    );

    const moved = moveElementWithChildren(grouped, groupElement!.id, {
      x: groupElement!.position.x + 30,
      y: groupElement!.position.y + 40,
    });

    const movedFirst = moved.pages[0].elements.find((el) => el.id === firstId)!;
    const originalFirst = doc1.pages[0].elements.find((el) => el.id === firstId)!;

    results.push(
      check(
        "[Group-2] moveElementWithChildrenはgroupを動かすと子要素も同じ差分だけ動く",
        movedFirst.position.x === originalFirst.position.x + 30 &&
          movedFirst.position.y === originalFirst.position.y + 40
      )
    );

    const ungrouped = ungroupElement(moved, groupElement!.id);

    results.push(
      check(
        "[Group-3] ungroupElementはgroup要素だけを取り除き、子要素はそのまま残す",
        !ungrouped.pages[0].elements.some((el) => el.type === "group") &&
          ungrouped.pages[0].elements.some((el) => el.id === firstId) &&
          ungrouped.pages[0].elements.some((el) => el.id === secondId)
      )
    );

  }

  // ---------- 存在しない対象への操作(安全性) ----------

  {

    const doc = oneSlideDocument();

    // mapElement()(内部ヘルパー)はmockDesignAgent.tsのapplyDocumentOperation
    // と同じパターンで、対象が見つからない場合もトップレベルの
    // オブジェクト自体は新しく作る(page.elements配列の中身は変更しない)。
    // そのため、参照の同一性(===)ではなく内容の同一性で確認する。
    results.push(
      check(
        "[Safety-1] 存在しないelementIdへの操作はDocumentModelの内容を変更しない" +
          "(トップレベルオブジェクトは新規作成されるが、pages/elementsの中身は不変)",
        JSON.stringify(moveElement(doc, "does-not-exist", { x: 1, y: 1 })) ===
          JSON.stringify(doc)
      )
    );

    results.push(
      check(
        "[Safety-2] 存在しないpageIdへのaddTextElementはDocumentModelを変更しない",
        addTextElement(doc, "does-not-exist") === doc
      )
    );

  }

  return summarize("design-documentModelOps (TACT Design)", results);

}
