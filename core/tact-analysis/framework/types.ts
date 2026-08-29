import type { CortexRule, Dataset, EvidenceRequirement, ValidationIssue } from "../types";
import type { NumericEvidenceSource } from "../research/types";

export type FrameworkId = "framework.swot" | "framework.3c" | "framework.pest";
export type FrameworkItemKind = "fact" | "inference";
export interface FrameworkSectionDefinition { id: string; label: string; description: string; required: boolean; }
export interface FrameworkDefinition { id: FrameworkId; version: string; name: string; purpose: string; sections: FrameworkSectionDefinition[]; requirements: EvidenceRequirement[]; }
export interface FrameworkItem { id: string; sectionId: string; text: string; kind: FrameworkItemKind; sourceEvidenceIds: string[]; confidence?: "high" | "medium" | "low"; review?: FrameworkItemReview; }
export interface FrameworkSection { id: string; label: string; items: FrameworkItem[]; sourceEvidenceIds: string[]; }
export interface FrameworkResult { frameworkId: FrameworkId; frameworkVersion: string; sections: FrameworkSection[]; sourceEvidenceIds: string[]; warnings: ValidationIssue[]; reviewResult?: FrameworkReviewResult; reviewSummary?: FrameworkReviewSummary; }
export interface FrameworkInput { objective: string; targetEntity?: string; evidence: readonly NumericEvidenceSource[]; datasets?: readonly Dataset[]; }
export interface FrameworkInferenceCandidate { sectionId: string; text: string; sourceEvidenceIds: string[]; confidence?: "high" | "medium" | "low"; }
export interface FrameworkInferenceRequest { frameworkId: FrameworkId; objective: string; targetEntity?: string; allowedSections: string[]; facts: FrameworkItem[]; evidence: { id: string; text: string }[]; }
export interface FrameworkInferenceRun { attempted: boolean; llmUsed: boolean; acceptedCount: number; warnings: ValidationIssue[]; }
export type FrameworkReviewVerdict = "supported" | "partially_supported" | "unsupported";
export interface FrameworkInferenceReview { inferenceId: string; verdict: FrameworkReviewVerdict; supportedEvidenceIds: string[]; reason: string; }
export interface FrameworkReviewRequest { frameworkId: FrameworkId; objective: string; items: { inferenceId: string; sectionId: string; inferenceText: string; evidence: { id: string; text: string }[] }[]; }
export interface FrameworkReviewResult { reviews: FrameworkInferenceReview[]; warnings: ValidationIssue[]; }
export interface FrameworkReviewSummary { generated: number; reviewed: number; supported: number; partiallySupported: number; unsupported: number; invalid: number; failed: boolean; llmUsed: boolean; }
export interface FrameworkItemReview { verdict: FrameworkReviewVerdict; supportedEvidenceIds: string[]; reason: string; }
export interface ResearchFrameworkArtifact { frameworkId: FrameworkId; block: import("../../tact-artifact/types").TableBlock; }
export interface FrameworkReference { id: string; frameworkId: FrameworkId; title: string; description?: string; sections: FrameworkSection[]; tags?: string[]; }
export type FrameworkRule = CortexRule<FrameworkInput, FrameworkResult> & { definition: FrameworkDefinition };
export interface ResearchFrameworkAnalysis { frameworkId: FrameworkId; result?: import("../types").AnalysisResult<FrameworkResult>; warnings: ValidationIssue[]; inference?: FrameworkInferenceRun; reviewer?: FrameworkReviewSummary; }
