// =========================
// formatOutputText (STEP23)
// =========================
//
// 目的: 「生成された成果物をユーザーがそのまま仕事に持ち出せる」ように、
// 現在の成果物(currentOutput)を、コピー/ダウンロード用のMarkdownテキストへ
// 変換する。
//
// 重要:
// - ここで受け取るresultは、Writerの生出力ではなく、
//   Conversation層(reconcileCurrentOutput()等)を経た「最終的な
//   currentOutput」であることを前提にする。呼び出し元
//   (OutputViewer.tsx)は、画面表示に使っているものと同じ
//   result(state)をそのまま渡すこと。
// - evidenceIds等の内部管理情報はユーザー向けコピー結果に含めない。
// - 既存のWriter出力Schema(outputFormats.ts)を変更するものではなく、
//   表示専用の変換を行うだけの純粋関数。

// FinalOutput.tsxのrenderTextItem()と同じ「文字列 or {title,description}」
// という2つの形をどちらも安全に扱うための、テキスト専用版。
// JSXを持たないため、Markdown化に使う。
function renderTextItemPlain(item: unknown): string {

  if (typeof item === "string") {
    return item;
  }

  if (item && typeof item === "object") {

    const obj = item as {
      title?: unknown;
      description?: unknown;
      summary?: unknown;
    };

    const title =
      typeof obj.title === "string" ? obj.title : "";

    const description =
      typeof obj.description === "string"
        ? obj.description
        : typeof obj.summary === "string"
          ? obj.summary
          : "";

    if (title && description) {
      return `${title}：${description}`;
    }

    return title || description;

  }

  return "";

}

interface ExportableSection {
  heading?: unknown;
  content?: unknown;
}

interface ExportableKeyFinding {
  title?: unknown;
  description?: unknown;
  summary?: unknown;
}

interface ExportableOutput {
  title?: unknown;
  executiveSummary?: unknown;
  keyFindings?: unknown;
  sections?: unknown;
  recommendations?: unknown;
  nextActions?: unknown;
}

// =========================
// buildOutputMarkdown
// =========================
//
// currentOutputを、そのまま文章として使えるMarkdown文字列へ変換する。
// title / executiveSummary / keyFindings / sections / recommendations /
// nextActions のうち、実際に存在するものだけを順番に組み立てる
// (存在しない項目を作り出さない)。

export function buildOutputMarkdown(
  result: unknown
): string {

  if (!result || typeof result !== "object") {
    return "";
  }

  const output = result as ExportableOutput;

  const parts: string[] = [];

  if (
    typeof output.title === "string" &&
    output.title.trim()
  ) {
    parts.push(`# ${output.title.trim()}`);
  }

  if (
    typeof output.executiveSummary === "string" &&
    output.executiveSummary.trim()
  ) {
    parts.push(output.executiveSummary.trim());
  }

  if (
    Array.isArray(output.keyFindings) &&
    output.keyFindings.length > 0
  ) {

    const lines = ["## Key Findings"];

    output.keyFindings.forEach((item) => {

      if (!item || typeof item !== "object") return;

      const finding = item as ExportableKeyFinding;

      const title =
        typeof finding.title === "string"
          ? finding.title
          : "";

      const description =
        typeof finding.description === "string"
          ? finding.description
          : typeof finding.summary === "string"
            ? finding.summary
            : "";

      if (title || description) {

        lines.push(
          title
            ? `- **${title}**${description ? `：${description}` : ""}`
            : `- ${description}`
        );

      }

    });

    if (lines.length > 1) {
      parts.push(lines.join("\n"));
    }

  }

  if (Array.isArray(output.sections)) {

    output.sections.forEach((section) => {

      if (!section || typeof section !== "object") return;

      const s = section as ExportableSection;

      const heading =
        typeof s.heading === "string" ? s.heading.trim() : "";

      const content =
        typeof s.content === "string" ? s.content.trim() : "";

      if (!heading && !content) return;

      parts.push(
        `## ${heading || "(見出しなし)"}\n\n${content}`
      );

    });

  }

  if (
    Array.isArray(output.recommendations) &&
    output.recommendations.length > 0
  ) {

    const lines = ["## Recommendations"];

    output.recommendations.forEach((item) => {

      const text = renderTextItemPlain(item);

      if (text) lines.push(`- ${text}`);

    });

    if (lines.length > 1) {
      parts.push(lines.join("\n"));
    }

  }

  if (
    Array.isArray(output.nextActions) &&
    output.nextActions.length > 0
  ) {

    const lines = ["## Next Actions"];

    output.nextActions.forEach((item, index) => {

      const text = renderTextItemPlain(item);

      if (text) lines.push(`${index + 1}. ${text}`);

    });

    if (lines.length > 1) {
      parts.push(lines.join("\n"));
    }

  }

  return parts.join("\n\n") + "\n";

}

// =========================
// buildOutputFilename
// =========================
//
// ダウンロード用のファイル名を、成果物のtitleから安全に組み立てる。
// titleが無い/使えない場合は"tact-output"にfallbackする。

export function buildOutputFilename(
  result: unknown
): string {

  const output =
    result && typeof result === "object"
      ? (result as ExportableOutput)
      : null;

  const rawTitle =
    output && typeof output.title === "string"
      ? output.title
      : "";

  const sanitized = rawTitle
    // ファイル名に使えない文字だけを除去する(内容自体は変えない)。
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 60);

  return `${sanitized || "tact-output"}.md`;

}
