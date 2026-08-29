import type { ArtifactBlock, TableBlock } from "../../tact-artifact/types";
import { nextOrder } from "../../tact-artifact/blocks";
import type { FrameworkResult, ResearchFrameworkArtifact } from "./types";

const frameworkTitle: Record<FrameworkResult["frameworkId"], string> = {
  "framework.swot": "SWOT Framework",
  "framework.3c": "3C Framework",
  "framework.pest": "PEST Framework",
};

/** Adapts an already validated FrameworkResult to the existing TableBlock contract. */
export function frameworkResultToTableBlock(result: FrameworkResult): TableBlock {
  const rows = result.sections.flatMap((section) => section.items.map((item) => [section.label, item.kind === "inference" ? "Inference" : "Fact", item.text, item.sourceEvidenceIds.join(", ")]));
  const rowSourceEvidenceIds = result.sections.flatMap((section) => section.items.map((item) => [...item.sourceEvidenceIds]));
  const cellSourceEvidenceIds = result.sections.flatMap((section) => section.items.map((item) => [undefined, undefined, [...item.sourceEvidenceIds], [...item.sourceEvidenceIds]]));
  const now = new Date().toISOString();
  return { id: `framework-table:${result.frameworkId}`, type: "table", title: frameworkTitle[result.frameworkId], columns: ["Section", "Kind", "Content", "Evidence"], rows, rowSourceEvidenceIds, cellSourceEvidenceIds, sourceEvidenceIds: [...result.sourceEvidenceIds], order: 0, createdAt: now, updatedAt: now };
}

export function buildResearchFrameworkArtifacts(results: readonly FrameworkResult[]): ResearchFrameworkArtifact[] {
  return results.map((result) => ({ frameworkId: result.frameworkId, block: frameworkResultToTableBlock(result) }));
}

/** Existing Artifact flow adapter: append a Framework table without mutating unrelated blocks. */
export function mergeResearchFrameworkBlocks(existingBlocks: readonly ArtifactBlock[], artifacts: readonly ResearchFrameworkArtifact[]): ArtifactBlock[] {
  let blocks = [...existingBlocks];
  for (const artifact of artifacts) {
    const block = { ...artifact.block, order: nextOrder(blocks), updatedAt: new Date().toISOString() };
    const index = blocks.findIndex((candidate) => candidate.type === "table" && candidate.id === block.id);
    blocks = index >= 0 ? blocks.map((candidate, current) => current === index ? block : candidate) : [...blocks, block];
  }
  return blocks;
}
