// =========================
// mockDesignAgent (STEP43〜STEP50)
// =========================
//
// 実LLMへは接続しない。ユーザーの自然言語入力から、簡単なキーワード
// 判定だけでDesignIntent/DocumentOperationのmockを生成する。
//
// 目的はあくまで「User Input → DesignIntent → DocumentOperation →
// (Apply時に)実際のDocument Model変更」という一連の流れを、実LLM
// なしで成立させることであり、自然言語理解の精度自体は今回の
// 対象外(将来Design Agent(LLM)へ置き換える差し込み口として、
// generateDesignIntent/generateDocumentOperationsの2つの関数だけを
// 差し替えれば良い形にしておく)。
//
// STEP46: STEP45まで「changeStyle以外は説明文(note)をstyleへ
// 詰め込むだけ」だったOperationを、実際にDocument Modelを編集する
// ものへ拡張した。生成(generateDocumentOperations)と適用
// (applyDocumentOperation)のどちらも、「安全に意味づけできる
// 変更だけを行い、根拠のない変更はしない」という既存方針
// (STEP43〜45)を維持している。
//
// STEP50: 実LLM接続前の最終Mock精度向上。
// - changeStyleが固定値(fontSize:36等)ではなく、現在のstyleを
//   基準に、rawInput中の具体的な指示(太字/普通の太さ/斜体/
//   揃え)を反映するようになった(computeStyleChanges)。
// - moveElement/resizeElementが「少し/もっと」の強度差を反映する
//   (intensityMultiplier)。resizeElementは「横に広げて/縦に
//   伸ばして」の片方向のみの変更にも対応した。
// - deleteElement(要素そのものの削除)を自然言語から生成できる
//   ようにした(STEP46時点ではapply側のみ実装済みだった)。
// - 1つの入力から複数の安全なOperationを生成できる場合(例:
//   「タイトルを大きくして右に移動して」)、複数生成するように
//   拡張した(getMatchedActions)。ただし、曖昧な依頼から無関係な
//   Operationを大量生成することはしない(あくまでキーワードが
//   実際に一致した分だけ)。
// - changeLayout/addElement/duplicateElementは、意味づけが
//   まだ存在しないため、STEP50でも意図的にどのIntentRuleからも
//   生成されない状態を維持する(生成しない、が優先方針)。

import {
  AssetReference,
  DesignIntent,
  DesignIntentAction,
  DocumentElement,
  DocumentModel,
  DocumentOperation,
  DocumentOperationType,
  DocumentPage,
} from "./types";

// STEP140: 既存Asset(PowerPoint/Canva/アップロード済み)の検索・
// 解決ロジック。実LLM接続前のMockとして、mockAssetLibrary.tsを
// 検索対象に使う(外部API接続後はこのimport元だけ差し替える想定)。
import { mockAssets } from "./mockAssetLibrary";
import { assetTypeToElementType, resolveAssetNeed } from "./assetDiscovery";

// =========================
// createMockDocument
// =========================
//
// STEP45でAIPanel.tsxからの利用は廃止したが(currentOutputToDocumentModel
// による実データ変換へ置き換え)、関数自体は他用途(テスト等)で
// 使える可能性があるため残している。

export function createMockDocument(): DocumentModel {

  return {
    id: "mock-document",
    title: "サンプル資料",
    pages: [
      {
        id: "page-1",
        index: 0,
        elements: [
          {
            id: "title",
            type: "text",
            position: { x: 40, y: 30 },
            size: { width: 600, height: 60 },
            content: "サンプルタイトル",
            style: { fontSize: 28, fontWeight: "normal" },
          },
          {
            id: "body",
            type: "text",
            position: { x: 40, y: 110 },
            size: { width: 600, height: 300 },
            content: "本文のプレースホルダーです。",
            style: { fontSize: 14 },
          },
        ],
      },
    ],
  };

}

// =========================
// generateDesignIntent
// =========================
//
// キーワードだけで判定する素朴な実装。複数のキーワードに
// マッチする場合は最初に見つかったものを優先する。
// どれにも当てはまらない場合は action: "unknown" とし、
// confidence: "low" として「曖昧な依頼」を表現する
// (=構造化自体は諦めない。STEP43のCASE Cが対象とするケース)。

interface IntentRule {
  keywords: string[];
  action: DesignIntentAction;
  target: string;
  parameters: Record<string, unknown>;
  reason: string;
}

