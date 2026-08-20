// =========================
// currentOutputToDocumentModel (STEP44)
// =========================
//
// TACT本体の成果物(currentOutput)を、TACT Designの正規モデルである
// DocumentModelへ変換する、純粋なAdapter関数。
//
//   currentOutput ── Adapter(このファイル) ──▶ DocumentModel
//
// 設計方針:
// - TACT Design(components/design/*)からcore/*を直接importしない
//   という既存方針を維持する。currentOutputはWriterの出力Schema
//   (core/prompt/outputFormats.ts)通りの形を期待するが、この
//   ファイルはその型を直接importせず、components/output/
//   buildOutputPptx.tsと同じ考え方(unknownとして受け取り、緩やかな
//   shapeガードだけで安全に読み取る)で扱う。currentOutput自体は
//   一切変更しない(読み取り専用)。
// - Markdown表・箇条書きの検出は、既存のparseContentBlocks()
//   (components/output/parseContentBlocks.ts)をそのまま再利用する。
//   このファイルはpptxgenjs等の重い依存を持たない純粋関数のみで
//   構成されているため、importしてもTACT Design側に余計な依存を
//   持ち込まない。
// - artifactTypeは新しいAPIフィールドとして公開しない。STEP31/
//   STEP41で確立済みの「プレゼン成果物はsections[].headingが
//   "Slide N: "から始まる」という既存命名規約を、
//   buildOutputPptx.tsと同じロジックでこのファイル内に複製する
//   (pptxgenjsに依存するbuildOutputPptx.tsを本Adapterからimportする
//   と、Adapter自体が重いレンダリングライブラリに巻き込まれてしまう
//   ため、意図的に小さな判定ロジックだけを複製した)。
// - 決定性: 入力が同じであれば、常に同じDocumentModelを返す純粋
//   関数にする。crypto.randomUUID()等のランダムID生成は使わず、
//   Document/Page/Elementのidはすべて入力中の位置(index)から
//   決定的に組み立てる。
// - 位置(position)・サイズ(size)は、実際のレイアウトエンジンを
//   まだ持たないため、単純な縦積みの仮配置(プレースホルダー)に
//   留める。将来Rendererが実装される際に置き換えられる想定。
//
// STEP59: STEP57〜58でDocumentRenderer.tsxがkeyFindings/
// recommendations/nextActionsのlist itemを「タイトル1行+説明1行以上」
// のブロック表示へ変更したのに対し、このAdapterのheight見積もりが
// 「1item=1行(LIST_ITEM_HEIGHT)」のまま更新されておらず、見積もり
// heightが実際の描画heightを下回るケースがあった(絶対配置のため、
// 後続Elementと視覚的に重なるリスクがあった)。makeListElement()に
// estimateListItemHeight()を追加し、「タイトル：説明」へ安全に
// 分割できるitem(かつそのroleが対象)についてのみ、タイトル行数+
// 説明行数を文字数から粗く見積もった高さを使うようにした。
// 分割できない/対象外のitemは従来通り1行相当のまま(要件Bを維持)。
// 文字幅の正確な計算(実際のフォントレンダリング)はせず、
// 「ピクセル完全一致」ではなく「重なりにくい安全側の見積もり」を
// 目的とした保守的な文字数ベースの概算に留めた(要件D)。
//
// STEP60: STEP59はkeyFindings/recommendations/nextActions
// (title/description分割の対象role)にしか折り返し行数を反映して
// いなかった。role未設定の通常list(section本文の箇条書き・
// Presentation由来の箇条書き)は依然「1item=1行」固定のままで、
// 長いitemがあると同じ重なりリスクが残っていた。
// estimateListItemHeight()を拡張し、title/description分割が
// 使えない(=通常の)itemについても、item全体をestimateWrappedLine
// Count()にかけて折り返し行数を見積もるようにした。通常listは
// Renderer側でも「タイトル/説明」への分割表示をしない(Renderer側の
// 表示は無変更)ため、Adapter側もitem全体を1つの文として扱う
// (title/description分割は行わない)。また、極端に長い1item(異常
// 入力)でheightが際限なく肥大化しないよう、折り返し行数に上限
// (MAX_ESTIMATED_LINES_PER_ITEM)を設けた。

import { parseContentBlocks } from "@/components/output/parseContentBlocks";
import {
  DocumentElement,
  DocumentElementRole,
  DocumentModel,
  DocumentPage,
  DocumentTextSegment,
} from "./types";
import { canSplitItemTitle, splitItemTitle } from "./itemTitleSplit";

