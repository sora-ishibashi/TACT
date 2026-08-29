import type { CapabilityEvidenceDescriptor, CapabilityRequirementKind } from "../capability/types";
import type { Dataset, TimeGranularity, ValidationIssue } from "../types";
import type { ValidatedAnalysisPlan } from "../planner/types";

export const MAX_RESEARCH_GAPS = 5;

export type ResearchGapKind =
  | "numeric_value"
  | "time_series"
  | "comparison"
  | "evidence"
  | "entity_context"
  | "framework_coverage";

export interface ResearchGapPeriod {
  start?: string;
  end?: string;
  granularity?: TimeGranularity;
}

export interface ResearchGap {
  id: string;
  kind: ResearchGapKind;
  targetEntity?: string;
  metric?: string;
  period?: ResearchGapPeriod;
  unit?: string;
  currency?: string;
  requiredCount?: number;
  currentCount?: number;
  missingCount?: number;
  requiredByStepIds: readonly string[];
  requiredByCapabilityIds: readonly string[];
  sourceRequirementIds: readonly string[];
  researchable: boolean;
  priority: "required" | "supporting";
  reason: string;
}

export type UnresolvedAnalysisRequirementReason =
  | "ambiguous_target"
  | "ambiguous_metric"
  | "not_researchable"
  | "invalid_input"
  | "insufficient_context"
  | "gap_limit";

export interface UnresolvedAnalysisRequirement {
  requirementId: string;
  kind: CapabilityRequirementKind;
  requiredByStepIds: readonly string[];
  requiredByCapabilityIds: readonly string[];
  reason: UnresolvedAnalysisRequirementReason;
  description: string;
}

export interface ResearchGapPlanSummary {
  blockedSteps: number;
  sourceRequirements: number;
  mergedGaps: number;
  researchableGaps: number;
  unresolvedRequirements: number;
}

export interface ResearchGapPlan {
  id: string;
  objective: string;
  gaps: readonly ResearchGap[];
  unresolvedRequirements: readonly UnresolvedAnalysisRequirement[];
  warnings: readonly ValidationIssue[];
  researchRequired: boolean;
  summary: ResearchGapPlanSummary;
}

/** Lightweight context only; it intentionally does not depend on core/tact-research. */
export interface BuildResearchGapPlanInput {
  plan: ValidatedAnalysisPlan;
  targetEntity?: string;
  datasets?: readonly Dataset[];
  evidenceDescriptors?: readonly CapabilityEvidenceDescriptor[];
}