const INTENT_RULES: IntentRule[] = [

  // STEP46: 「大きく/小さく」はSTEP43ではchangeStyle(フォント強調)の
  // キーワードだったが、resizeElement(要素そのものの寸法変更)と
  // 意味が重複していたため分離した。STEP50でもこの区分を維持する
  // (「大きく/小さくする」は要素の箱そのものの寸法変更として扱う。
  // 太字・斜体・文字揃え等、明確にスタイル固有の指示はchangeStyle
  // 側で扱う)。STEP50で「横に広げて/縦に伸ばして」(片方向のみの
  // サイズ変更)を追加。
  {
    keywords: [
      "大きく", "でかく", "小さく", "拡大", "縮小",
      "横に広げ", "縦に伸ば",
    ],
    action: "resizeElement",
    target: "title",
    parameters: {},
    reason:
      "「大きく/小さくする」という表現から、対象要素のサイズ" +
      "変更を求めていると判断しました。",
  },

  // STEP46で追加。STEP50で「少し/もっと」の強度差に対応。
  {
    keywords: ["移動して", "動かして", "右に", "左に", "上に", "下に"],
    action: "moveElement",
    target: "title",
    parameters: {},
    reason:
      "「移動して」という表現から、対象要素の位置変更を" +
      "求めていると判断しました。",
  },

  // STEP50: 「普通の太さ/斜体/文字揃え」を追加。「大きく/小さく」は
  // resizeElement(上記)側の担当のため、ここには含めない
  // (要素の箱の寸法とフォントスタイルは別の変更として扱う)。
  {
    keywords: [
      "目立た", "強調", "太字", "普通の太さ", "標準の太さ",
      "斜体", "中央揃え", "左揃え", "右揃え",
    ],
    action: "changeStyle",
    target: "title",
    parameters: { emphasis: "stronger" },
    reason:
      "「目立たせる/強調する」という表現、またはフォント・文字揃え" +
      "に関する具体的な指示から、対象要素のスタイル変更を" +
      "求めていると判断しました。",
  },

  // STEP50で追加。reduceContent(テキスト量の削減)とは異なり、
  // 要素そのものを取り除く要望。
  {
    keywords: ["削除して", "消して", "なくして"],
    action: "deleteElement",
    target: "title",
    parameters: {},
    reason:
      "「削除する/消す」という表現から、対象要素そのものの削除を" +
      "求めていると判断しました。",
  },

  {
    // STEP46で「短く」「要約」を追加(この文章を短くして、等)。
    keywords: [
      "情報量", "減らして", "シンプル", "詰め込み", "多すぎ",
      "短く", "要約",
    ],
    action: "reduceContent",
    target: "slide",
    parameters: { direction: "reduce" },
    reason:
      "「情報量を減らす/短くする」という表現から、対象の" +
      "内容量を減らす意図と判断しました。",
  },

  {
    keywords: ["追加", "足して", "補って"],
    action: "addContent",
    target: "slide",
    parameters: {},
    reason:
      "「追加する/足す」という表現から、新しい情報の追加を" +
      "求めていると判断しました。",
  },

  {
    keywords: ["構成", "順番", "並び替え", "整理"],
    action: "reorganize",
    target: "document",
    parameters: {},
    reason:
      "「構成/順番」という表現から、資料全体の並び・構成の" +
      "見直しを求めていると判断しました。",
  },

  // STEP140で追加。新しい画像・図形の生成要望と誤認しないよう、
  // 「既存の」「持っている」等、既存素材の利用を明確に示す語が
  // 含まれる場合のみ対象にする(単に「画像を追加して」だけでは
  // 生成要望とも取れるため、あえて「既存」を明示した表現に限定
  // している)。「既存の会社ロゴを配置して」のように、既存語と
  // 素材語の間に他の語が入る自然な言い回しにも対応できるよう、
  // 語句を分割せず「既存」を含む表現そのものをキーワードにする
  // (完全一致の連続フレーズを要求しない)。
  {
    keywords: [
      "既存の", "既存素材", "既にある", "持っている画像",
      "持っているロゴ", "持っている素材",
    ],
    action: "useExistingAsset",
    target: "slide",
    parameters: {},
    reason:
      "「既存の」「持っている」という表現から、新しい素材の生成" +
      "ではなく、既にPowerPoint/Canva等に存在する素材の利用を" +
      "求めていると判断しました。",
  },

];

