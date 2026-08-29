import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_FILE_SIZE_BYTES,
  MAX_TOTAL_ATTACHMENT_SIZE_BYTES,
  PDF_MIME_TYPE,
  type AttachmentValidationResult,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PDF_MAGIC = Buffer.from("%PDF-");

export function validatePdfUpload(input: {
  filename: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}): AttachmentValidationResult {
  if (
    input.filename.length === 0 ||
    input.filename.length > 255 ||
    !input.filename.toLowerCase().endsWith(".pdf") ||
    input.mimeType.toLocaleLowerCase() !== PDF_MIME_TYPE
  ) {
    return { ok: false, code: "unsupported_file_type", message: "Only PDF files are supported." };
  }

  if (input.size <= 0 || input.size > MAX_FILE_SIZE_BYTES) {
    return { ok: false, code: "file_too_large", message: "The PDF must be 10 MB or smaller." };
  }

  if (input.bytes.length < PDF_MAGIC.length || !Buffer.from(input.bytes).subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return { ok: false, code: "invalid_pdf", message: "The file is not a valid PDF." };
  }

  return { ok: true };
}

export function validateAttachmentIds(value: unknown):
  | { ok: true; attachmentIds: string[] }
  | { ok: false; code: "attachment_ids_invalid"; message: string } {
  if (value === undefined || value === null) return { ok: true, attachmentIds: [] };
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
    return { ok: false, code: "attachment_ids_invalid", message: "attachmentIds must be an array of UUIDs." };
  }
  if (value.length > MAX_ATTACHMENTS_PER_TURN) {
    return { ok: false, code: "attachment_ids_invalid", message: `A turn can include at most ${MAX_ATTACHMENTS_PER_TURN} attachments.` };
  }
  if (new Set(value).size !== value.length) {
    return { ok: false, code: "attachment_ids_invalid", message: "attachmentIds must not contain duplicates." };
  }
  return { ok: true, attachmentIds: value };
}

export function validateAttachmentTotalSize(attachments: { fileSizeBytes: number }[]): AttachmentValidationResult {
  const total = attachments.reduce((sum, attachment) => sum + attachment.fileSizeBytes, 0);
  return total <= MAX_TOTAL_ATTACHMENT_SIZE_BYTES
    ? { ok: true }
    : { ok: false, code: "attachment_ids_invalid", message: "The total attachment size must be 20 MB or smaller." };
}
