import { createDefaultAnalysisCapabilityRegistry } from "../capability/bootstrap";
import { buildResearchDatasets } from "../research/buildResearchDataset";
import { buildConstrainedAnalysisPlan } from "../planner/buildPlan";
import { buildResearchGapPlan } from "../gap/buildGapPlan";
import { runResearchFulfillment } from "../fulfillment/runFulfillment";
import { executeAnalysisPlan } from "../execution/executePlan";
import type { Dataset, ValidationIssue } from "../types";
import { isCortexAnalysisEligible } from "./eligibility";
import type { CortexAnalysisPipelineResult, CortexPipelineEvidence, RunCortexAnalysisPipelineInput } from "./types";

function uniqueWarnings(warnings: readonly ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}\u0000${warning.path ?? ""}\u0000${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numericEvidence(evidence: readonly CortexPipelineEvidence[]) {
  return evidence.map((item) => ({ id: item.id, claim: item.claim ?? item.text, text: item.text }));
}

function empty(input: RunCortexAnalysisPipelineInput): CortexAnalysisPipelineResult {
  return {
    status: "not_applicable", objective: input.objective, evidence: input.evidence, datasets: input.datasets ?? [], warnings: [],
    summary: { eligible: false, datasets: input.datasets?.length ?? 0, plannerLlmUsed: false, fulfillmentAttempted: false, executionAttempted: false, readySteps: 0, blockedSteps: 0 },
  };
}

function statusFromExecution(execution: NonNullable<CortexAnalysisPipelineResult["execution"]>): CortexAnalysisPipelineResult["status"] {
  return execution.status;
}

/**
 * The sole Cortex composition path: build Dataset once, plan once, optionally
 * fulfill bounded hard gaps, then execute the validated plan once. It neither
 * mutates Artifacts nor recursively invokes Research.
 */
async function runCortexAnalysisPipelineInternal(input: RunCortexAnalysisPipelineInput): Promise<CortexAnalysisPipelineResult> {
  if (!isCortexAnalysisEligible(input.objective)) return empty(input);

  const capabilityRegistry = input.capabilityRegistry ?? createDefaultAnalysisCapabilityRegistry();
  const initialBuild = input.datasets ? undefined : buildResearchDatasets(numericEvidence(input.evidence));
  let evidence: readonly CortexPipelineEvidence[] = input.evidence;
  let datasets: readonly Dataset[] = input.datasets ?? initialBuild?.datasets ?? [];
  const warnings: ValidationIssue[] = [...(initialBuild?.warnings ?? [])];

  const planner = await buildConstrainedAnalysisPlan({
    objective: input.objective,
    targetEntity: input.targetEntity,
    evidence,
    datasets,
  }, { ...input.planner, registry: capabilityRegistry });
  warnings.push(...planner.warnings);
  if (!planner.plan) {
    return {
      status: "failed", objective: input.objective, evidence, datasets, planner, warnings: uniqueWarnings(warnings),
      summary: { eligible: true, datasets: datasets.length, plannerLlmUsed: planner.summary.llmUsed, fulfillmentAttempted: false, executionAttempted: false, readySteps: 0, blockedSteps: 0 },
    };
  }

  let plan = planner.plan;
  let gapPlan = plan.steps.some((step) => step.status === "blocked")
    ? buildResearchGapPlan({ plan, targetEntity: input.targetEntity, datasets, evidenceDescriptors: evidence })
    : undefined;
  if (gapPlan) warnings.push(...gapPlan.warnings);
  let fulfillment: CortexAnalysisPipelineResult["fulfillment"];
  if (gapPlan?.researchRequired && input.searchAdapter) {
    fulfillment = await runResearchFulfillment({
      objective: input.objective, plan, gapPlan, existingEvidence: evidence, datasets, targetEntity: input.targetEntity,
      budget: input.fulfillmentBudget, search: input.searchAdapter, signal: input.signal,
    });
    plan = fulfillment.updatedPlan;
    evidence = fulfillment.evidence;
    const rebuilt = buildResearchDatasets(numericEvidence(evidence));
    datasets = rebuilt.datasets;
    warnings.push(...fulfillment.warnings, ...rebuilt.warnings);
    gapPlan = buildResearchGapPlan({ plan, targetEntity: input.targetEntity, datasets, evidenceDescriptors: evidence });
    warnings.push(...gapPlan.warnings);
  }

  const execution = await executeAnalysisPlan({
    plan, evidence, datasets, registry: input.cortexRegistry, capabilityRegistry, targetEntity: input.targetEntity,
    explicitInputs: input.explicitInputs, frameworkInferenceProvider: input.frameworkInferenceProvider,
    frameworkInferenceModel: input.frameworkInferenceModel, frameworkInferenceRunLLM: input.frameworkInferenceRunLLM,
    frameworkReviewerProvider: input.frameworkReviewerProvider, frameworkReviewerModel: input.frameworkReviewerModel,
    frameworkReviewerRunLLM: input.frameworkReviewerRunLLM, signal: input.signal,
  });
  warnings.push(...execution.warnings);
  return {
    status: statusFromExecution(execution), objective: input.objective, evidence, datasets, plan, planner, gapPlan, fulfillment, execution,
    warnings: uniqueWarnings(warnings),
    summary: {
      eligible: true, datasets: datasets.length, plannerLlmUsed: planner.summary.llmUsed, fulfillmentAttempted: Boolean(fulfillment), executionAttempted: true,
      readySteps: plan.steps.filter((step) => step.status === "ready").length, blockedSteps: plan.steps.filter((step) => step.status === "blocked").length,
    },
  };
}

/** Failure isolation boundary for canonical Research: Cortex failures are data, never Research exceptions. */
export async function runCortexAnalysisPipeline(input: RunCortexAnalysisPipelineInput): Promise<CortexAnalysisPipelineResult> {
  try {
    return await runCortexAnalysisPipelineInternal(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected Cortex analysis pipeline failure";
    return {
      status: "failed", objective: input.objective, evidence: input.evidence, datasets: input.datasets ?? [],
      warnings: [{ code: "CORTEX_PIPELINE_FAILED", severity: "warning", message }],
      summary: { eligible: isCortexAnalysisEligible(input.objective), datasets: input.datasets?.length ?? 0, plannerLlmUsed: false, fulfillmentAttempted: false, executionAttempted: false, readySteps: 0, blockedSteps: 0 },
    };
  }
}
