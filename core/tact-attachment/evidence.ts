import type { AttachmentEvidence, TactAttachment } from "./types";
import {
  ATTACHMENT_CHUNK_SIZE,
  MAX_CHUNKS_PER_ATTACHMENT,
  MAX_SELECTED_ATTACHMENT_CHARS,
  MAX_SELECTED_ATTACHMENT_CHUNKS,
  MAX_SELECTED_CHUNKS_PER_ATTACHMENT,
} from "./types";

export function chunkAttachmentText(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  for (let start = 0; start < normalized.length && chunks.length < MAX_CHUNKS_PER_ATTACHMENT; start += ATTACHMENT_CHUNK_SIZE) {
    chunks.push(normalized.slice(start, start + ATTACHMENT_CHUNK_SIZE));
  }
  return chunks;
}

export function buildAttachmentEvidence(attachments: TactAttachment[]): AttachmentEvidence[] {
  const now = Date.now();
  return attachments.flatMap((attachment) => {
    const chunks = chunkAttachmentText(attachment.extractedText ?? "");
    return chunks.map((chunk, index) => ({
      evidence: {
        id: `attachment:${attachment.id}:chunk:${index}`,
        claim: `${attachment.originalFilename} (${index + 1}/${chunks.length})`,
        evidence: chunk,
        source: `tact-attachment://${attachment.id}#chunk=${index}`,
        sourceType: "user_file" as const,
        confidence: "medium" as const,
        score: 0,
        createdBy: "attachment-extractor",
        createdAt: now,
        tags: ["attachment", "user_file", attachment.mimeType],
        references: [],
      },
      provenance: {
        attachmentId: attachment.id,
        filename: attachment.originalFilename,
        mimeType: attachment.mimeType,
        chunkIndex: index,
        chunkCount: chunks.length,
      },
    }));
  });
}

function queryTerms(query: string): string[] {
  return Array.from(new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []));
}

export function selectAttachmentEvidence(
  query: string,
  evidence: AttachmentEvidence[]
): AttachmentEvidence[] {
  const terms = queryTerms(query);
  const scored = evidence.map((item, order) => ({
    item,
    order,
    score: terms.reduce(
      (total, term) => total + (item.evidence.evidence.toLocaleLowerCase().includes(term) ? 1 : 0),
      0
    ),
  }));
  const selected: AttachmentEvidence[] = [];
  const perAttachment = new Map<string, number>();
  const selectedAttachmentIds = new Set<string>();
  let charCount = 0;

  for (const candidate of [...scored].sort((a, b) => b.score - a.score || a.order - b.order)) {
    const id = candidate.item.provenance.attachmentId;
    const usedForFile = perAttachment.get(id) ?? 0;
    if (usedForFile >= MAX_SELECTED_CHUNKS_PER_ATTACHMENT || selected.length >= MAX_SELECTED_ATTACHMENT_CHUNKS) continue;
    if (charCount + candidate.item.evidence.evidence.length > MAX_SELECTED_ATTACHMENT_CHARS) continue;
    if (candidate.score === 0 && selectedAttachmentIds.has(id)) continue;
    selected.push(candidate.item);
    selectedAttachmentIds.add(id);
    perAttachment.set(id, usedForFile + 1);
    charCount += candidate.item.evidence.evidence.length;
  }

  return selected;
}
