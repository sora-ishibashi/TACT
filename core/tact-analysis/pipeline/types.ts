import type { AnalysisCapabilityRegistry } from "../capability/registry";
import type { CapabilityEvidenceDescriptor } from "../capability/types";
import type { Dataset, ValidationIssue } from "../types";
import type { CortexRegistry } from "../registry/CortexRegistry";
import type { AnalysisPlannerOptions, AnalysisPlannerResult, ValidatedAnalysisPlan } from "../planner/types";
import type { ResearchGapPlan } from "../gap/types";
import type { ResearchFulfillmentResult, ResearchFulfillmentSearchAdapter } from "../fulfillment/types";
import type { AnalysisPlanExecutionResult, ExecuteAnalysisPlanInput } from "../execution/types";

/** Research-independent evidence shape accepted by the canonical Cortex path. */
export interface CortexPipelineEvidence extends CapabilityEvidenceDescriptor {
  text: string;
  claim?: string;
  title?: string;
  url?: string;
}

export type CortexAnalysisPipelineStatus =
  | "not_applicable"
  | "completed"
  | "partially_completed"
  | "blocked"
  | "failed"
  | "cancelled";

export interface CortexAnalysisPipelineSummary {
  eligible: boolean;
  datasets: number;
  plannerLlmUsed: boolean;
  fulfillmentAttempted: boolean;
  executionAttempted: boolean;
  readySteps: number;
  blockedSteps: number;
}

export interface CortexAnalysisPipelineResult {
  status: CortexAnalysisPipelineStatus;
  objective: string;
  evidence: readonly CortexPipelineEvidence[];
  datasets: readonly Dataset[];
  plan?: ValidatedAnalysisPlan;
  planner?: AnalysisPlannerResult;
  gapPlan?: ResearchGapPlan;
  fulfillment?: ResearchFulfillmentResult;
  execution?: AnalysisPlanExecutionResult;
  warnings: readonly ValidationIssue[];
  summary: CortexAnalysisPipelineSummary;
}

export interface RunCortexAnalysisPipelineInput {
  objective: string;
  evidence: readonly CortexPipelineEvidence[];
  datasets?: readonly Dataset[];
  targetEntity?: string;
  cortexRegistry: CortexRegistry;
  capabilityRegistry: AnalysisCapabilityRegistry;
  planner?: Omit<AnalysisPlannerOptions, "registry">;
  searchAdapter?: ResearchFulfillmentSearchAdapter;
  fulfillmentBudget?: import("../fulfillment/types").ResearchFulfillmentBudget;
  /** Trusted explicit values only; Cortex never infers them to make a step pass. */
  explicitInputs?: Readonly<Record<string, unknown>>;
  frameworkInferenceProvider?: ExecuteAnalysisPlanInput["frameworkInferenceProvider"];
  frameworkInferenceModel?: string;
  frameworkInferenceRunLLM?: ExecuteAnalysisPlanInput["frameworkInferenceRunLLM"];
  frameworkReviewerProvider?: ExecuteAnalysisPlanInput["frameworkReviewerProvider"];
  frameworkReviewerModel?: string;
  frameworkReviewerRunLLM?: ExecuteAnalysisPlanInput["frameworkReviewerRunLLM"];
  signal?: AbortSignal;
}
