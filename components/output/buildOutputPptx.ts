// =========================
// buildOutputPptx (STEP41)
// =========================
//
// 目的: TACTの最終成果物(currentOutput)を、ユーザーがPowerPoint上で
// そのまま編集できる.pptxファイルへ変換する。
//
// 基本思想(TACT Designとの将来連携を見据えて):
// 「AIが完成品としてのPowerPointを生成する」のではなく、
// 「TACTが持つ構造化された成果物(title / sections[].heading /
// sections[].content 等)を、PowerPointという編集可能な形式へ
// そのまま変換する」ことに徹する。デザイン(配色・レイアウトの
// 作り込み)は行わない。テキストボックス・表として編集可能な
// 要素を出力することを優先する。
//
// artifactTypeの扱いについて:
// 現時点でcurrentOutput自体にはartifactType情報が含まれていない
// (Writer出力Schemaは変更していない。conversation_workflow_runs.
// outputsのJSONBには__artifactTypeスナップショット(STEP36)が
// 別途保存されているが、クライアント側のcurrentOutput stateには
// 渡っていない)。
// 新しいAPIフィールドを追加する代わりに、STEP31で確立済みの
// 「プレゼン成果物はsections[].headingが必ず"Slide N: "から
// 始まる」という既存の命名規約を使い、ここから機械的に
// artifactTypeを推定する。新しい構造情報の追加は最小限に留め、
// 既存の規約を再利用する。

import PptxGenJS from "pptxgenjs";
import { parseContentBlocks } from "./parseContentBlocks";

interface ExportableSection {
  heading?: unknown;
  content?: unknown;
}

interface ExportableOutput {
  title?: unknown;
  executiveSummary?: unknown;
  sections?: unknown;
  recommendations?: unknown;
  nextActions?: unknown;
}

const SLIDE_HEADING_PATTERN = /^Slide\s*\d+\s*[:：]\s*/i;

// STEP31のPresentation用スタイル指示(「・」「-」始まりの短い行を
// 改行で並べる)を前提に、本文を「箇条書き行」と「通常の段落」へ
// 分ける。表(parseContentBlocksが検出したtable)はそのまま尊重する。
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

// 1つのcontent(section.content文字列)を、そのスライドへ
// 追加すべき本文要素(テキストボックス・表)としてpptxgenjsの
// スライドへ書き込む。デザインの作り込みはせず、編集可能な
// テキスト/表として配置することだけを目的にする。
function addContentToSlide(
  slide: PptxGenJS.Slide,
  content: string,
  startY: number
): void {

  const blocks = parseContentBlocks(content);

  let y = startY;

  for (const block of blocks) {

    if (block.type === "table" && block.headers) {

      const rows: PptxGenJS.TableRow[] = [

        block.headers.map((header) => ({
          text: header,
          options: { bold: true, fill: { color: "F3F4F6" } },
        })),

        ...(block.rows ?? []).map((row) =>
          row.map((cell) => ({ text: cell }))
        ),

      ];

      slide.addTable(rows, {
        x: 0.5,
        y,
        w: 9,
        fontSize: 12,
        border: { type: "solid", color: "D1D5DB", pt: 0.5 },
        autoPage: false,
      });

      // 表の高さは行数からの概算(編集可能性を優先し、
      // 厳密な高さ計算はしない)。
      y += 0.4 * (1 + (block.rows?.length ?? 0));

    } else if (block.type === "text" && block.text) {

      const { bullets, paragraphs } = splitBulletLines(block.text);

      if (paragraphs.length > 0) {

        slide.addText(paragraphs.join("\n"), {
          x: 0.5,
          y,
          w: 9,
          fontSize: 14,
          color: "374151",
          valign: "top",
        });

        y += 0.3 * paragraphs.length + 0.2;

      }

      if (bullets.length > 0) {

        slide.addText(
          bullets.map((b) => ({
            text: b,
            options: { bullet: true, breakLine: true },
          })),
          {
            x: 0.5,
            y,
            w: 9,
            fontSize: 14,
            color: "374151",
            valign: "top",
          }
        );

        y += 0.35 * bullets.length + 0.2;

      }

    }

  }

}

function addBulletSlide(
  pptx: PptxGenJS,
  title: string,
  items: string[]
): void {

  if (items.length === 0) return;

  const slide = pptx.addSlide();

  slide.addText(title, {
    x: 0.5,
    y: 0.3,
    w: 9,
    fontSize: 24,
    bold: true,
    color: "111827",
  });

  slide.addText(
    items.map((item) => ({
      text: item,
      options: { bullet: true, breakLine: true },
    })),
    {
      x: 0.5,
      y: 1.1,
      w: 9,
      h: 5,
      fontSize: 14,
      color: "374151",
      valign: "top",
    }
  );

}

