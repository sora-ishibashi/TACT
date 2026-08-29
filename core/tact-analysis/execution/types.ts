import type { AnalysisCapabilityRegistry } from "../capability/registry";
import type { CapabilityEvidenceDescriptor } from "../capability/types";
import type { FrameworkReviewRunLLM } from "../framework/reviewer";
import type { FrameworkRunLLM } from "../framework/inference";
import type { CortexRegistry } from "../registry/CortexRegistry";
import type { Dataset, AnalysisResult, ValidationIssue } from "../types";
import type { ValidatedAnalysisPlan } from "../planner/types";
import type { Provider } from "../../agent/types";

export const MAX_ANALYSIS_EXECUTION_STEPS = 5;

export interface ExecuteAnalysisPlanInput {
  plan: ValidatedAnalysisPlan;
  evidence: readonly CapabilityEvidenceDescriptor[];
  datasets: readonly Dataset[];
  registry: CortexRegistry;
  capabilityRegistry: AnalysisCapabilityRegistry;
  targetEntity?: string;
  /** Optional trusted, typed values for a planned step when no safe Dataset adapter exists (for example percentage part/whole). */
  explicitInputs?: Readonly<Record<string, unknown>>;
  frameworkInferenceProvider?: Provider;
  frameworkInferenceModel?: string;
  frameworkInferenceRunLLM?: FrameworkRunLLM;
  frameworkReviewerProvider?: Provider;
  frameworkReviewerModel?: string;
  frameworkReviewerRunLLM?: FrameworkReviewRunLLM;
  signal?: AbortSignal;
}

export type AnalysisStepExecutionStatus =
  | "completed"
  | "skipped_blocked"
  | "skipped_dependency"
  | "failed_validation"
  | "failed_execution"
  | "cancelled";

export interface AnalysisStepExecutionResult {
  stepId: string;
  capabilityId: string;
  ruleId: string;
  ruleVersion: string;
  status: AnalysisStepExecutionStatus;
  output?: AnalysisResult;
  warnings: readonly ValidationIssue[];
  sourceEvidenceIds: readonly string[];
}

export interface AnalysisExecutionTrace {
  stepId: string;
  status: AnalysisStepExecutionStatus;
  startedAt: string;
  completedAt: string;
  dependencyStepIds: readonly string[];
}

export interface AnalysisExecutionSummary {
  plannedSteps: number;
  completed: number;
  skippedBlocked: number;
  skippedDependency: number;
  failedValidation: number;
  failedExecution: number;
  cancelled: number;
}

export interface AnalysisPlanExecutionResult {
  planId: string;
  status: "completed" | "partially_completed" | "blocked" | "failed" | "cancelled";
  steps: readonly AnalysisStepExecutionResult[];
  outputs: readonly AnalysisResult[];
  warnings: readonly ValidationIssue[];
  trace: readonly AnalysisExecutionTrace[];
  summary: AnalysisExecutionSummary;
}