// =========================
// 入力のshapeガード
// =========================
//
// buildOutputPptx.tsのExportableOutput/ExportableSectionと同じ
// 考え方(currentOutputは`any`で扱われている実装のため、unknownとして
// 受け取り、必要な箇所だけ緩やかに型を絞る)。

interface SourceSection {
  heading?: unknown;
  content?: unknown;
}

interface SourceOutput {
  title?: unknown;
  executiveSummary?: unknown;
  sections?: unknown;
  keyFindings?: unknown;
  recommendations?: unknown;
  nextActions?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// recommendations / nextActionsは文字列 or {title, description}形式の
// どちらもあり得る(buildOutputPptx.tsのrenderTextItemPlainと同じ前提)。
function renderTextItemPlain(item: unknown): string {

  if (typeof item === "string") return item.trim();

  if (item && typeof item === "object") {

    const obj = item as { title?: unknown; description?: unknown };

    const title = asString(obj.title);
    const description = asString(obj.description);

    if (title && description) return `${title}：${description}`;

    return title || description;

  }

  return "";

}

// keyFindingsは{title, importance, summary}形式(core/prompt/
// outputFormats.tsのwriter出力Schema参照)。
function renderKeyFinding(item: unknown): string {

  if (!item || typeof item !== "object") return "";

  const obj = item as { title?: unknown; summary?: unknown };

  const title = asString(obj.title);
  const summary = asString(obj.summary);

  if (title && summary) return `${title}：${summary}`;

  return title || summary;

}

// =========================
// Presentation判定
// =========================
//
// buildOutputPptx.tsと同一のロジック(意図的な複製。理由は冒頭コメント
// 参照)。

const SLIDE_HEADING_PATTERN = /^Slide\s*\d+\s*[:：]\s*/i;

function detectIsPresentation(sections: SourceSection[]): boolean {

  const slideHeadingCount = sections.filter((s) =>
    SLIDE_HEADING_PATTERN.test(asString(s.heading))
  ).length;

  return (
    sections.length > 0 &&
    slideHeadingCount >= Math.ceil(sections.length / 2)
  );

}

// =========================
// 箇条書き判定
// =========================
//
// buildOutputPptx.tsのsplitBulletLinesと同一のロジック(意図的な複製。
// 理由は冒頭コメント参照)。

const BULLET_LINE_PATTERN = /^\s*[・\-*]\s*/;

function splitBulletLines(
  text: string
): { bullets: string[]; paragraphs: string[] } {

  const lines = text.split("\n");

  const bullets: string[] = [];
  const paragraphs: string[] = [];

  for (const line of lines) {

    const trimmed = line.trim();

    if (!trimmed) continue;

    if (BULLET_LINE_PATTERN.test(trimmed)) {
      bullets.push(trimmed.replace(BULLET_LINE_PATTERN, ""));
    } else {
      paragraphs.push(trimmed);
    }

  }

  return { bullets, paragraphs };

}

// =========================
// 部分強調(Emphasis Segments)の検出 (STEP55)
// =========================
//
// **強調テキスト** というMarkdown風の強調記法を検出し、部分文字列
// 単位のsegmentsへ変換する。Writerのsystem prompt(core/agents/
// writer.ts)には一切手を加えていない(=新しい生成指示は追加しない)。
// あくまでWriterが結果的に**を使った場合にのみ機能する、既存出力
// からの抽出処理にすぎない。見つからない場合はundefinedを返し、
// 呼び出し側は従来どおりcontentのみで描画する(完全な後方互換)。
//
// 意図的にスコープを絞っている: 太字/非太字の2値のみを表現し、
// 色・下線・複数のスタイル軸を持つ本格的なRich Textスキーマは
// 実装しない(STEP55の設計境界)。

const EMPHASIS_PATTERN = /\*\*(.+?)\*\*/g;

function parseEmphasisSegments(
  text: string
): DocumentTextSegment[] | undefined {

  if (!text.includes("**")) return undefined;

  const segments: DocumentTextSegment[] = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  EMPHASIS_PATTERN.lastIndex = 0;

  while ((match = EMPHASIS_PATTERN.exec(text)) !== null) {

    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      segments.push({ text: match[1], emphasize: true });
    }

    lastIndex = EMPHASIS_PATTERN.lastIndex;

  }

  // "**"を含んでいても、実際には閉じられていない等でマッチしな
  // かった場合はsegmentsが空のまま。この場合は通常のcontentとして
  // 扱う(安全側)。
  if (segments.length === 0) return undefined;

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }

  return segments;

}