export function generateDesignIntent(
  userInput: string
): DesignIntent {

  const matchedRule = INTENT_RULES.find((rule) =>
    rule.keywords.some((keyword) => userInput.includes(keyword))
  );

  if (matchedRule) {

    return {
      id: crypto.randomUUID(),
      rawInput: userInput,
      action: matchedRule.action,
      target: matchedRule.target,
      parameters: matchedRule.parameters,
      reason: matchedRule.reason,
      confidence: "medium",
    };

  }

  // 「もっと見やすくして」のような、具体的な操作を特定できない
  // 曖昧な依頼。actionをunknownにしつつ、rawInputはそのまま
  // 保持することで、後段(将来のDesign Agent)が再解釈できる
  // 余地を残す。
  return {
    id: crypto.randomUUID(),
    rawInput: userInput,
    action: "unknown",
    target: "document",
    parameters: {},
    reason:
      "具体的にどの要素を、どう変更したいかを特定できなかった" +
      "ため、曖昧な改善依頼として扱います。",
    confidence: "low",
  };

}

// =========================
// getMatchedActions (STEP50)
// =========================
//
// generateDesignIntent()は「主たる1つのDesignIntent」を返す(rawInput
// ・reason・confidenceを説明するための、単一の代表的な解釈)。
// 一方で、1つの自然言語入力が複数の安全なOperationに対応する場合
// (例:「タイトルを大きくして右に移動して」)があるため、
// generateDocumentOperationsではこの関数でrawInputと全INTENT_RULESを
// 突き合わせ、一致したactionをすべて(重複なく、ルール順に)集める。
// 曖昧な入力から無関係なOperationを大量生成しないよう、あくまで
// キーワードが実際に一致したものだけを対象にする(推測で増やさない)。
function getMatchedActions(rawInput: string): DesignIntentAction[] {

  const actions: DesignIntentAction[] = [];

  for (const rule of INTENT_RULES) {

    const matches = rule.keywords.some((keyword) =>
      rawInput.includes(keyword)
    );

    if (matches && !actions.includes(rule.action)) {
      actions.push(rule.action);
    }

  }

  return actions;

}

// =========================
// target解決 (STEP45、STEP46で本文/文章のエイリアスを追加)
// =========================
//
// DesignIntent.rawInputから、Document Model内の実際のElement idへ
// 解決するルールベースの仕組み。「タイトル」「本文/文章」「第N章」
// 「スライドN」といった基本語彙のみを対象にする。
//
// 重要: どのルールにも一致しない場合、あるいは一致しても対応する
// 要素が実際には存在しない場合は、必ずnullを返す。呼び出し側は
// nullの場合、操作案を生成しない(=勝手なElementを推測で操作しない)。

const KANJI_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function parseChapterNumber(rawInput: string): number | null {

  const arabicMatch = rawInput.match(/第\s*(\d+)\s*章/);
  if (arabicMatch) return parseInt(arabicMatch[1], 10);

  const kanjiMatch = rawInput.match(/第\s*([一二三四五六七八九十])\s*章/);
  if (kanjiMatch) return KANJI_DIGITS[kanjiMatch[1]] ?? null;

  return null;

}

// 「スライド2」のように番号付きの場合のみ解決する。番号のない
// 「スライド」だけでは、どのスライドを指すか一意に決められない
// ため、あえて解決しない(=安全側に倒す)。
function parseSlideNumber(rawInput: string): number | null {

  const match = rawInput.match(/スライド\s*(\d+)/);

  return match ? parseInt(match[1], 10) : null;

}

// pageId内で「タイトルらしき要素」を探す。currentOutputToDocumentModel
// (STEP44)が組み立てるid規約(`${pageId}-title-${index}`)に依存する。
function findTitleElementId(page: DocumentPage): string | null {

  const el = page.elements.find((e) => e.id.includes("-title-"));

  return el ? el.id : null;

}

// pageId内で「本文らしき要素」を探す(タイトルではない、通常の
// テキスト要素)。
function findBodyTextElementId(page: DocumentPage): string | null {

  const el = page.elements.find((e) => e.id.includes("-text-"));

  return el ? el.id : null;

}

