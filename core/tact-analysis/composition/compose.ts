import type { ArtifactBlock, TableBlock } from "../../tact-artifact/types";
import { frameworkResultToTableBlock } from "../framework/artifactIntegration";
import type { FrameworkResult } from "../framework/types";
import type { CortexCalculationOutput, RankingCalculationResult } from "../calculation/types";
import type { AnalysisResult, Dataset, ValidationIssue } from "../types";
import type { CortexAnalysisPipelineResult } from "../pipeline/types";
import type { AnalysisArtifactCandidate, AnalysisArtifactPlan } from "./types";
import { applyArtifactCompositionQuality, mergeArtifactBlockProvenance, structuralBlockSignature } from "./quality";

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function warning(code: string, message: string): ValidationIssue { return { code, severity: "warning", message }; }
function isFramework(value: unknown): value is FrameworkResult { return Boolean(value && typeof value === "object" && "frameworkId" in value && "sections" in value); }
function isPresentation(value: unknown): value is { block: ArtifactBlock } { return Boolean(value && typeof value === "object" && "block" in value && (value as { block?: unknown }).block); }
function isRanking(value: CortexCalculationOutput): value is RankingCalculationResult { return value.formulaId === "ranking"; }
function isCompletedValidated(step: NonNullable<CortexAnalysisPipelineResult["execution"]>["steps"][number]): boolean {
  return step.status === "completed"
    && Boolean(step.output?.output)
    && step.output?.status !== "failed"
    && !step.output?.warnings.some((item) => item.severity === "error");
}
const calculationHeading: Record<Exclude<CortexCalculationOutput["formulaId"], "ranking"> | "ranking", string> = {
  percentage: "割合", "growth-rate": "成長率", cagr: "CAGR", ranking: "ランキング",
};
const frameworkHeading: Record<FrameworkResult["frameworkId"], string> = {
  "framework.swot": "SWOT分析", "framework.3c": "3C分析", "framework.pest": "PEST分析",
};

function calculationBlock(stepId: string, result: AnalysisResult<CortexCalculationOutput>): TableBlock | undefined {
  if (!result.output) return undefined;
  const output = result.output;
  const now = new Date().toISOString();
  if (isRanking(output)) {
    return {
      id: `cortex-calculation:${stepId}`, type: "table", title: calculationHeading.ranking, columns: ["Item", "Value", "Rank", "Evidence"],
      rows: output.rankings.map((item) => [item.id, item.value.raw, String(item.rank), item.sourceEvidenceIds.join(", ")]),
      sourceEvidenceIds: [...output.sourceEvidenceIds], rowSourceEvidenceIds: output.rankings.map((item) => [...item.sourceEvidenceIds]),
      cellSourceEvidenceIds: output.rankings.map((item) => [undefined, [...item.sourceEvidenceIds], [...item.sourceEvidenceIds], [...item.sourceEvidenceIds]]),
      tablePurpose: "comparison", order: 0, createdAt: now, updatedAt: now,
    };
  }
  const outputIds = output.sourceEvidenceIds;
  return {
    id: `cortex-calculation:${stepId}`, type: "table", title: calculationHeading[output.formulaId],
    columns: ["Calculation", "Display value", "Raw value", "Formula", "Evidence"],
    rows: [[output.formulaId, output.displayValue ?? String(output.value), String(output.value), output.formula, outputIds.join(", ")]],
    sourceEvidenceIds: [...outputIds], rowSourceEvidenceIds: [[...outputIds]],
    cellSourceEvidenceIds: [[undefined, [...outputIds], [...outputIds], undefined, [...outputIds]]],
    tablePurpose: "comparison", order: 0, createdAt: now, updatedAt: now,
  };
}

function presentationHeadingFor(output: unknown, datasets: readonly Dataset[]): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const candidate = output as { datasetId?: unknown; type?: unknown };
  if (typeof candidate.datasetId !== "string" || (candidate.type !== "table" && candidate.type !== "bar-chart" && candidate.type !== "line-chart")) return undefined;
  const metric = datasets.find((dataset) => dataset.id === candidate.datasetId)?.rows[0]?.values.metric?.raw;
  if (typeof metric !== "string" || !metric.trim()) return undefined;
  if (candidate.type === "line-chart") return `${metric.trim()}推移`;
  if (candidate.type === "bar-chart") return `${metric.trim()}比較`;
  return metric.trim();
}

