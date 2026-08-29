import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserContext } from "@/core/auth/getUserContext";
import {
  createPendingAttachment,
  markAttachmentFailedBestEffort,
  toAttachmentSummary,
  updateAttachmentExtraction,
  uploadAttachmentObject,
} from "@/core/tact-attachment/repository";
import { extractPdfText } from "@/core/tact-attachment/extractor";
import { validatePdfUpload } from "@/core/tact-attachment/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const { userId, accessToken } = await getCurrentUserContext(request);
  if (!userId || !accessToken) {
    return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLocaleLowerCase().startsWith("multipart/form-data")) {
    return NextResponse.json({ success: false, code: "file_required", error: "multipart/form-data is required" }, { status: 400 });
  }

  const formData = await request.formData().catch(() => null);
  const candidate = formData?.get("file");
  if (!(candidate instanceof File)) {
    return NextResponse.json({ success: false, code: "file_required", error: "file is required" }, { status: 400 });
  }

  const bytes = new Uint8Array(await candidate.arrayBuffer());
  const mimeType = candidate.type.toLocaleLowerCase();
  const validation = validatePdfUpload({
    filename: candidate.name,
    mimeType,
    size: candidate.size,
    bytes,
  });
  if (!validation.ok) {
    return NextResponse.json({ success: false, code: validation.code, error: validation.message }, { status: 400 });
  }

  const attachmentId = crypto.randomUUID();
  let attachment;
  try {
    attachment = await createPendingAttachment({
      id: attachmentId,
      userId,
      accessToken,
      filename: candidate.name,
      mimeType,
      sizeBytes: candidate.size,
    });
    await uploadAttachmentObject({ accessToken, attachment, data: Buffer.from(bytes) });
    attachment = await updateAttachmentExtraction({
      id: attachment.id,
      userId,
      accessToken,
      status: "processing",
    });
  } catch (error) {
    if (attachment) {
      await markAttachmentFailedBestEffort({ id: attachment.id, userId, accessToken, errorCode: "upload_failed" });
    }
    console.error("TACT attachment upload failed", error);
    return NextResponse.json({ success: false, code: "upload_failed", error: "Unable to upload the PDF." }, { status: 500 });
  }

  const extracted = await extractPdfText(candidate.name, Buffer.from(bytes));
  if (!extracted.ok) {
    await markAttachmentFailedBestEffort({ id: attachment.id, userId, accessToken, errorCode: extracted.errorCode });
    return NextResponse.json({
      success: true,
      attachment: { ...toAttachmentSummary(attachment), extractionStatus: "failed" },
    }, { status: 201 });
  }

  try {
    attachment = await updateAttachmentExtraction({
      id: attachment.id,
      userId,
      accessToken,
      status: "ready",
      extractedText: extracted.text,
      truncated: extracted.truncated,
    });
    return NextResponse.json({ success: true, attachment: toAttachmentSummary(attachment) }, { status: 201 });
  } catch (error) {
    await markAttachmentFailedBestEffort({ id: attachment.id, userId, accessToken, errorCode: "attachment_persist_failed" });
    console.error("TACT attachment extraction persistence failed", error);
    return NextResponse.json({ success: false, code: "attachment_persist_failed", error: "Unable to process the PDF." }, { status: 500 });
  }
}
