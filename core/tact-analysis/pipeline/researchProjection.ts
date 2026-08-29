import { buildResearchFrameworkArtifacts } from "../framework/artifactIntegration";
import type { FrameworkResult, ResearchFrameworkAnalysis } from "../framework/types";
import { evaluatePresentation } from "../presentation/evaluatePresentation";
import type { PresentationType, ResearchPresentation } from "../presentation/types";
import type { CortexCalculationOutput } from "../calculation/types";
import type { ResearchAnalysis } from "../research/types";
import type { AnalysisResult, ValidationIssue } from "../types";
import type { CortexAnalysisPipelineResult } from "./types";

function isFramework(value: unknown): value is FrameworkResult {
  return Boolean(value && typeof value === "object" && "frameworkId" in value && "sections" in value);
}

function intentFor(capabilityId: string): ResearchAnalysis["intent"] | undefined {
  const id = capabilityId.slice("calculation.".length);
  return id === "percentage" || id === "growth-rate" || id === "cagr" || id === "ranking" ? id : undefined;
}

function isPresentationOutput(value: unknown): value is { datasetId: string; type: PresentationType; block: ResearchPresentation["block"]; warnings: ValidationIssue[] } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.datasetId === "string"
    && (candidate.type === "table" || candidate.type === "bar-chart" || candidate.type === "line-chart")
    && Boolean(candidate.block)
    && Array.isArray(candidate.warnings);
}

/** Compatibility-only projection; it executes no Rule or adapter twice. */
export function projectCortexPipelineForResearch(result: CortexAnalysisPipelineResult): {
  analysis?: ResearchAnalysis[];
  analysisWarnings?: ValidationIssue[];
  presentations?: ResearchPresentation[];
  presentationWarnings?: ValidationIssue[];
  presentationRequested?: boolean;
  frameworks?: ResearchFrameworkAnalysis[];
  frameworkWarnings?: ValidationIssue[];
  frameworkArtifacts?: ReturnType<typeof buildResearchFrameworkArtifacts>;
  frameworkArtifactRequested?: boolean;
} {
  const steps = result.execution?.steps ?? [];
  const analysis: ResearchAnalysis[] = [];
  const presentations: ResearchPresentation[] = [];
  const frameworks: ResearchFrameworkAnalysis[] = [];
  const analysisWarnings: ValidationIssue[] = [];
  const presentationWarnings: ValidationIssue[] = [];
  const frameworkWarnings: ValidationIssue[] = [];
  let presentationRequested = false;
  let frameworkRequested = false;

  for (const step of steps) {
    const intent = step.capabilityId.startsWith("calculation.") ? intentFor(step.capabilityId) : undefined;
    if (intent) {
      const executed = step.status === "completed" && step.output;
      analysis.push({ intent, status: executed ? "executed" : "skipped", ...(executed ? { result: step.output as AnalysisResult<CortexCalculationOutput> } : {}), warnings: [...step.warnings] });
      analysisWarnings.push(...step.warnings);
      continue;
    }
    if (step.capabilityId.startsWith("presentation.")) {
      presentationRequested = true;
      if (step.status === "completed" && isPresentationOutput(step.output?.output)) {
        const output = step.output.output;
        const dataset = result.datasets.find((candidate) => candidate.id === output.datasetId);
        if (dataset) presentations.push({ type: output.type, datasetId: output.datasetId, recommendation: evaluatePresentation(dataset, output.type), block: output.block });
      }
      presentationWarnings.push(...step.warnings);
      continue;
    }
    if (step.capabilityId.startsWith("framework.")) {
      frameworkRequested = true;
      if (step.status === "completed" && isFramework(step.output?.output)) {
        frameworks.push({ frameworkId: step.output.output.frameworkId, result: step.output as AnalysisResult<FrameworkResult>, warnings: [...step.warnings] });
      }
      frameworkWarnings.push(...step.warnings);
    }
  }
  const frameworkArtifacts = buildResearchFrameworkArtifacts(frameworks.flatMap((item) => item.result?.output ? [item.result.output] : []));
  return {
    ...(analysis.length ? { analysis } : {}), ...(analysisWarnings.length ? { analysisWarnings } : {}),
    ...(presentations.length ? { presentations } : {}), ...(presentationWarnings.length ? { presentationWarnings } : {}), ...(presentationRequested ? { presentationRequested } : {}),
    ...(frameworks.length ? { frameworks } : {}), ...(frameworkWarnings.length ? { frameworkWarnings } : {}),
    ...(frameworkArtifacts.length ? { frameworkArtifacts } : {}), ...(frameworkRequested ? { frameworkArtifactRequested: true } : {}),
  };
}
