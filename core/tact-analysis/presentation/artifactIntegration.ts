import { nextOrder } from "../../tact-artifact/blocks";
import type { ArtifactBlock } from "../../tact-artifact/types";
import type { ResearchPresentation } from "./types";

/**
 * Pure Artifact mutation adapter. It receives only already-validated Cortex
 * presentations and never attempts to infer or replace an invalid request.
 */
export function mergeResearchPresentationBlocks(
  existingBlocks: readonly ArtifactBlock[],
  presentations: readonly ResearchPresentation[],
): ArtifactBlock[] {
  let blocks = [...existingBlocks];
  for (const presentation of presentations) {
    const block = { ...presentation.block, order: nextOrder(blocks), updatedAt: new Date().toISOString() };
    // A new Dataset table must not overwrite an evidence/comparison table from
    // earlier work. Charts follow the existing Artifact convention of updating
    // the current chart rather than accumulating indistinguishable chart blocks.
    const existingIndex = block.type === "chart"
      ? blocks.findIndex((candidate) => candidate.type === "chart")
      : -1;
    blocks = existingIndex >= 0
      ? blocks.map((candidate, index) => index === existingIndex ? block : candidate)
      : [...blocks, block];
  }
  return blocks;
}
