// =========================
// parseContentBlocks (STEP31、STEP41で共有ファイルへ抽出)
// =========================
//
// section.content(ただの文字列)の中からMarkdown表
// (| 列 | 列 | ...|形式)を検出し、それ以外を通常テキストとして
// ブロック単位に分解する純粋関数。
//
// もともとcomponents/output/FinalOutput.tsx内に定義されていたが、
// STEP41でPowerPoint Export(components/output/buildOutputPptx.ts)
// からも同じ表検出ロジックを再利用するため、ロジックを変更せずに
// このファイルへ抽出した(FinalOutput.tsxの表示結果は変わらない)。

export interface ContentBlock {
  type: "table" | "text";
  headers?: string[];
  rows?: string[][];
  text?: string;
}

export function splitTableRow(line: string): string[] {

  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

}

// 区切り線(例: "| --- | --- |"や"|:--|--:|")かどうかを判定する。
export function isTableSeparatorLine(line: string): boolean {

  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");

}

export function parseContentBlocks(content: string): ContentBlock[] {

  const lines = content.split("\n");
  const blocks: ContentBlock[] = [];

  let textBuffer: string[] = [];

  function flushText() {

    const text = textBuffer.join("\n").trim();

    if (text) {
      blocks.push({ type: "text", text });
    }

    textBuffer = [];

  }

  let i = 0;

  while (i < lines.length) {

    const line = lines[i];
    const nextLine = lines[i + 1];

    const looksLikeTableStart =
      line.includes("|") &&
      typeof nextLine === "string" &&
      isTableSeparatorLine(nextLine);

    if (looksLikeTableStart) {

      flushText();

      const headers = splitTableRow(line);

      i += 2;

      const rows: string[][] = [];

      while (i < lines.length && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }

      blocks.push({ type: "table", headers, rows });

    } else {

      textBuffer.push(line);
      i++;

    }

  }

  flushText();

  return blocks;

}
