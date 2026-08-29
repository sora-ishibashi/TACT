import type { ArtifactBlock } from "../../tact-artifact/types";
import type { ValidationIssue } from "../types";

/** Internal-only display role; it is never written into the Artifact schema. */
export type ArtifactCandidateRole = "primary" | "supporting" | "detail";

/** A validated execution output after deterministic display selection. */
export interface AnalysisArtifactCandidate {
  block: ArtifactBlock;
  role: ArtifactCandidateRole;
  sourceStepIds: readonly string[];
  capabilityIds: readonly string[];
  explicitRequest: boolean;
  planStepOrder: number;
}

/** Pure, already-validated Artifact intent. Persistence remains owned by Conversation. */
export interface AnalysisArtifactPlan {
  blocks: readonly ArtifactBlock[];
  sourceStepIds: readonly string[];
  sourceEvidenceIds: readonly string[];
  warnings: readonly ValidationIssue[];
  /** Optional diagnostic metadata; Artifact persistence consumes `blocks` only. */
  candidates?: readonly AnalysisArtifactCandidate[];
}
