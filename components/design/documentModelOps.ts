// =========================
// documentModelOps (TACT Design: PowerPoint資料編集基盤)
// =========================
//
// DocumentModelに対する「直接編集」操作(ユーザーがCanvas/Slideパネル/
// Propertiesパネルから行う操作)を、mockDesignAgent.tsの
// applyDocumentOperation()と同じ設計方針(immutable、対象が存在
// しない場合は元のDocumentModelをそのまま返す、決定的なID生成)で
// まとめた純粋関数群。
//
// 責務の分離:
//   documentModelOps.ts = Slide/Objectの直接編集操作(このファイル)
//   mockDesignAgent.ts   = AIへの指示による編集(既存、無変更)
// の2つの編集方式(開発指示 Section6 A/B)が、同じDocumentModelを
// それぞれ別の経路から更新する。どちらもDocument Model自体の構造
// (types.ts)は変更しない。
//
// LLM/API呼び出しは一切行わない(このPhaseの絶対条件)。

import { DocumentElement, DocumentModel, DocumentPage, ShapeVariant } from "./types";

// =========================
// ID生成
// =========================
//
// mockDesignAgent.tsのapplyAddText()と同じく、ランダムIDではなく
// 対象Page内の既存要素数から決定的に組み立てる(同じ入力から常に
// 同じ結果を得られるようにするため。Unit Testの再現性のためでも
// ある)。

function nextElementId(page: DocumentPage, prefix: string): string {

  const count = page.elements.filter((el) =>
    el.id.startsWith(`${page.id}-${prefix}-`)
  ).length;

  return `${page.id}-${prefix}-${count}`;

}

function nextPageId(document: DocumentModel): string {

  return `page-${document.pages.length}`;

}

// =========================
// Slide操作
// =========================

export function addSlide(
  document: DocumentModel,
  afterIndex?: number
): DocumentModel {

  const newPage: DocumentPage = {
    id: nextPageId(document),
    index: document.pages.length,
    elements: [],
  };

  const insertAt =
    afterIndex === undefined
      ? document.pages.length
      : Math.min(Math.max(afterIndex + 1, 0), document.pages.length);

  const pages = [
    ...document.pages.slice(0, insertAt),
    newPage,
    ...document.pages.slice(insertAt),
  ].map((page, index) => ({ ...page, index }));

  return { ...document, pages };

}

export function deleteSlide(
  document: DocumentModel,
  pageId: string
): DocumentModel {

  const pages = document.pages
    .filter((page) => page.id !== pageId)
    .map((page, index) => ({ ...page, index }));

  return { ...document, pages };

}

// 複製は新しいPage id(nextPageId)を使うが、Element idは元のPage id
// をprefixとして持っているため、そのままではPrefix規約
// (`${page.id}-...`)と矛盾する。複製後のElementのidも新しいPage id
// を基準に振り直す(nextElementIdと同じprefix規約を保つため)。
export function duplicateSlide(
  document: DocumentModel,
  pageId: string
): DocumentModel {

  const sourceIndex = document.pages.findIndex((page) => page.id === pageId);

  if (sourceIndex === -1) return document;

  const source = document.pages[sourceIndex];
  const newPageId = nextPageId(document);

  const duplicatedElements: DocumentElement[] = source.elements.map(
    (element, index) => ({
      ...element,
      id: `${newPageId}-copy-${index}`,
      // childIdsはコピー元Page内のidを指していたため、複製先では
      // 対応関係が崩れる。安全側としてgroup関係は複製時に解除する
      // (要素自体は個別にそのまま複製される)。
      childIds: undefined,
    })
  );

  const newPage: DocumentPage = {
    id: newPageId,
    index: sourceIndex + 1,
    elements: duplicatedElements,
  };

  const pages = [
    ...document.pages.slice(0, sourceIndex + 1),
    newPage,
    ...document.pages.slice(sourceIndex + 1),
  ].map((page, index) => ({ ...page, index }));

  return { ...document, pages };

}