export function resolveTargetElementId(
  rawInput: string,
  document: DocumentModel
): string | null {

  // 第N章: タイトル要素を持つページ(表紙・章のページ等)のうち、
  // N番目のページのタイトル要素を対象にする。keyFindings/
  // recommendations/nextActions等の付録的なページ(見出しの
  // id規約が異なる。currentOutputToDocumentModel参照)は含めない。
  const chapterNumber = parseChapterNumber(rawInput);

  if (chapterNumber !== null) {

    const titledPages = document.pages.filter((page) =>
      page.elements.some((el) => el.id.includes("-title-"))
    );

    const page = titledPages[chapterNumber - 1];

    return page ? findTitleElementId(page) : null;

  }

  // スライドN: ページの並び順そのものをスライド番号とみなす
  // (Presentation用のDocumentModelは1ページ=1スライドで
  // 生成されるため。currentOutputToDocumentModel参照)。
  const slideNumber = parseSlideNumber(rawInput);

  if (slideNumber !== null) {

    const page = document.pages[slideNumber - 1];

    return page ? findTitleElementId(page) : null;

  }

  // タイトル: 先頭ページから順に、最初に見つかったタイトル要素。
  if (rawInput.includes("タイトル")) {

    for (const page of document.pages) {

      const id = findTitleElementId(page);

      if (id) return id;

    }

    return null;

  }

  // 本文/文章: 先頭ページから順に、最初に見つかった本文テキスト要素。
  // STEP46で「文章」を「本文」のエイリアスとして追加
  // (「この文章を短くして」等の言い回しに対応するため)。
  if (rawInput.includes("本文") || rawInput.includes("文章")) {

    for (const page of document.pages) {

      const id = findBodyTextElementId(page);

      if (id) return id;

    }

    return null;

  }

  // いずれにも該当しない場合は解決しない(安全側)。
  return null;

}

// =========================
// resolveTargetPageId (STEP46)
// =========================
//
// addText(Page単位でElementを新規追加する操作)専用のtarget解決。
// まずはresolveTargetElementIdと同じ語彙(第N章/スライドN/タイトル/
// 本文)でElementを解決し、その要素が属するPageを逆引きする。
// それでも解決できない場合のみ、「このページ」「このスライド」
// のような文脈依存の指示語を、先頭ページを指すものとみなす
// 簡易ルールを追加で適用する(将来的に「今表示中のページ」等の
// 文脈追跡が必要になった際に置き換える前提の、あくまで簡易的な
// fallback)。
//
// 重要: resolveTargetElementId自体の挙動(例:番号のない
// 「スライド」だけでは解決しない)は変更しない。この関数だけが
// 追加のfallbackを持つ。

export function resolveTargetPageId(
  rawInput: string,
  document: DocumentModel
): string | null {

  const elementId = resolveTargetElementId(rawInput, document);

  if (elementId) {

    const page = document.pages.find((p) =>
      p.elements.some((el) => el.id === elementId)
    );

    if (page) return page.id;

  }

  if (rawInput.includes("ページ") || rawInput.includes("スライド")) {
    return document.pages[0]?.id ?? null;
  }

  return null;

}

// =========================
// generateDocumentOperations (STEP46で全面拡張)
// =========================
//
// DesignIntentを、Document Modelに対する具体的な操作候補
// (DocumentOperation[])へ変換する。ここではまだDocument Modelを
// 書き換えない(status: "proposed"のまま返す。実際の適用は
// applyDocumentOperationの責務)。
//
// 「安全に意味づけできる変更内容がない場合は操作案を生成しない」
// という方針(STEP43/45)をSTEP46でも維持する。特にreduceContent
// (deleteText)は、実際に削減可能な内容(=複数文かどうか)を
// 対象Elementの実データから判定し、削減できる根拠がなければ
// 操作案自体を出さない。

const ACTION_TO_OPERATION_TYPE: Partial<
  Record<DesignIntentAction, DocumentOperationType>
> = {
  changeStyle: "changeStyle",
  changeLayout: "changeLayout",
  moveElement: "moveElement",
  resizeElement: "resizeElement",
  reduceContent: "deleteText",
  // STEP50: deleteElementはbuildDeleteElementOperationで専用構築
  // するため実際にはこのmapを経由しないが、DesignIntentAction→
  // DocumentOperationTypeの対応関係を一覧できるよう記載しておく。
  deleteElement: "deleteElement",
};

// STEP46: changesの中身をtype別に組み立てる。DocumentOperation.changes
// 自体はRecord<string, unknown>のまま(過度な型分割はしない)だが、
// 生成時にはこれらの軽量な内部interfaceで組み立てることで、
// type-changesの対応関係をコード上明確にする。

interface StyleChanges {
  fontSize?: number;
  fontWeight?: string;
  // STEP50で追加。斜体・文字揃えの指示を、既存のfontSize/fontWeightと
  // 同じ形(DocumentElement.styleへそのままmergeできる形)で表現する。
  fontStyle?: string;
  textAlign?: string;
}