// recommendations / nextActionsは文字列 or {title, description}形式の
// どちらもあり得る(components/output/formatOutputText.tsと同じ前提)。
function renderTextItemPlain(item: unknown): string {

  if (typeof item === "string") return item;

  if (item && typeof item === "object") {

    const obj = item as { title?: unknown; description?: unknown };

    const title = typeof obj.title === "string" ? obj.title : "";

    const description =
      typeof obj.description === "string" ? obj.description : "";

    if (title && description) return `${title}：${description}`;

    return title || description;

  }

  return "";

}

export async function buildOutputPptx(
  result: unknown
): Promise<Blob> {

  const output =
    result && typeof result === "object"
      ? (result as ExportableOutput)
      : {};

  const sections: ExportableSection[] =
    Array.isArray(output.sections)
      ? (output.sections as ExportableSection[])
      : [];

  const title =
    typeof output.title === "string" && output.title.trim()
      ? output.title.trim()
      : "TACT Output";

  // STEP31の命名規約(Slide N: ...)に一致する見出しが過半数を
  // 占める場合のみ、Presentation成果物として扱う。
  const slideHeadingCount = sections.filter(
    (s) =>
      typeof s.heading === "string" &&
      SLIDE_HEADING_PATTERN.test(s.heading)
  ).length;

  const isPresentation =
    sections.length > 0 &&
    slideHeadingCount >= Math.ceil(sections.length / 2);

  const pptx = new PptxGenJS();

  pptx.defineLayout({ name: "TACT_16x9", width: 10, height: 5.63 });
  pptx.layout = "TACT_16x9";

  if (!isPresentation) {

    // Report/Comparison/Proposal: タイトルスライドを1枚追加する。
    const titleSlide = pptx.addSlide();

    titleSlide.addText(title, {
      x: 0.5,
      y: 2.0,
      w: 9,
      fontSize: 32,
      bold: true,
      align: "center",
      color: "111827",
    });

    if (
      typeof output.executiveSummary === "string" &&
      output.executiveSummary.trim()
    ) {

      titleSlide.addText(output.executiveSummary.trim(), {
        x: 1,
        y: 3.2,
        w: 8,
        fontSize: 14,
        align: "center",
        color: "6B7280",
      });

    }

  }

  for (const section of sections) {

    const rawHeading =
      typeof section.heading === "string" ? section.heading : "";

    const heading = isPresentation
      ? rawHeading.replace(SLIDE_HEADING_PATTERN, "")
      : rawHeading;

    const content =
      typeof section.content === "string" ? section.content : "";

    if (!heading && !content) continue;

    const slide = pptx.addSlide();

    slide.addText(heading || "(見出しなし)", {
      x: 0.5,
      y: 0.3,
      w: 9,
      fontSize: 22,
      bold: true,
      color: "111827",
    });

    if (content) {
      addContentToSlide(slide, content, 1.1);
    }

  }

  // Report/Comparison/Proposal(Presentation以外)の場合のみ、
  // recommendations/nextActionsが存在すれば追加のスライドとして
  // 出力する(Presentationは既にsections[]に必要な要点が
  // Slide単位で含まれているため対象外)。
  if (!isPresentation) {

    if (Array.isArray(output.recommendations)) {

      const items = output.recommendations
        .map(renderTextItemPlain)
        .filter((t) => t.trim().length > 0);

      addBulletSlide(pptx, "Recommendations", items);

    }

    if (Array.isArray(output.nextActions)) {

      const items = output.nextActions
        .map(renderTextItemPlain)
        .filter((t) => t.trim().length > 0);

      addBulletSlide(pptx, "Next Actions", items);

    }

  }

  const blob = await pptx.write({ outputType: "blob" });

  return blob as Blob;

}

// =========================
// buildOutputPptxFilename
// =========================
//
// components/output/formatOutputText.tsのbuildOutputFilename()と
// 同じ考え方(titleから安全なファイル名を組み立てる)。

export function buildOutputPptxFilename(
  result: unknown
): string {

  const output =
    result && typeof result === "object"
      ? (result as ExportableOutput)
      : null;

  const rawTitle =
    output && typeof output.title === "string" ? output.title : "";

  const sanitized = rawTitle
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 60);

  return `${sanitized || "tact-output"}.pptx`;

}
