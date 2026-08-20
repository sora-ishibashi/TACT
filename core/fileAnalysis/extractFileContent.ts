// =========================
// extractFileContent (STEP32)
// =========================
//
// ユーザーがチャットに添付したファイル(PDF/Word/Excel/PowerPoint)から
// テキストを抽出するだけの、独立したモジュール。
// core/workflow・core/agents・core/conversationのいずれにも依存しない
// (=既存Workflow/Agentの責務には一切関与しない)。
//
// 画像(PNG/JPG/JPEG/WEBP)はここでは扱わない
// (describeImage.tsでOpenAIのVision機能を使って説明文を生成する)。
//
// 抽出できなかった場合は空文字列を返さず、明示的にsuccess:falseと
// エラー理由を返す(呼び出し元がユーザーへ正直にエラー表示するため)。

import mammoth from "mammoth";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { PDFParse } from "pdf-parse";

export interface ExtractResult {
  success: boolean;
  text?: string;
  error?: string;
}

const DOCUMENT_EXTENSIONS = ["pdf", "docx", "xlsx", "pptx"] as const;
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

export function getFileExtension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

export function isSupportedFile(fileName: string): boolean {

  const ext = getFileExtension(fileName);

  return (
    (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext) ||
    (IMAGE_EXTENSIONS as readonly string[]).includes(ext)
  );

}

export function isImageFile(fileName: string): boolean {

  const ext = getFileExtension(fileName);

  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);

}

// PPTXのXML内に現れるXMLエンティティを最小限デコードする
// (フルXMLパーサーは使わず、テキスト抽出に必要な範囲のみ)。
function decodeXmlEntities(text: string): string {

  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

}

async function extractPdf(buffer: Buffer): Promise<ExtractResult> {

  const parser = new PDFParse({ data: buffer });

  try {

    const result = await parser.getText();

    const text = result.text?.trim() ?? "";

    if (!text) {

      return {
        success: false,
        error:
          "PDFからテキストを抽出できませんでした" +
          "(画像のみのPDF、またはスキャンPDFの可能性があります)",
      };

    }

    return { success: true, text };

  } finally {

    await parser.destroy();

  }

}

async function extractDocx(buffer: Buffer): Promise<ExtractResult> {

  const result = await mammoth.extractRawText({ buffer });

  const text = result.value?.trim() ?? "";

  if (!text) {

    return {
      success: false,
      error: "Word文書からテキストを抽出できませんでした",
    };

  }

  return { success: true, text };

}

function extractXlsx(buffer: Buffer): ExtractResult {

  const workbook = XLSX.read(buffer, { type: "buffer" });

  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {

    const sheet = workbook.Sheets[sheetName];

    const csv = XLSX.utils.sheet_to_csv(sheet).trim();

    if (csv) {
      parts.push(`[シート: ${sheetName}]\n${csv}`);
    }

  }

  const text = parts.join("\n\n");

  if (!text) {

    return {
      success: false,
      error: "Excelファイルからデータを抽出できませんでした",
    };

  }

  return { success: true, text };

}

async function extractPptx(buffer: Buffer): Promise<ExtractResult> {

  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {

      const numA = Number(a.match(/slide(\d+)\.xml/)?.[1] ?? "0");
      const numB = Number(b.match(/slide(\d+)\.xml/)?.[1] ?? "0");

      return numA - numB;

    });

  const parts: string[] = [];

  for (const slideFile of slideFiles) {

    const xml = await zip.files[slideFile].async("text");

    const texts = Array.from(
      xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)
    ).map((match) => decodeXmlEntities(match[1]));

    if (texts.length > 0) {

      const slideNumber =
        slideFile.match(/slide(\d+)\.xml/)?.[1] ?? "?";

      parts.push(
        `[Slide ${slideNumber}]\n${texts.join("\n")}`
      );

    }

  }

  const text = parts.join("\n\n");

  if (!text) {

    return {
      success: false,
      error: "PowerPointファイルからテキストを抽出できませんでした",
    };

  }

  return { success: true, text };

}

export async function extractTextFromFile(
  fileName: string,
  buffer: Buffer
): Promise<ExtractResult> {

  const ext = getFileExtension(fileName);

  try {

    switch (ext) {

      case "pdf":
        return await extractPdf(buffer);

      case "docx":
        return await extractDocx(buffer);

      case "xlsx":
        return extractXlsx(buffer);

      case "pptx":
        return await extractPptx(buffer);

      default:
        return {
          success: false,
          error: `対応していないファイル形式です(.${ext})`,
        };

    }

  } catch (error) {

    return {
      success: false,
      error: `ファイルの解析に失敗しました: ${String(error)}`,
    };

  }

}