interface PositionChanges {
  position: { x?: number; y?: number };
}

interface SizeChanges {
  size: { width?: number; height?: number };
}

interface ContentChanges {
  content: string;
}

const MOVE_STEP = 40;
const RESIZE_STEP_WIDTH = 100;
const RESIZE_STEP_HEIGHT = 20;
const MIN_ELEMENT_SIZE = 40;
const EMPHASIS_FONT_SIZE_DELTA = 8;
const DEFAULT_FONT_SIZE = 16;

// STEP50: 「少し」「もっと」という強度の指示を、moveElement/
// resizeElementの両方で共通のstep倍率として扱う簡易ルール。
// 指定がない場合は等倍(1)のまま。
function intensityMultiplier(rawInput: string): number {

  if (rawInput.includes("少し")) return 0.5;
  if (rawInput.includes("もっと")) return 1.5;

  return 1;

}

function computeMoveChanges(rawInput: string): PositionChanges {

  const step = MOVE_STEP * intensityMultiplier(rawInput);

  let dx = 0;
  let dy = 0;

  if (rawInput.includes("右")) dx += step;
  if (rawInput.includes("左")) dx -= step;
  if (rawInput.includes("下")) dy += step;
  if (rawInput.includes("上")) dy -= step;

  // 方向語がない「移動して/動かして」だけの場合は、右方向への
  // 移動をデフォルトの提案とする(mockとしての固定挙動)。
  if (dx === 0 && dy === 0) dx = step;

  return { position: { x: dx, y: dy === 0 ? undefined : dy } };

}

function computeResizeChanges(
  rawInput: string,
  element: DocumentElement
): SizeChanges {

  const grow = !rawInput.includes("小さく") && !rawInput.includes("縮小");
  const multiplier = intensityMultiplier(rawInput);

  // STEP50: 「横に広げて」「縦に伸ばして」は片方向のみ変更する。
  const widthOnly = rawInput.includes("横に広げ") || rawInput.includes("横幅");
  const heightOnly = rawInput.includes("縦に伸ば") || rawInput.includes("縦幅");

  const deltaW = (grow ? RESIZE_STEP_WIDTH : -RESIZE_STEP_WIDTH) * multiplier;
  const deltaH = (grow ? RESIZE_STEP_HEIGHT : -RESIZE_STEP_HEIGHT) * multiplier;

  const width = heightOnly
    ? element.size.width
    : Math.max(MIN_ELEMENT_SIZE, element.size.width + deltaW);

  const height = widthOnly
    ? element.size.height
    : Math.max(MIN_ELEMENT_SIZE, element.size.height + deltaH);

  return { size: { width, height } };

}

// STEP50: changeStyleを固定値(fontSize:36等)から、現在のstyleを
// 基準にした変更へ改善する。rawInput中の具体的な指示(太字/普通の
// 太さ/斜体/文字揃え)を優先して反映し、どれにも該当しない場合
// (「目立たせて」「強調して」等の一般的な要望)だけ、現在の
// fontSizeを基準にした強調(サイズアップ+太字)を既定値として使う。
function computeStyleChanges(
  rawInput: string,
  element: DocumentElement
): StyleChanges {

  const currentStyle = element.style ?? {};
  const changes: StyleChanges = {};

  if (rawInput.includes("普通の太さ") || rawInput.includes("標準の太さ")) {
    changes.fontWeight = "normal";
  } else if (rawInput.includes("太字")) {
    changes.fontWeight = "bold";
  }

  if (rawInput.includes("斜体")) {
    changes.fontStyle = "italic";
  }

  if (rawInput.includes("中央揃え")) {
    changes.textAlign = "center";
  } else if (rawInput.includes("左揃え")) {
    changes.textAlign = "left";
  } else if (rawInput.includes("右揃え")) {
    changes.textAlign = "right";
  }

  const hasExplicitInstruction =
    changes.fontWeight !== undefined ||
    changes.fontStyle !== undefined ||
    changes.textAlign !== undefined;

  if (!hasExplicitInstruction) {

    const currentFontSize =
      typeof currentStyle.fontSize === "number"
        ? currentStyle.fontSize
        : DEFAULT_FONT_SIZE;

    changes.fontSize = currentFontSize + EMPHASIS_FONT_SIZE_DELTA;
    changes.fontWeight = "bold";

  }

  return changes;

}