// 隣接swapのみを提供する(ドラッグ&ドロップの複雑な並び替えUIは
// 今回のMVPでは扱わない、絶対条件「不要な将来機能の過剰実装」回避)。
export function moveSlide(
  document: DocumentModel,
  pageId: string,
  direction: "up" | "down"
): DocumentModel {

  const index = document.pages.findIndex((page) => page.id === pageId);

  if (index === -1) return document;

  const targetIndex = direction === "up" ? index - 1 : index + 1;

  if (targetIndex < 0 || targetIndex >= document.pages.length) {
    return document;
  }

  const pages = [...document.pages];

  [pages[index], pages[targetIndex]] = [pages[targetIndex], pages[index]];

  return {
    ...document,
    pages: pages.map((page, i) => ({ ...page, index: i })),
  };

}

// =========================
// Object(Element)操作
// =========================

const DEFAULT_TEXT_SIZE = { width: 300, height: 60 };
const DEFAULT_SHAPE_SIZE = { width: 160, height: 120 };
const DEFAULT_LINE_SIZE = { width: 200, height: 4 };
const DEFAULT_IMAGE_SIZE = { width: 240, height: 160 };
const NEW_ELEMENT_POSITION = { x: 40, y: 40 };

export function addTextElement(
  document: DocumentModel,
  pageId: string,
  content = "テキストを入力"
): DocumentModel {

  return document.pages.some((p) => p.id === pageId)
    ? {
        ...document,
        pages: document.pages.map((page) => {

          if (page.id !== pageId) return page;

          const newElement: DocumentElement = {
            id: nextElementId(page, "text"),
            type: "text",
            position: { ...NEW_ELEMENT_POSITION },
            size: { ...DEFAULT_TEXT_SIZE },
            content,
            style: { fontSize: 16, fontWeight: "normal" },
          };

          return { ...page, elements: [...page.elements, newElement] };

        }),
      }
    : document;

}

export function addShapeElement(
  document: DocumentModel,
  pageId: string,
  variant: ShapeVariant
): DocumentModel {

  const size =
    variant === "line" ? DEFAULT_LINE_SIZE : DEFAULT_SHAPE_SIZE;

  return document.pages.some((p) => p.id === pageId)
    ? {
        ...document,
        pages: document.pages.map((page) => {

          if (page.id !== pageId) return page;

          const newElement: DocumentElement = {
            id: nextElementId(page, "shape"),
            type: "shape",
            shapeVariant: variant,
            position: { ...NEW_ELEMENT_POSITION },
            size: { ...size },
            style: { backgroundColor: "#E5E7EB", color: "#9CA3AF" },
          };

          return { ...page, elements: [...page.elements, newElement] };

        }),
      }
    : document;

}

// 画像はTACT Design自身が生成・取得することはない(開発指示
// Section7の絶対原則)。ここで受け取るdataUrlは、ユーザー自身が
// ブラウザのファイル選択で選んだ画像ファイルをFileReaderで読んだ
// ものであり、Design側が新しい画像を作り出すわけではない。
export function addImageElement(
  document: DocumentModel,
  pageId: string,
  dataUrl: string
): DocumentModel {

  return document.pages.some((p) => p.id === pageId)
    ? {
        ...document,
        pages: document.pages.map((page) => {

          if (page.id !== pageId) return page;

          const newElement: DocumentElement = {
            id: nextElementId(page, "image"),
            type: "image",
            position: { ...NEW_ELEMENT_POSITION },
            size: { ...DEFAULT_IMAGE_SIZE },
            asset: {
              id: nextElementId(page, "image"),
              source: "uploaded",
              type: "image",
              sourceReference: {},
              preview: { thumbnailUrl: dataUrl },
            },
          };

          return { ...page, elements: [...page.elements, newElement] };

        }),
      }
    : document;

}

function mapElement(
  document: DocumentModel,
  elementId: string,
  fn: (element: DocumentElement) => DocumentElement
): DocumentModel {

  return {
    ...document,
    pages: document.pages.map((page) => {

      if (!page.elements.some((el) => el.id === elementId)) return page;

      return {
        ...page,
        elements: page.elements.map((el) =>
          el.id === elementId ? fn(el) : el
        ),
      };

    }),
  };

}

