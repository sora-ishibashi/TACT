import type { ResearchGap } from "../gap/types";

/** Supporting and unresolved gaps deliberately never reach a Search adapter in Phase 5D. */
export function isResearchFulfillmentEligible(gap: ResearchGap): boolean {
  return gap.researchable && gap.priority === "required" && (gap.missingCount === undefined || gap.missingCount > 0);
}