// =========================
// 仮レイアウト(縦積み配置)
// =========================
//
// 実際のレイアウトエンジンは今回実装しない。1ページ内で要素を
// 上から下へ順に積むだけの、決定的なプレースホルダー配置。

const PAGE_ELEMENT_WIDTH = 600;
const MARGIN_X = 40;
const START_Y = 30;
const GAP_Y = 20;

const TITLE_HEIGHT = 60;
const HEADING_HEIGHT = 44;
const TEXT_LINE_HEIGHT = 20;
const LIST_ITEM_HEIGHT = 24;
const TABLE_ROW_HEIGHT = 32;

// ページ内でのY座標を決定的に進めるだけの小さなカーソル。
class LayoutCursor {

  private y = START_Y;

  next(height: number): number {
    const y = this.y;
    this.y += height + GAP_Y;
    return y;
  }

}

// =========================
// list itemのheight見積もり (STEP59)
// =========================
//
// DocumentRenderer.tsx(STEP57)は、「タイトル：説明」へ安全に分割
// できるlist item(keyFindings/recommendations/nextActions)を
// 「タイトル1行+説明1行以上」のブロックとして描画するが、この
// Adapterのheight見積もりは従来「1item=1行(LIST_ITEM_HEIGHT)」の
// ままだった。ここでは、文字数からごく粗く折り返し行数を見積もり、
// 実際の描画heightを下回りにくい(=後続Elementと重なりにくい)
// 保守的なheightを計算する。
//
// 目的は「ピクセル完全一致」ではない。ブラウザの実際のフォント
// レンダリング幅を計算する本格的なレイアウトエンジンは作らず、
// 「安全側(やや大きめ)に倒す」ことだけを優先した簡易な概算とする。

// PAGE_ELEMENT_WIDTH(600px)・list左padding(1.25em)・text-xsの
// フォントサイズを踏まえた、1行あたりの文字数のごく粗い見積もり。
// 全角文字を基準に、安全側(小さめ)の値にしている
// (実際より小さく見積もる = 行数を多めに見積もる = heightを
// 大きめに見積もる、という安全側の方向)。
const ESTIMATED_CHARS_PER_LINE = 38;

// STEP57のtitle/descriptionの縦積み表示における、両者の間の
// margin(mt-1)や行間の余裕を吸収するための追加バッファ。
const LIST_ITEM_TITLE_DESCRIPTION_GAP = 6;

// STEP60: 異常に長い1item(想定外の入力)によってheightが際限なく
// 肥大化しないための、折り返し行数の上限。実際のTACT出力で想定
// されるitem長(数十〜数百文字程度)は十分カバーしつつ
// (20行×38文字=760文字相当まではそのまま反映される)、それを
// 超える極端なケースでは頭打ちにする。
const MAX_ESTIMATED_LINES_PER_ITEM = 20;

// 「文字列がおよそ何行に折り返されるか」を概算する、role非依存の
// 汎用ユーティリティ。ブラウザの実際のフォントレンダリング幅は
// 計算しない(ピクセル完全一致は目指さない)。keyFindings等の
// title/description分割にも、通常listのitem全体にも、同じ関数を
// 使う(STEP60で汎用化)。
function estimateWrappedLineCount(text: string): number {

  if (typeof text !== "string" || !text) return 1;

  const rawLines = Math.ceil(text.length / ESTIMATED_CHARS_PER_LINE);

  return Math.min(MAX_ESTIMATED_LINES_PER_ITEM, Math.max(1, rawLines));

}

// 1つのlist itemの見積もりheightを返す。
// - 「タイトル：説明」へ安全に分割できる場合(keyFindings/
//   recommendations/nextActions)は、タイトル行数+説明行数から
//   計算する(STEP59、要件E/5)。
// - それ以外(role未設定の通常list、またはsplitに失敗したitem)は、
//   STEP60でitem全体の折り返し行数を見積もるようにした。通常listは
//   Renderer側でもtitle/description分割をしない(item全体を1つの
//   本文として表示する)ため、Adapter側も同じくitem全体を1つの
//   文字列として扱う(要件1〜4)。
function estimateListItemHeight(
  item: string,
  role: DocumentElementRole | undefined
): number {

  if (canSplitItemTitle(role)) {

    const split = splitItemTitle(item);

    if (split) {

      const titleLines = estimateWrappedLineCount(split.title);
      const descriptionLines = estimateWrappedLineCount(split.rest);

      return (
        LIST_ITEM_HEIGHT * (titleLines + descriptionLines) +
        LIST_ITEM_TITLE_DESCRIPTION_GAP
      );

    }

  }

  return LIST_ITEM_HEIGHT * estimateWrappedLineCount(item);

}

