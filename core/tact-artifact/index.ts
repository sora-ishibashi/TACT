// =========================
// TACT Artifact — Public Entry Point (Phase 75)
// =========================
//
// core/tact-conversation/index.ts・core/tact-core/index.tsと同じ
// barrel export pattern。

export * from "./types";
export {
  createArtifact,
  getArtifact,
  updateArtifactBlocks,
} from "./store";
export * from "./blocks";
