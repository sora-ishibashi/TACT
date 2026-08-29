import { extractTextFromFile } from "../fileAnalysis/extractFileContent";
import { MAX_EXTRACTED_TEXT_CHARS } from "./types";

export type PdfExtractionResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; errorCode: "pdf_extraction_failed" };

/**
 * Current Attachment-domain adapter for the Legacy PDF parser.  It deliberately
 * exposes neither Legacy attachment types nor parser error details to callers.
 */
export async function extractPdfText(
  filename: string,
  buffer: Buffer
): Promise<PdfExtractionResult> {
  const result = await extractTextFromFile(filename, buffer);
  if (!result.success || !result.text) return { ok: false, errorCode: "pdf_extraction_failed" };

  return {
    ok: true,
    text: result.text.slice(0, MAX_EXTRACTED_TEXT_CHARS),
    truncated: result.text.length > MAX_EXTRACTED_TEXT_CHARS,
  };
}