// 対象テキストが複数文からなる場合のみ、先頭文だけを残した
// 「削減後content」を返す。1文しかない、あるいは全体が既に
// 短い場合はnullを返し、呼び出し側は操作案を生成しない
// (=存在しない削減内容を勝手に作らない)。
function computeShortenedContent(content: string): string | null {

  const sentences = content
    .split(/(?<=[。!?])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length <= 1) return null;

  const shortened = sentences[0];

  if (shortened.length >= content.trim().length) return null;

  return shortened;

}

function buildChangesForOperation(
  rawInput: string,
  operationType: DocumentOperationType,
  element: DocumentElement
): StyleChanges | PositionChanges | SizeChanges | ContentChanges | null {

  switch (operationType) {

    case "changeStyle":
      // STEP50: 固定値ではなく、現在のstyleとrawInputの具体的な
      // 指示を基準に組み立てる(computeStyleChanges参照)。
      return computeStyleChanges(rawInput, element);

    case "moveElement":
      return computeMoveChanges(rawInput);

    case "resizeElement":
      return computeResizeChanges(rawInput, element);

    case "deleteText": {

      if (!element.content) return null;

      const shortened = computeShortenedContent(element.content);

      if (!shortened) return null;

      return { content: shortened };

    }

    default:
      return null;

  }

}

function buildAddTextOperation(
  intent: DesignIntent,
  document: DocumentModel
): DocumentOperation[] {

  const pageId = resolveTargetPageId(intent.rawInput, document);

  if (!pageId) return [];

  return [
    {
      id: crypto.randomUUID(),
      type: "addText",
      // addTextはPage単位の操作のため、targetIdはElement idではなく
      // Page id(applyDocumentOperation側もこの前提で処理する)。
      targetId: pageId,
      changes: {
        content:
          "（AIによる追加提案のプレースホルダーです。実際の文章は" +
          "まだ生成されません。）",
      },
      sourceIntentId: intent.id,
      status: "proposed",
    },
  ];

}

// STEP140: useExistingAsset(既存Assetの利用)専用のOperation構築。
// addTextと同じくPage単位の操作として扱う(どのElementを変更する
// のではなく、Pageへ新しいAsset要素を追加するため)。
//
// 最重要: 該当する既存Assetが見つからなかった場合、絶対に
// フォールバックのOperationを作らない(=空配列を返す)。呼び出し元
// (AIPanel.tsx)は、operations.length === 0 かつ
// intent.action === "useExistingAsset" の場合に、「素材が
// 見つかりませんでした」という文言を表示する(handleSend内)。
function buildPlaceAssetOperation(
  intent: DesignIntent,
  document: DocumentModel
): DocumentOperation[] {

  const pageId = resolveTargetPageId(intent.rawInput, document);

  if (!pageId) return [];

  const resolution = resolveAssetNeed(
    { description: intent.rawInput },
    mockAssets
  );

  if (resolution.status === "not_found") return [];

  const asset: AssetReference = resolution.asset;

  return [
    {
      id: crypto.randomUUID(),
      type: "placeAsset",
      // placeAssetもaddTextと同じくPage単位の操作のため、
      // targetIdはElement idではなくPage id。
      targetId: pageId,
      changes: { asset },
      sourceIntentId: intent.id,
      status: "proposed",
    },
  ];

}

// STEP50: deleteElement(要素そのものの削除)専用のOperation構築。
// 他のElement単位の操作(changeStyle/moveElement/resizeElement/
// deleteText)と同じresolveTargetElementIdを使うが、changesが
// 不要(空オブジェクトでよい)な点が異なるため、buildChangesFor
// Operationとは別に扱う。
function buildDeleteElementOperation(
  intent: DesignIntent,
  document: DocumentModel
): DocumentOperation | null {

  const targetId = resolveTargetElementId(intent.rawInput, document);

  if (!targetId) return null;

  const exists = document.pages.some((page) =>
    page.elements.some((el) => el.id === targetId)
  );

  if (!exists) return null;

  return {
    id: crypto.randomUUID(),
    type: "deleteElement",
    targetId,
    changes: {},
    sourceIntentId: intent.id,
    status: "proposed",
  };

}

