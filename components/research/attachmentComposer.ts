import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_FILE_SIZE_BYTES,
  MAX_TOTAL_ATTACHMENT_SIZE_BYTES,
  PDF_MIME_TYPE,
} from "@/core/tact-attachment/types";

export type PdfFileCandidate = {
  name: string;
  type: string;
  size: number;
};

export type ComposerAttachmentStatus = "uploading" | "ready" | "error";

export type ComposerAttachment = {
  localId: string;
  file: File;
  status: ComposerAttachmentStatus;
  attachmentId?: string;
  error?: string;
};

export type AttachmentUploadResult =
  | { ok: true; attachmentId: string }
  | { ok: false; error: string };

export function validatePdfSelection(
  current: readonly PdfFileCandidate[],
  selected: readonly PdfFileCandidate[]
): string | null {
  const invalid = selected.find(
    (file) =>
      file.type.toLocaleLowerCase() !== PDF_MIME_TYPE ||
      !file.name.toLocaleLowerCase().endsWith(".pdf") ||
      file.size <= 0
  );
  if (invalid) return "PDFファイルのみ添付できます。";

  const oversized = selected.find((file) => file.size > MAX_FILE_SIZE_BYTES);
  if (oversized) return "PDFは1ファイル10MBまでです。";

  if (current.length + selected.length > MAX_ATTACHMENTS_PER_TURN) {
    return `添付できるPDFは最大${MAX_ATTACHMENTS_PER_TURN}件です。`;
  }

  const totalBytes = [...current, ...selected].reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
    return "添付PDFの合計は20MBまでです。";
  }

  return null;
}

export function applyAttachmentUploadResult(
  attachments: readonly ComposerAttachment[],
  localId: string,
  result: AttachmentUploadResult
): ComposerAttachment[] {
  return attachments.map((attachment) => {
    if (attachment.localId !== localId) return attachment;
    return result.ok
      ? { ...attachment, status: "ready", attachmentId: result.attachmentId, error: undefined }
      : { ...attachment, status: "error", attachmentId: undefined, error: result.error };
  });
}

export function removeComposerAttachment(
  attachments: readonly ComposerAttachment[],
  localId: string
): ComposerAttachment[] {
  return attachments.filter((attachment) => attachment.localId !== localId);
}

export function getReadyAttachmentIds(attachments: readonly ComposerAttachment[]): string[] {
  return attachments.flatMap((attachment) =>
    attachment.status === "ready" && attachment.attachmentId ? [attachment.attachmentId] : []
  );
}

export function hasPendingAttachment(attachments: readonly ComposerAttachment[]): boolean {
  return attachments.some((attachment) => attachment.status !== "ready");
}

export function shouldShowAttachmentSpinner(status: ComposerAttachmentStatus): boolean {
  return status === "uploading";
}

export function clearAttachmentsAfterSuccessfulSend(): ComposerAttachment[] {
  return [];
}

export function getMessageAttachmentFilenames(
  attachments: readonly { filename: string }[] | undefined
): string[] {
  return attachments?.map((attachment) => attachment.filename) ?? [];
}

export function canSubmitConversationTurn(input: {
  content: string;
  sending: boolean;
  attachments: readonly ComposerAttachment[];
}): boolean {
  const hasText = input.content.trim().length > 0;
  const hasReadyAttachment = getReadyAttachmentIds(input.attachments).length > 0;
  return (hasText || hasReadyAttachment) && !input.sending && !hasPendingAttachment(input.attachments);
}
