import { detectExplicitCapabilityIds } from "../planner/candidate";
import { detectAnalysisPurposes } from "../capability/evaluate";

const GENERIC_ANALYSIS_ACTION = /(?:compare|analy[sz]e|calculate|rank|chart|visuali[sz]e|show|make|create|trend|growth|ratio|percentage|\u6bd4\u8f03|\u6bd4\u3079|\u3069\u3061\u3089|\u4f38\u3073|\u6210\u9577|\u63a8\u79fb|\u5206\u6790)/i;

/**
 * Precision-first gate for the canonical analysis pipeline. Existing explicit
 * intent detectors remain authoritative. Generic entry is deliberately limited
 * to deterministic, analysis-shaped purposes, never explanation requests.
 */
export function isCortexAnalysisEligible(objective: string): boolean {
  if (detectExplicitCapabilityIds(objective).length > 0) return true;
  return GENERIC_ANALYSIS_ACTION.test(objective) && detectAnalysisPurposes(objective).length > 0;
}
