import type { Evidence } from "../context/types";

export const ATTACHMENT_BUCKET = "tact-attachments";
export const PDF_MIME_TYPE = "application/pdf";
export const MAX_ATTACHMENTS_PER_TURN = 4;
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;
export const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000;
export const LINKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_EXTRACTED_TEXT_CHARS = 120_000;
export const ATTACHMENT_CHUNK_SIZE = 700;
export const MAX_CHUNKS_PER_ATTACHMENT = 20;
export const MAX_SELECTED_ATTACHMENT_CHUNKS = 8;
export const MAX_SELECTED_CHUNKS_PER_ATTACHMENT = 4;
export const MAX_SELECTED_ATTACHMENT_CHARS = 6_000;

export type AttachmentExtractionStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "unavailable";

export interface TactAttachment {
  id: string;
  userId: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  storageBucket: string;
  storagePath: string;
  extractionStatus: AttachmentExtractionStatus;
  extractedText?: string | null;
  extractedTextTruncated: boolean;
  extractionError?: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  deletedAt?: string | null;
}

export interface AttachmentSummary {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractionStatus: AttachmentExtractionStatus;
}

export interface AttachmentProvenance {
  attachmentId: string;
  filename: string;
  mimeType: string;
  chunkIndex: number;
  chunkCount: number;
}

export interface AttachmentEvidence {
  evidence: Evidence;
  provenance: AttachmentProvenance;
}

export type AttachmentValidationErrorCode =
  | "file_required"
  | "file_too_large"
  | "unsupported_file_type"
  | "invalid_pdf"
  | "attachment_ids_invalid"
  | "attachment_not_available";

export interface AttachmentValidationFailure {
  ok: false;
  code: AttachmentValidationErrorCode;
  message: string;
}

export interface AttachmentValidationSuccess {
  ok: true;
}

export type AttachmentValidationResult =
  | AttachmentValidationSuccess
  | AttachmentValidationFailure;