function withDeterministicHeading(block: ArtifactBlock, capabilityId: string, output: unknown, datasets: readonly Dataset[]): ArtifactBlock {
  const heading = capabilityId.startsWith("framework.") && isFramework(output)
    ? frameworkHeading[output.frameworkId]
    : capabilityId.startsWith("presentation.")
      ? presentationHeadingFor(output, datasets)
      : block.title;
  return { ...block, ...(heading ? { title: heading } : { title: undefined }) };
}

function blockEvidenceIds(block: ArtifactBlock): string[] {
  return block.type === "table" || block.type === "chart" ? [...(block.sourceEvidenceIds ?? [])] : [];
}

/**
 * Builds presentation-only Artifact blocks from completed execution results.
 * It neither invokes a Rule/LLM/Search nor changes Artifact persistence.
 */
export function composeAnalysisArtifactPlan(result: CortexAnalysisPipelineResult): AnalysisArtifactPlan {
  try {
    const plannedById = new Map((result.plan?.steps ?? []).map((step) => [step.id, step]));
    // An execution record alone is not an Artifact entitlement: it must be a
    // completed, validation-clean output for a step in the validated Plan.
    const completed = result.execution?.steps.filter((step) => plannedById.has(step.stepId) && isCompletedValidated(step)) ?? [];
    const candidates: AnalysisArtifactCandidate[] = [];
    const warnings: ValidationIssue[] = [];
    for (const [planStepOrder, step] of completed.entries()) {
      const output = step.output!;
      let block: ArtifactBlock | undefined;
      if (step.capabilityId.startsWith("presentation.") && isPresentation(output.output)) block = output.output.block;
      else if (step.capabilityId.startsWith("framework.") && isFramework(output.output)) block = frameworkResultToTableBlock(output.output);
      else if (step.capabilityId.startsWith("calculation.")) block = calculationBlock(step.stepId, output as AnalysisResult<CortexCalculationOutput>);
      if (!block) { warnings.push(warning("COMPOSITION_UNSUPPORTED_OUTPUT", `Completed output ${step.stepId} has no safe Artifact adapter`)); continue; }
      candidates.push({
        block: withDeterministicHeading(block, step.capabilityId, output.output, result.datasets),
        role: "detail",
        sourceStepIds: [step.stepId],
        capabilityIds: [step.capabilityId],
        explicitRequest: plannedById.get(step.stepId)?.evaluation.explicitRequest === true,
        planStepOrder,
      });
    }
    const quality = applyArtifactCompositionQuality(result.objective, candidates);
    const blocks = quality.candidates.map((candidate, order) => ({ ...candidate.block, order }));
    return {
      blocks,
      sourceStepIds: unique(quality.candidates.flatMap((candidate) => candidate.sourceStepIds)),
      sourceEvidenceIds: unique(quality.candidates.flatMap((candidate) => [
        ...candidate.sourceStepIds.flatMap((stepId) => completed.find((step) => step.stepId === stepId)?.sourceEvidenceIds ?? []),
        ...blockEvidenceIds(candidate.block),
      ])),
      warnings: [...warnings, ...quality.warnings],
      candidates: quality.candidates,
    };
  } catch (error) {
    return { blocks: [], sourceStepIds: [], sourceEvidenceIds: [], warnings: [warning("COMPOSITION_FAILED", error instanceof Error ? error.message : "Artifact composition was skipped")], candidates: [] };
  }
}

/** Pure block-array merge for the existing Conversation mutation owner. */
export function mergeAnalysisArtifactPlanBlocks(existing: readonly ArtifactBlock[], plan: AnalysisArtifactPlan): ArtifactBlock[] {
  const result = [...existing];
  for (const block of plan.blocks) {
    const index = result.findIndex((candidate) => structuralBlockSignature(candidate) === structuralBlockSignature(block));
    if (index >= 0) {
      result[index] = { ...mergeArtifactBlockProvenance(result[index]!, block), order: result[index]!.order, updatedAt: new Date().toISOString() };
    } else {
      result.push({ ...block, order: result.length, updatedAt: new Date().toISOString() });
    }
  }
  return result;
}
