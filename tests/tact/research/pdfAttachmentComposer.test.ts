import {
  applyAttachmentUploadResult,
  canSubmitConversationTurn,
  clearAttachmentsAfterSuccessfulSend,
  getReadyAttachmentIds,
  getMessageAttachmentFilenames,
  hasPendingAttachment,
  removeComposerAttachment,
  shouldShowAttachmentSpinner,
  validatePdfSelection,
  type ComposerAttachment,
  type PdfFileCandidate,
} from "../../../components/research/attachmentComposer";
import { readFileSync } from "node:fs";
import { check, summarize, type CheckResult } from "../lib/check";

function pdf(name: string, size = 1024): PdfFileCandidate {
  return { name, type: "application/pdf", size };
}

function attachment(localId: string, status: ComposerAttachment["status"] = "uploading"): ComposerAttachment {
  return { localId, file: pdf(`${localId}.pdf`) as File, status };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  results.push(check("[PDF composer] PDF selection is accepted", validatePdfSelection([], [pdf("report.pdf")]) === null));
  results.push(check("[PDF composer] multiple PDFs are accepted", validatePdfSelection([], [pdf("a.pdf"), pdf("b.pdf")]) === null));
  results.push(check("[PDF composer] fifth PDF is rejected", validatePdfSelection([pdf("1.pdf"), pdf("2.pdf"), pdf("3.pdf"), pdf("4.pdf")], [pdf("5.pdf")]) !== null));
  results.push(check("[PDF composer] PDF over 10MB is rejected", validatePdfSelection([], [pdf("large.pdf", 10 * 1024 * 1024 + 1)]) !== null));
  results.push(check("[PDF composer] PDFs over 20MB total are rejected", validatePdfSelection([pdf("first.pdf", 10 * 1024 * 1024)], [pdf("second.pdf", 10 * 1024 * 1024 + 1)]) !== null));
  results.push(check("[PDF composer] non-PDF selection is rejected", validatePdfSelection([], [{ name: "image.png", type: "image/png", size: 1024 }]) !== null));

  const uploading = attachment("local-1");
  const composerSource = readFileSync("components/research/ResearchWorkspace.tsx", "utf8");
  results.push(check("[PDF composer] uploading uses the compact spinner", shouldShowAttachmentSpinner(uploading.status) && composerSource.includes("animate-spin")));
  results.push(check("[PDF composer] uploading text is not visually rendered", !composerSource.includes(">アップロード中<")));
  const ready = applyAttachmentUploadResult([uploading], "local-1", { ok: true, attachmentId: "attachment-1" });
  results.push(check("[PDF composer] successful upload becomes ready", ready[0]?.status === "ready" && ready[0]?.attachmentId === "attachment-1"));
  results.push(check("[PDF composer] ready attachment hides the spinner", !shouldShowAttachmentSpinner(ready[0]!.status)));
  const failed = applyAttachmentUploadResult([uploading], "local-1", { ok: false, error: "アップロードに失敗しました。" });
  results.push(check("[PDF composer] upload error remains removable", failed[0]?.status === "error" && removeComposerAttachment(failed, "local-1").length === 0));
  results.push(check("[PDF composer] uploading attachment prevents send", hasPendingAttachment([uploading]) && !canSubmitConversationTurn({ content: "確認してください", sending: false, attachments: [uploading] })));
  results.push(check("[PDF composer] ready IDs are included in the conversation payload", getReadyAttachmentIds(ready).length === 1 && getReadyAttachmentIds(ready)[0] === "attachment-1"));
  results.push(check("[PDF composer] successful send conditions accept text plus ready attachment", canSubmitConversationTurn({ content: "確認してください", sending: false, attachments: ready })));
  results.push(check("[PDF composer] successful send clears composer attachments", clearAttachmentsAfterSuccessfulSend().length === 0));
  results.push(check("[PDF composer] message attachment metadata exposes filenames", getMessageAttachmentFilenames([{ filename: "market-report.pdf" }])[0] === "market-report.pdf"));
  results.push(check("[PDF composer] attachment-only turn can send", canSubmitConversationTurn({ content: "", sending: false, attachments: ready })));
  results.push(check("[PDF composer] whitespace-only content with an attachment can send", canSubmitConversationTurn({ content: "   ", sending: false, attachments: ready })));
  results.push(check("[PDF composer] completely empty turn cannot send", !canSubmitConversationTurn({ content: "", sending: false, attachments: [] })));
  results.push(check("[PDF composer] error attachment alone cannot send", !canSubmitConversationTurn({ content: "", sending: false, attachments: failed })));
  results.push(check("[PDF composer] mixed ready and uploading attachments cannot send", !canSubmitConversationTurn({ content: "", sending: false, attachments: [...ready, uploading] })));
  results.push(check("[PDF composer] attachment-only send clears composer attachments", clearAttachmentsAfterSuccessfulSend().length === 0));
  results.push(check("[PDF composer] attachment-only message metadata exposes filenames", getMessageAttachmentFilenames([{ filename: "market-report.pdf" }])[0] === "market-report.pdf"));

  return summarize("TACT Research PDF attachment composer", results);
}
