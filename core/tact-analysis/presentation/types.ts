import type { ArtifactBlock } from "../../tact-artifact/types";
import type { Dataset, ValidationIssue } from "../types";

export type PresentationType = "table" | "bar-chart" | "line-chart";
export type PresentationSuitability = "high" | "medium" | "low" | "not-recommended";

/** Validity answers “can this be rendered safely?”; suitability answers “is it a good default?”. */
export interface PresentationRecommendation {
  valid: boolean;
  suitability: PresentationSuitability;
  reasons: string[];
  issues: ValidationIssue[];
}

export interface ResearchPresentation {
  type: PresentationType;
  datasetId: string;
  recommendation: PresentationRecommendation;
  block: Extract<ArtifactBlock, { type: "table" | "chart" }>;
}

export interface PresentationBuildResult {
  requested: boolean;
  presentations: ResearchPresentation[];
  warnings: ValidationIssue[];
}

export interface PresentationDatasetShape {
  dataset: Dataset;
  kind: "time-series" | "comparison" | "generic";
  rowCount: number;
  entityCount: number;
  metricCount: number;
  periodCount: number;
  issues: ValidationIssue[];
}