// Element単位のOperation(changeStyle/moveElement/resizeElement/
// deleteText)を、1つのactionについて構築する。target解決・
// 変更内容の組み立てのどちらかが失敗した場合はnullを返す
// (=このactionについては操作案を出さない)。
function buildElementOperation(
  action: DesignIntentAction,
  intent: DesignIntent,
  document: DocumentModel
): DocumentOperation | null {

  const targetId = resolveTargetElementId(intent.rawInput, document);

  if (!targetId) return null;

  const targetElement = document.pages
    .flatMap((page) => page.elements)
    .find((el) => el.id === targetId);

  if (!targetElement) return null;

  const operationType = ACTION_TO_OPERATION_TYPE[action] ?? "changeStyle";

  const changes = buildChangesForOperation(
    intent.rawInput,
    operationType,
    targetElement
  );

  // STEP46: 意味のある変更内容を組み立てられなかった場合
  // (例: reduceContentだが対象が既に1文しかない)は、操作案自体を
  // 生成しない。
  if (!changes) return null;

  return {
    id: crypto.randomUUID(),
    type: operationType,
    targetId,
    changes: changes as unknown as Record<string, unknown>,
    sourceIntentId: intent.id,
    status: "proposed",
  };

}

export function generateDocumentOperations(
  intent: DesignIntent,
  document: DocumentModel
): DocumentOperation[] {

  // actionが"unknown"の場合、機械的な操作案までは生成しない
  // (根拠のない操作を提示しないため)。
  if (intent.action === "unknown") {
    return [];
  }

  // STEP50: 1つの入力に複数の安全なOperationが含まれる場合
  // (例:「タイトルを大きくして右に移動して」)、実際にキーワードが
  // 一致したactionの分だけOperationを生成する。無関係な変更を
  // 推測で増やすことはしない(getMatchedActionsはキーワード一致
  // のみを見る)。
  const matchedActions = getMatchedActions(intent.rawInput);

  const operations: DocumentOperation[] = [];

  for (const action of matchedActions) {

    // reorganize: 並び替え内容を安全に決定できないため、STEP46から
    // 継続して操作案を生成しない(無理な実装をしないという明示的な
    // 方針)。
    if (action === "reorganize") continue;

    // addContent(addText)はPage単位の操作のため、他のaction
    // (Element単位)とは別経路で処理する。
    if (action === "addContent") {
      operations.push(...buildAddTextOperation(intent, document));
      continue;
    }

    // STEP140: useExistingAssetもPage単位の操作。該当する既存
    // Assetが見つからない場合はbuildPlaceAssetOperationが空配列を
    // 返すため、ここでも自動的に「操作案なし」になる
    // (新しい素材を生成して埋め合わせることはしない)。
    if (action === "useExistingAsset") {
      operations.push(...buildPlaceAssetOperation(intent, document));
      continue;
    }

    // deleteElementも専用の構築関数を使う(changesが不要なため)。
    if (action === "deleteElement") {
      const operation = buildDeleteElementOperation(intent, document);
      if (operation) operations.push(operation);
      continue;
    }

    // changeStyle/moveElement/resizeElement/reduceContent(deleteText)。
    const operation = buildElementOperation(action, intent, document);

    if (operation) operations.push(operation);

  }

  return operations;

}

// =========================
// applyDocumentOperation (STEP45で新設、STEP46で全面拡張)
// =========================
//
// DocumentOperationを実際にDocument Modelへ適用する、唯一の場所。
// 対象Element(またはaddTextの場合は対象Page)以外は一切変更しない。
// Document Modelはimmutableに扱い、新しいオブジェクトを返す
// (元のdocument引数は変更しない)。対象が実在しない場合は
// Document Modelを変更しない(元のdocumentをそのまま返す)。

function applyChangesToElement(
  element: DocumentElement,
  operation: DocumentOperation
): DocumentElement {

  switch (operation.type) {

    case "changeStyle": {

      return {
        ...element,
        style: { ...element.style, ...operation.changes },
      };

    }

    case "moveElement": {

      const positionChanges =
        (operation.changes.position as
          | { x?: number; y?: number }
          | undefined) ?? {};

      return {
        ...element,
        position: {
          x: element.position.x + (positionChanges.x ?? 0),
          y: element.position.y + (positionChanges.y ?? 0),
        },
      };

    }

    case "resizeElement": {

      const sizeChanges =
        (operation.changes.size as
          | { width?: number; height?: number }
          | undefined) ?? {};

      return {
        ...element,
        size: {
          width: sizeChanges.width ?? element.size.width,
          height: sizeChanges.height ?? element.size.height,
        },
      };

    }

    case "deleteText":
    case "replaceText": {

      const content = operation.changes.content;

      if (typeof content !== "string") return element;

      return { ...element, content };

    }

    default:
      // addText/deleteElement/addElement/duplicateElement/
      // changeLayoutは、単一Elementのフィールド更新では表現
      // できない(Page単位の操作、または今回は意味づけ未実装)。
      // applyDocumentOperation側で個別に処理するか、変更しない。
      return element;

  }

}