export function moveElement(
  document: DocumentModel,
  elementId: string,
  position: { x: number; y: number }
): DocumentModel {

  return mapElement(document, elementId, (el) => ({ ...el, position }));

}

// group要素を動かす場合、childIdsが指す子要素も同じ差分だけ動かす
// (groupElements()のコメント参照。子要素は削除しないため、
// 見た目上「一緒に動く」ことをこの関数の責務として持つ)。
// group以外の要素にはmoveElement()と同じ挙動。
export function moveElementWithChildren(
  document: DocumentModel,
  elementId: string,
  position: { x: number; y: number }
): DocumentModel {

  return {
    ...document,
    pages: document.pages.map((page) => {

      const target = page.elements.find((el) => el.id === elementId);

      if (!target) return page;

      const dx = position.x - target.position.x;
      const dy = position.y - target.position.y;

      const childIds = new Set(
        target.type === "group" ? target.childIds ?? [] : []
      );

      return {
        ...page,
        elements: page.elements.map((el) => {

          if (el.id === elementId) {
            return { ...el, position };
          }

          if (childIds.has(el.id)) {
            return {
              ...el,
              position: { x: el.position.x + dx, y: el.position.y + dy },
            };
          }

          return el;

        }),
      };

    }),
  };

}

export function resizeElement(
  document: DocumentModel,
  elementId: string,
  size: { width: number; height: number }
): DocumentModel {

  const MIN_SIZE = 8;

  return mapElement(document, elementId, (el) => ({
    ...el,
    size: {
      width: Math.max(MIN_SIZE, size.width),
      height: Math.max(MIN_SIZE, size.height),
    },
  }));

}

export function updateElementContent(
  document: DocumentModel,
  elementId: string,
  content: string
): DocumentModel {

  return mapElement(document, elementId, (el) => ({ ...el, content }));

}

export function updateElementStyle(
  document: DocumentModel,
  elementId: string,
  styleChanges: Record<string, unknown>
): DocumentModel {

  return mapElement(document, elementId, (el) => ({
    ...el,
    style: { ...el.style, ...styleChanges },
  }));

}

export function deleteElement(
  document: DocumentModel,
  elementId: string
): DocumentModel {

  return {
    ...document,
    pages: document.pages.map((page) => ({
      ...page,
      elements: page.elements.filter((el) => el.id !== elementId),
    })),
  };

}

export function duplicateElement(
  document: DocumentModel,
  elementId: string
): DocumentModel {

  return {
    ...document,
    pages: document.pages.map((page) => {

      const index = page.elements.findIndex((el) => el.id === elementId);

      if (index === -1) return page;

      const source = page.elements[index];

      const duplicated: DocumentElement = {
        ...source,
        id: nextElementId(page, "copy"),
        position: {
          x: source.position.x + 16,
          y: source.position.y + 16,
        },
        childIds: undefined,
      };

      return { ...page, elements: [...page.elements, duplicated] };

    }),
  };

}

// z-order: DocumentModel自体には明示的なz-indexフィールドが無く、
// page.elements配列内の並び順(後の方が上に描画される、
// DocumentRenderer.tsxのPageView参照)がそのままz-orderを表す。
// 新しいフィールドを追加せず、配列内での並び替えだけでfront/back
// を表現する(既存の描画順=z-orderという前提を維持)。
export function bringToFront(
  document: DocumentModel,
  elementId: string
): DocumentModel {

  return {
    ...document,
    pages: document.pages.map((page) => {

      const index = page.elements.findIndex((el) => el.id === elementId);

      if (index === -1 || index === page.elements.length - 1) return page;

      const elements = [...page.elements];
      const [element] = elements.splice(index, 1);
      elements.push(element);

      return { ...page, elements };

    }),
  };

}

export function sendToBack(
  document: DocumentModel,
  elementId: string
): DocumentModel {

  return {
    ...document,
    pages: document.pages.map((page) => {

      const index = page.elements.findIndex((el) => el.id === elementId);

      if (index <= 0) return page;

      const elements = [...page.elements];
      const [element] = elements.splice(index, 1);
      elements.unshift(element);

      return { ...page, elements };

    }),
  };

}