function makeTextElement(
  pageId: string,
  kindLabel: string,
  index: number,
  text: string,
  cursor: LayoutCursor,
  height: number,
  style?: Record<string, unknown>,
  // STEP55で追加。「このtext要素は何か」を表す意味タグ
  // (title/heading/summary)。未指定の場合は本文扱い。
  role?: DocumentElementRole
): DocumentElement {

  const segments = parseEmphasisSegments(text);

  // segmentsを使う場合、contentは強調記号(**)を含まないプレーン
  // テキストにしておく(既存コード(mockDesignAgent.ts等)が
  // content単体を参照した際に**記号がそのまま見えてしまわない
  // ようにするため)。
  const plainText = segments
    ? segments.map((s) => s.text).join("")
    : text;

  return {
    id: `${pageId}-${kindLabel}-${index}`,
    type: "text",
    position: { x: MARGIN_X, y: cursor.next(height) },
    size: { width: PAGE_ELEMENT_WIDTH, height },
    content: plainText,
    segments,
    role,
    style,
  };

}

function makeListElement(
  pageId: string,
  index: number,
  items: string[],
  cursor: LayoutCursor,
  // STEP55で追加。「このlist要素は何のリストか」を表す意味タグ
  // (keyFindings/recommendations/nextActions)。section本文由来の
  // 箇条書きの場合は未指定(通常の箇条書き扱い)。
  role?: DocumentElementRole
): DocumentElement {

  // STEP59: 従来は「LIST_ITEM_HEIGHT × items.length」という
  // 1item=1行の一律計算だったが、「タイトル：説明」へ分割される
  // itemは2行以上になるため、item単位で見積もりを行う。
  const height =
    items.reduce(
      (sum, item) => sum + estimateListItemHeight(item, role),
      0
    ) + 10;

  return {
    id: `${pageId}-list-${index}`,
    type: "list",
    position: { x: MARGIN_X, y: cursor.next(height) },
    size: { width: PAGE_ELEMENT_WIDTH, height },
    items,
    role,
  };

}

function makeTableElement(
  pageId: string,
  index: number,
  headers: string[],
  rows: string[][],
  cursor: LayoutCursor
): DocumentElement {

  const height = TABLE_ROW_HEIGHT * (1 + rows.length);

  return {
    id: `${pageId}-table-${index}`,
    type: "table",
    position: { x: MARGIN_X, y: cursor.next(height) },
    size: { width: PAGE_ELEMENT_WIDTH, height },
    tableData: { headers, rows },
  };

}

// section.content(自由記述の文字列)を、parseContentBlocks()で
// table/textブロックへ分解し、それぞれDocumentElementへ変換する。
// buildOutputPptx.tsのaddContentToSlide()と同じ考え方
// (表・箇条書き・段落を区別して配置する)だが、pptxgenjsのSlide
// APIではなくDocumentElement[]を組み立てる点だけが異なる。
function contentToElements(
  pageId: string,
  content: string,
  cursor: LayoutCursor
): DocumentElement[] {

  const elements: DocumentElement[] = [];

  let textIndex = 0;
  let listIndex = 0;
  let tableIndex = 0;

  for (const block of parseContentBlocks(content)) {

    if (block.type === "table" && block.headers) {

      elements.push(
        makeTableElement(
          pageId,
          tableIndex++,
          block.headers,
          block.rows ?? [],
          cursor
        )
      );

    } else if (block.type === "text" && block.text) {

      const { bullets, paragraphs } = splitBulletLines(block.text);

      if (paragraphs.length > 0) {

        const text = paragraphs.join("\n");

        elements.push(
          makeTextElement(
            pageId,
            "text",
            textIndex++,
            text,
            cursor,
            TEXT_LINE_HEIGHT * paragraphs.length + 20
          )
        );

      }

      if (bullets.length > 0) {

        elements.push(
          makeListElement(pageId, listIndex++, bullets, cursor)
        );

      }

    }

  }

  return elements;

}

// 見出し + 箇条書きだけの単純なページを組み立てる
// (recommendations / nextActions / keyFindings用)。
// STEP55: listRoleを受け取り、Rendererが項目の種類(重要な発見/
// 提案/次のアクション)を視覚的に区別できるようにする。
function makeBulletPage(
  index: number,
  heading: string,
  items: string[],
  listRole: DocumentElementRole
): DocumentPage {

  const pageId = `page-${index}`;
  const cursor = new LayoutCursor();

  const elements: DocumentElement[] = [
    makeTextElement(
      pageId, "heading", 0, heading, cursor, HEADING_HEIGHT,
      { fontSize: 20, fontWeight: "bold" },
      "heading"
    ),
    makeListElement(pageId, 0, items, cursor, listRole),
  ];

  return { id: pageId, index, elements };

}

