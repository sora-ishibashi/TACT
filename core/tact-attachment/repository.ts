import { createClient } from "@supabase/supabase-js";
import {
  ATTACHMENT_BUCKET,
  LINKED_RETENTION_MS,
  ORPHAN_RETENTION_MS,
  type AttachmentExtractionStatus,
  type AttachmentSummary,
  type TactAttachment,
} from "./types";
import { validateAttachmentTotalSize } from "./validation";

interface AttachmentRow {
  id: string;
  user_id: string;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  storage_bucket: string;
  storage_path: string;
  extraction_status: AttachmentExtractionStatus;
  extracted_text: string | null;
  extracted_text_truncated: boolean;
  extraction_error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  deleted_at: string | null;
}

function createRequestScopedClient(accessToken: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
}

function toAttachment(row: AttachmentRow): TactAttachment {
  return {
    id: row.id,
    userId: row.user_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    extractionStatus: row.extraction_status,
    extractedText: row.extracted_text,
    extractedTextTruncated: row.extracted_text_truncated,
    extractionError: row.extraction_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
  };
}

export function toAttachmentSummary(attachment: TactAttachment): AttachmentSummary {
  return {
    id: attachment.id,
    filename: attachment.originalFilename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.fileSizeBytes,
    extractionStatus: attachment.extractionStatus,
  };
}

export function buildAttachmentStoragePath(userId: string, attachmentId: string): string {
  return `${userId}/${attachmentId}/source`;
}

export async function createPendingAttachment(input: {
  id: string;
  userId: string;
  accessToken: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<TactAttachment> {
  const client = createRequestScopedClient(input.accessToken);
  const storagePath = buildAttachmentStoragePath(input.userId, input.id);
  const { data, error } = await client
    .from("tact_attachments")
    .insert({
      id: input.id,
      user_id: input.userId,
      original_filename: input.filename,
      mime_type: input.mimeType,
      file_size_bytes: input.sizeBytes,
      storage_bucket: ATTACHMENT_BUCKET,
      storage_path: storagePath,
      extraction_status: "pending",
      expires_at: new Date(Date.now() + ORPHAN_RETENTION_MS).toISOString(),
    })
    .select("*")
    .single();
  if (error) throw error;
  return toAttachment(data as AttachmentRow);
}

export async function uploadAttachmentObject(input: {
  accessToken: string;
  attachment: TactAttachment;
  data: Buffer;
}): Promise<void> {
  const client = createRequestScopedClient(input.accessToken);
  const { error } = await client.storage
    .from(input.attachment.storageBucket)
    .upload(input.attachment.storagePath, input.data, {
      contentType: input.attachment.mimeType,
      upsert: false,
    });
  if (error) throw error;
}

export async function updateAttachmentExtraction(input: {
  id: string;
  userId: string;
  accessToken: string;
  status: AttachmentExtractionStatus;
  extractedText?: string;
  truncated?: boolean;
  errorCode?: string;
}): Promise<TactAttachment> {
  const client = createRequestScopedClient(input.accessToken);
  const patch: Record<string, unknown> = {
    extraction_status: input.status,
    extraction_error: input.errorCode ?? null,
  };
  if (input.extractedText !== undefined) patch.extracted_text = input.extractedText;
  if (input.truncated !== undefined) patch.extracted_text_truncated = input.truncated;
  const { data, error } = await client
    .from("tact_attachments")
    .update(patch)
    .eq("id", input.id)
    .eq("user_id", input.userId)
    .select("*")
    .single();
  if (error) throw error;
  return toAttachment(data as AttachmentRow);
}

/** Returns no details for absent, foreign, expired, deleted, or non-ready IDs. */
export async function resolveReadyAttachments(input: {
  userId: string;
  accessToken: string;
  attachmentIds: string[];
}): Promise<TactAttachment[] | null> {
  if (input.attachmentIds.length === 0) return [];
  const client = createRequestScopedClient(input.accessToken);
  const { data, error } = await client
    .from("tact_attachments")
    .select("*")
    .in("id", input.attachmentIds)
    .eq("user_id", input.userId)
    .eq("extraction_status", "ready")
    .is("deleted_at", null)
    .gt("expires_at", new Date().toISOString());
  if (error) throw error;
  const byId = new Map((data as AttachmentRow[] | null ?? []).map((row) => [row.id, toAttachment(row)]));
  const ordered = input.attachmentIds.map((id) => byId.get(id)).filter((item): item is TactAttachment => !!item);
  if (ordered.length !== input.attachmentIds.length) return null;
  return validateAttachmentTotalSize(ordered).ok ? ordered : null;
}

export async function markAttachmentsLinked(input: {
  attachmentIds: string[];
  userId: string;
  accessToken: string;
}): Promise<void> {
  if (input.attachmentIds.length === 0) return;
  const client = createRequestScopedClient(input.accessToken);
  const { error } = await client
    .from("tact_attachments")
    .update({ expires_at: new Date(Date.now() + LINKED_RETENTION_MS).toISOString() })
    .in("id", input.attachmentIds)
    .eq("user_id", input.userId);
  if (error) throw error;
}

export async function markAttachmentFailedBestEffort(input: {
  id: string;
  userId: string;
  accessToken: string;
  errorCode: string;
}): Promise<void> {
  try {
    await updateAttachmentExtraction({ ...input, status: "failed" });
  } catch {
    // The original persistence error remains the actionable server-side error.
  }
}