export type AlignDirection =
  | "left"
  | "centerX"
  | "right"
  | "top"
  | "centerY"
  | "bottom";

// PowerPointの「配置」機能と同じ考え方: 選択した要素を、そのPage
// (スライド)の外枠を基準に整列させる。複数要素間の相対整列
// (要素同士を揃える)は今回のMVPでは扱わず、スライド基準の整列に
// 限定する(絶対条件「不要な将来機能の過剰実装」回避)。
export function alignElementToSlide(
  document: DocumentModel,
  elementId: string,
  direction: AlignDirection,
  slideWidth: number,
  slideHeight: number
): DocumentModel {

  return mapElement(document, elementId, (el) => {

    const position = { ...el.position };

    switch (direction) {
      case "left":
        position.x = 0;
        break;
      case "centerX":
        position.x = (slideWidth - el.size.width) / 2;
        break;
      case "right":
        position.x = slideWidth - el.size.width;
        break;
      case "top":
        position.y = 0;
        break;
      case "centerY":
        position.y = (slideHeight - el.size.height) / 2;
        break;
      case "bottom":
        position.y = slideHeight - el.size.height;
        break;
    }

    return { ...el, position };

  });

}

// グループ化: 選択された複数要素を包む外接矩形をtype:"group"の
// 新しいElementとして作成し、childIdsで元の要素を参照する。
//
// 重要: 元の子要素はPage.elementsから削除しない(そのまま個別の
// DocumentElementとして存在し続ける)。groupは「これらの要素が
// 一緒に選択・移動される」という関係を表す軽量な参照レイヤーに
// 留め、子要素の実体を1箇所にしか無い状態にしない
// (削除すると復元できないデータ損失になるため)。CanvasEditor側は、
// group要素が選択・移動された場合、childIdsが指す各要素の位置も
// 同じ差分だけ動かすことで「グループとして動く」見た目を実現する
// (このファイルにはCanvasの操作イベント処理は持ち込まない、
// documentModelOpsは純粋なモデル操作のみを担う)。
export function groupElements(
  document: DocumentModel,
  pageId: string,
  elementIds: string[]
): DocumentModel {

  if (elementIds.length < 2) return document;

  return {
    ...document,
    pages: document.pages.map((page) => {

      if (page.id !== pageId) return page;

      const targets = page.elements.filter((el) =>
        elementIds.includes(el.id)
      );

      if (targets.length < 2) return page;

      const minX = Math.min(...targets.map((el) => el.position.x));
      const minY = Math.min(...targets.map((el) => el.position.y));
      const maxX = Math.max(
        ...targets.map((el) => el.position.x + el.size.width)
      );
      const maxY = Math.max(
        ...targets.map((el) => el.position.y + el.size.height)
      );

      const groupElement: DocumentElement = {
        id: nextElementId(page, "group"),
        type: "group",
        position: { x: minX, y: minY },
        size: { width: maxX - minX, height: maxY - minY },
        childIds: elementIds,
      };

      // 子要素は削除せず残す(上記コメント参照)。groupElementを
      // 配列の末尾に追加するだけなので、z-order(描画順)としては
      // groupの外枠が子要素より前面に来る形になる。CanvasEditorは
      // group要素自体をクリック領域として扱い、子要素個別への
      // クリックはgroup解除後にのみ有効にする想定。
      return {
        ...page,
        elements: [...page.elements, groupElement],
      };

    }),
  };

}

// group要素だけを取り除く(子要素は元々削除していないため、
// そのまま残る=見た目上も変化しない、個別に選択できる状態に戻る)。
export function ungroupElement(
  document: DocumentModel,
  groupElementId: string
): DocumentModel {

  return {
    ...document,
    pages: document.pages.map((page) => {

      const group = page.elements.find(
        (el) => el.id === groupElementId && el.type === "group"
      );

      if (!group) return page;

      return {
        ...page,
        elements: page.elements.filter((el) => el.id !== groupElementId),
      };

    }),
  };

}
