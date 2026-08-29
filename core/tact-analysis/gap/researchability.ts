import type { CapabilityRequirementKind } from "../capability/types";
import type { GapDataContext } from "./normalize";
import type { ResearchGapKind, UnresolvedAnalysisRequirementReason } from "./types";

export function requirementToGapKind(kind: CapabilityRequirementKind): ResearchGapKind | undefined {
  switch (kind) {
    case "numeric": return "numeric_value";
    case "time_series": return "time_series";
    case "comparison": return "comparison";
    case "evidence": return "evidence";
    case "target_entity": return "entity_context";
    default: return undefined;
  }
}

export interface ResearchabilityResult { researchable: boolean; reason?: UnresolvedAnalysisRequirementReason; }

/** Conservative by design: a missing requirement is not automatically a searchable one. */
export function evaluateResearchability(kind: ResearchGapKind, context: GapDataContext, missingCount: number | undefined): ResearchabilityResult {
  if (missingCount !== undefined && missingCount <= 0) return { researchable: false, reason: "not_researchable" };
  if (kind === "time_series") {
    if (!context.targetEntity) return { researchable: false, reason: "ambiguous_target" };
    if (!context.metric) return { researchable: false, reason: "ambiguous_metric" };
    return { researchable: true };
  }
  if (kind === "numeric_value") {
    if (!context.targetEntity) return { researchable: false, reason: "ambiguous_target" };
    if (!context.metric) return { researchable: false, reason: "ambiguous_metric" };
    if (!context.period?.start) return { researchable: false, reason: "insufficient_context" };
    return { researchable: true };
  }
  if (kind === "evidence") return context.targetEntity ? { researchable: true } : { researchable: false, reason: "insufficient_context" };
  // Missing comparison entities and user-supplied target context are not safe search targets in Phase 5C.
  if (kind === "comparison" || kind === "entity_context") return { researchable: false, reason: "ambiguous_target" };
  return { researchable: false, reason: "not_researchable" };
}
