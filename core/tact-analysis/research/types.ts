import type { AnalysisResult, ValidationIssue } from "../types";
import type { CortexCalculationOutput } from "../calculation/types";
import type { Dataset } from "../types";
import type { ResearchPresentation } from "../presentation/types";

export type CalculationIntent = "percentage" | "growth-rate" | "cagr" | "ranking";

/** Minimal, evidence-first input shape. No new evidence IDs are created here. */
export interface NumericEvidenceSource {
  id: string;
  claim: string;
  text?: string;
}

export interface ResearchAnalysis {
  intent: CalculationIntent;
  status: "executed" | "skipped";
  result?: AnalysisResult<CortexCalculationOutput>;
  warnings: ValidationIssue[];
}

export interface ResearchCalculationRun {
  analysis?: ResearchAnalysis[];
  analysisWarnings?: ValidationIssue[];
  /** Internal semantic datasets retained for downstream Cortex adapters, not Artifact blocks. */
  datasets?: Dataset[];
}

export interface ResearchPresentationRun {
  requested: boolean;
  presentations: ResearchPresentation[];
  warnings: ValidationIssue[];
}
