import { check, summarize, type CheckResult } from "../lib/check";
import { buildAttachmentEvidence, selectAttachmentEvidence } from "../../../core/tact-attachment/evidence";
import {
  MAX_CHUNKS_PER_ATTACHMENT,
  MAX_SELECTED_ATTACHMENT_CHARS,
  MAX_SELECTED_ATTACHMENT_CHUNKS,
} from "../../../core/tact-attachment/types";
import { extractPdfText } from "../../../core/tact-attachment/extractor";
import type { TactAttachment } from "../../../core/tact-attachment/types";
import { validateAttachmentIds, validatePdfUpload } from "../../../core/tact-attachment/validation";
import { executeTask } from "../../../core/tact-orchestrator/executor";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { getAttachmentOnlyOrchestrationInput } from "../../../core/tact-conversation/orchestration";
import { createMockCoreCapability } from "../../../core/tact-core/mockCoreCapability";
import type { Task } from "../../../core/tact-orchestrator/task";
import type { TaskContext } from "../../../core/tact-orchestrator/taskContext";
import type { ResearchParams, ResearchResult } from "../../../core/tact-research/types";

const MINIMAL_PDF = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 52 >>
stream
BT
/F1 12 Tf
72 720 Td
(TACT Attachment PDF fixture) Tj
ET
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000311 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
412
%%EOF`);

function attachment(overrides: Partial<TactAttachment> = {}): TactAttachment {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    originalFilename: "fixture.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 100,
    storageBucket: "tact-attachments",
    storagePath: "22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/source",
    extractionStatus: "ready",
    extractedText: "TACT attachment evidence alpha. " .repeat(500),
    extractedTextTruncated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function researchResult(): ResearchResult {
  return {
    success: true,
    answer: "mocked attachment research",
    evidence: [],
    metadata: {
      executionMode: "web-research",
      llmAttempts: 0, llmSuccesses: 0, llmFailures: 0,
      searchQueryCount: 0, searchRequestCount: 0, searchAttempts: [],
      retrievedKnowledgeCount: 0, retrievedMemoryCount: 0, retrievedExampleCount: 0,
      usedKnowledgeCount: 0, usedMemoryCount: 0, usedExampleCount: 0,
      usedKnowledgeIds: [], usedMemoryIds: [], usedExampleIds: [],
      durationMs: 0, mocked: true,
      requirementCount: 0, coveredRequirementCount: 0, partialRequirementCount: 0,
      missingRequirementCount: 0, gapQueries: [], safetyDowngradeCount: 0,
    },
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const valid = validatePdfUpload({ filename: "fixture.pdf", mimeType: "application/pdf", size: MINIMAL_PDF.length, bytes: MINIMAL_PDF });
  results.push(check("[Attachment] valid PDF fixture passes extension, MIME, size, and magic validation", valid.ok));
  results.push(check("[Attachment] fake PDF extension is rejected", !validatePdfUpload({ filename: "fixture.pdf", mimeType: "application/pdf", size: 8, bytes: Buffer.from("not-pdf!") }).ok));
  results.push(check("[Attachment] invalid PDF magic is rejected", !validatePdfUpload({ filename: "fixture.pdf", mimeType: "application/pdf", size: 8, bytes: Buffer.from("not-pdf!") }).ok));
  results.push(check("[Attachment] oversized PDF is rejected", !validatePdfUpload({ filename: "fixture.pdf", mimeType: "application/pdf", size: 10 * 1024 * 1024 + 1, bytes: MINIMAL_PDF }).ok));
  results.push(check("[Attachment] duplicate attachmentIds are rejected", !validateAttachmentIds(["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"]).ok));
  results.push(check("[Attachment] more than four attachmentIds are rejected", !validateAttachmentIds(Array.from({ length: 5 }, (_, i) => `11111111-1111-4111-8111-11111111111${i}`)).ok));

  const extraction = await extractPdfText("fixture.pdf", MINIMAL_PDF);
  results.push(check("[Attachment] valid PDF fixture extracts text without an LLM", extraction.ok && extraction.text.includes("TACT Attachment PDF fixture")));
  const failedExtraction = await extractPdfText("invalid.pdf", Buffer.from("%PDF-invalid"));
  results.push(check("[Attachment] parser failure is contained as a safe result", !failedExtraction.ok));

  const evidence = buildAttachmentEvidence([attachment()]);
  results.push(check("[Attachment] PDF text is capped at 20 chunks", evidence.length === MAX_CHUNKS_PER_ATTACHMENT));
  results.push(check("[Attachment] evidence retains opaque attachment provenance", evidence[0]?.evidence.source === "tact-attachment://11111111-1111-4111-8111-111111111111#chunk=0" && evidence[0]?.provenance.filename === "fixture.pdf"));
  const selected = selectAttachmentEvidence("alpha", evidence);
  results.push(check("[Attachment] deterministic selection honors count and character budgets", selected.length <= MAX_SELECTED_ATTACHMENT_CHUNKS && selected.reduce((sum, item) => sum + item.evidence.evidence.length, 0) <= MAX_SELECTED_ATTACHMENT_CHARS));

  let received: ResearchParams | undefined;
  registerCapability<ResearchParams, ResearchResult>("research", async (params) => {
    received = params;
    return researchResult();
  });
  const attachmentOnlyInput = getAttachmentOnlyOrchestrationInput("", true);
  const task: Task = { id: "attachment-research", description: attachmentOnlyInput, status: "pending", assignedCapability: "research" };
  const taskContext: TaskContext = {
    task,
    coreContext: { knowledge: [], memories: [], examples: [], recentExecutions: [] },
    memoryReferences: [],
    dependencyResults: [],
  };
  await executeTask(task, createMockCoreCapability(), taskContext, evidence);
  results.push(check("[Attachment] attachment-only internal input reaches mocked Research without a crash", received?.query === attachmentOnlyInput));
  results.push(check("[Attachment] attachment-only Research receives only selected user-file Evidence", !!received && (received.attachmentEvidence?.length ?? 0) > 0 && received.attachmentEvidence?.every((item) => item.evidence.sourceType === "user_file") === true));

  return summarize("TACT Attachment Phase 1 (LLM 0 / PDF fixture)", results);
}