// =========================
// currentOutputToDocumentModel
// =========================
//
// 入力(currentOutput)が空・不完全であってもクラッシュしない
// (STEP44 CASE E)。存在しない/型が違うフィールドは無視するだけで、
// 例外は投げない。

export function currentOutputToDocumentModel(
  currentOutput: unknown
): DocumentModel {

  const output: SourceOutput =
    currentOutput && typeof currentOutput === "object"
      ? (currentOutput as SourceOutput)
      : {};

  const rawTitle = asString(output.title);
  const executiveSummary = asString(output.executiveSummary);

  const sections: SourceSection[] = Array.isArray(output.sections)
    ? output.sections.filter(
        (s): s is SourceSection => !!s && typeof s === "object"
      )
    : [];

  const isPresentation = detectIsPresentation(sections);

  const pages: DocumentPage[] = [];
  let pageIndex = 0;

  // Presentation以外は、タイトル+要約だけの表紙ページを先頭に置く
  // (buildOutputPptx.tsのタイトルスライドと同じ考え方)。
  if (!isPresentation && (rawTitle || executiveSummary)) {

    const pageId = `page-${pageIndex}`;
    const cursor = new LayoutCursor();
    const elements: DocumentElement[] = [];

    if (rawTitle) {
      elements.push(
        makeTextElement(
          pageId, "title", 0, rawTitle, cursor, TITLE_HEIGHT,
          { fontSize: 32, fontWeight: "bold" },
          "title"
        )
      );
    }

    if (executiveSummary) {
      elements.push(
        makeTextElement(
          pageId,
          "text",
          0,
          executiveSummary,
          cursor,
          TEXT_LINE_HEIGHT * executiveSummary.split("\n").length + 20,
          // STEP55: 本文と区別できるよう、斜体+roleタグを付ける
          // (Rendererが背景色・左枠線等で「要約」であることを示す)。
          { fontStyle: "italic" },
          "summary"
        )
      );
    }

    pages.push({ id: pageId, index: pageIndex, elements });
    pageIndex++;

  }

  // sections[] → 1 section = 1 Page(buildOutputPptx.tsの
  // 「1 section = 1 slide」規約をそのまま踏襲する)。
  for (const section of sections) {

    const rawHeading = asString(section.heading);

    const heading = isPresentation
      ? rawHeading.replace(SLIDE_HEADING_PATTERN, "")
      : rawHeading;

    const content = asString(section.content);

    if (!heading && !content) continue;

    const pageId = `page-${pageIndex}`;
    const cursor = new LayoutCursor();
    const elements: DocumentElement[] = [];

    if (heading) {
      elements.push(
        makeTextElement(
          pageId, "title", 0, heading, cursor, TITLE_HEIGHT,
          { fontSize: 22, fontWeight: "bold" },
          "heading"
        )
      );
    }

    if (content) {
      elements.push(...contentToElements(pageId, content, cursor));
    }

    pages.push({ id: pageId, index: pageIndex, elements });
    pageIndex++;

  }

  // Presentation以外の場合のみ、keyFindings/recommendations/
  // nextActionsを追加ページとして出力する(Presentationは既に
  // sections[]にSlide単位の要点が含まれているため対象外。
  // buildOutputPptx.tsと同じ判断)。
  if (!isPresentation) {

    const keyFindings = Array.isArray(output.keyFindings)
      ? output.keyFindings.map(renderKeyFinding).filter((t) => t.length > 0)
      : [];

    if (keyFindings.length > 0) {
      pages.push(
        makeBulletPage(pageIndex++, "Key Findings", keyFindings, "keyFindings")
      );
    }

    const recommendations = Array.isArray(output.recommendations)
      ? output.recommendations
          .map(renderTextItemPlain)
          .filter((t) => t.length > 0)
      : [];

    if (recommendations.length > 0) {
      pages.push(
        makeBulletPage(
          pageIndex++, "Recommendations", recommendations, "recommendations"
        )
      );
    }

    const nextActions = Array.isArray(output.nextActions)
      ? output.nextActions
          .map(renderTextItemPlain)
          .filter((t) => t.length > 0)
      : [];

    if (nextActions.length > 0) {
      pages.push(
        makeBulletPage(pageIndex++, "Next Actions", nextActions, "nextActions")
      );
    }

  }

  return {
    id: "document",
    title: rawTitle || "Untitled Document",
    pages,
  };

}
