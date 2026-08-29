import type { Dataset, ValidationIssue } from "../types";
import type { PresentationSuitability } from "../presentation/types";

/** A description of what Cortex can do, independent of the Rule that executes it. */
export type AnalysisCapabilityKind = "calculation" | "presentation" | "framework";

/** Small, stable vocabulary for a future planner. It is deliberately not a taxonomy of every question type. */
export type AnalysisPurpose =
  | "compare"
  | "trend"
  | "ratio"
  | "rank"
  | "structure"
  | "environment"
  | "market"
  | "company"
  | "customer"
  | "competitor"
  | "visualize"
  | "summarize";

export type CapabilityRequirementKind =
  | "evidence"
  | "dataset"
  | "numeric"
  | "time_series"
  | "comparison"
  | "target_entity"
  | "explicit_request";

export interface CapabilityRequirement {
  id: string;
  kind: CapabilityRequirementKind;
  required: boolean;
  description: string;
  minCount?: number;
}

export interface MissingCapabilityRequirement {
  requirementId: string;
  kind: CapabilityRequirementKind;
  description: string;
  currentCount?: number;
  requiredCount?: number;
}

/** A deliberately small, Research-independent evidence view. */
export interface CapabilityEvidenceDescriptor {
  id: string;
  text?: string;
}

export interface CapabilityEvaluationInput {
  objective: string;
  targetEntity?: string;
  evidence?: readonly CapabilityEvidenceDescriptor[];
  datasets?: readonly Dataset[];
  explicitCapabilityId?: string;
  explicitRequest?: boolean;
}

export interface CapabilityRuleReference {
  id: string;
  version: string;
}

export interface CapabilityEvaluation {
  capabilityId: string;
  valid: boolean;
  /** True only when hard requirements are satisfied by the supplied data. */
  executable: boolean;
  /** A recommendation, never an execution gate by itself. */
  suitability: PresentationSuitability;
  explicitRequest: boolean;
  satisfiedRequirements: string[];
  missingRequirements: MissingCapabilityRequirement[];
  reasons: string[];
  issues: ValidationIssue[];
}

export interface AnalysisCapability {
  id: string;
  version: string;
  kind: AnalysisCapabilityKind;
  name: string;
  description: string;
  purposes: readonly AnalysisPurpose[];
  requirements: readonly CapabilityRequirement[];
  /** Explicit mapping; planners never infer a Rule from a prompt string. */
  rule: CapabilityRuleReference;
  evaluate(input: CapabilityEvaluationInput): CapabilityEvaluation;
}
