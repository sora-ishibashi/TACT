import { buildDatasets, type DatasetBuildResult } from "../data/buildDataset";
import { extractEvidenceObservations } from "./extractEvidenceObservations";
import type { NumericEvidenceSource } from "./types";

/** One deterministic, untrusted-evidence-only Dataset build shared by Analysis and Presentation. */
export function buildResearchDatasets(evidence: readonly NumericEvidenceSource[]): DatasetBuildResult {
  const extracted = extractEvidenceObservations(evidence);
  const built = buildDatasets(extracted.observations);
  return { ...built, warnings: [...extracted.warnings, ...built.warnings] };
}