// STEP46: addTextはPage.elementsへの追加(Element単位の更新では
// 表現できない)。targetIdはPage idとして扱う(buildAddTextOperation
// 参照)。決定的なID(`${pageId}-text-${index}`)・決定的な配置
// (既存要素の一番下)を用い、ランダム値には依存しない。
function applyAddText(
  document: DocumentModel,
  operation: DocumentOperation
): DocumentModel {

  const pageIndex = document.pages.findIndex(
    (page) => page.id === operation.targetId
  );

  if (pageIndex === -1) return document;

  const content = operation.changes.content;

  if (typeof content !== "string" || !content) return document;

  const page = document.pages[pageIndex];

  const existingTextCount = page.elements.filter((el) =>
    el.id.startsWith(`${page.id}-text-`)
  ).length;

  const nextY =
    page.elements.length === 0
      ? 30
      : Math.max(
          ...page.elements.map((el) => el.position.y + el.size.height)
        ) + 20;

  const newElement: DocumentElement = {
    id: `${page.id}-text-${existingTextCount}`,
    type: "text",
    position: { x: 40, y: nextY },
    size: { width: 600, height: 60 },
    content,
  };

  return {
    ...document,
    pages: document.pages.map((p, index) =>
      index === pageIndex
        ? { ...p, elements: [...p.elements, newElement] }
        : p
    ),
  };

}

// STEP140: placeAssetはPage.elementsへの追加(applyAddTextと同じ
// パターン)。targetIdはPage idとして扱う(buildPlaceAssetOperation
// 参照)。changes.assetが存在しない、または対象Pageが存在しない
// 場合はDocument Modelを変更しない。決定的なID
// (`${pageId}-asset-${index}`)・決定的な配置(既存要素の一番下)を
// 用いる。
//
// 重要: ここでは既存のAssetReferenceをElementへ埋め込むだけで、
// 画像バイナリの取得・生成は一切行わない。
function applyPlaceAsset(
  document: DocumentModel,
  operation: DocumentOperation
): DocumentModel {

  const pageIndex = document.pages.findIndex(
    (page) => page.id === operation.targetId
  );

  if (pageIndex === -1) return document;

  const asset = operation.changes.asset as AssetReference | undefined;

  if (!asset) return document;

  const page = document.pages[pageIndex];

  const existingAssetCount = page.elements.filter((el) =>
    el.id.startsWith(`${page.id}-asset-`)
  ).length;

  const nextY =
    page.elements.length === 0
      ? 30
      : Math.max(
          ...page.elements.map((el) => el.position.y + el.size.height)
        ) + 20;

  const newElement: DocumentElement = {
    id: `${page.id}-asset-${existingAssetCount}`,
    type: assetTypeToElementType(asset.type),
    position: { x: 40, y: nextY },
    size: { width: 240, height: 160 },
    asset,
  };

  return {
    ...document,
    pages: document.pages.map((p, index) =>
      index === pageIndex
        ? { ...p, elements: [...p.elements, newElement] }
        : p
    ),
  };

}

// STEP46: deleteElementはPage.elementsからの削除(Element単位の
// フィールド更新では表現できない)。対象が存在しない場合は
// Document Modelを変更しない。
function applyDeleteElement(
  document: DocumentModel,
  operation: DocumentOperation
): DocumentModel {

  return {
    ...document,
    pages: document.pages.map((page) => {

      const hasTarget = page.elements.some(
        (el) => el.id === operation.targetId
      );

      if (!hasTarget) return page;

      return {
        ...page,
        elements: page.elements.filter(
          (el) => el.id !== operation.targetId
        ),
      };

    }),
  };

}

export function applyDocumentOperation(
  document: DocumentModel,
  operation: DocumentOperation
): DocumentModel {

  if (operation.type === "addText") {
    return applyAddText(document, operation);
  }

  if (operation.type === "deleteElement") {
    return applyDeleteElement(document, operation);
  }

  if (operation.type === "placeAsset") {
    return applyPlaceAsset(document, operation);
  }

  return {
    ...document,
    pages: document.pages.map((page) => {

      const hasTarget = page.elements.some(
        (el) => el.id === operation.targetId
      );

      if (!hasTarget) return page;

      return {
        ...page,
        elements: page.elements.map((el) =>
          el.id === operation.targetId
            ? applyChangesToElement(el, operation)
            : el
        ),
      };

    }),
  };

}
