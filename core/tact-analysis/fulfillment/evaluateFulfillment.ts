import { createDefaultAnalysisCapabilityRegistry } from "../capability/bootstrap";
import type { CapabilityEvaluationInput } from "../capability/types";
import { buildResearchDatasets } from "../research/buildResearchDataset";
import type { NumericEvidenceSource } from "../research/types";
import type { ValidationIssue } from "../types";
import type { ResearchGap } from "../gap/types";
import type { AnalysisPlanStep, PlanMissingCapabilityRequirement, ValidatedAnalysisPlan } from "../planner/types";
import type { GapFulfillmentResult, ResearchFulfillmentEvidence } from "./types";

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function source(evidence: ResearchFulfillmentEvidence): NumericEvidenceSource { return { id: evidence.id, claim: evidence.claim ?? evidence.text, text: evidence.text }; }

export function buildFulfillmentDatasets(evidence: readonly ResearchFulfillmentEvidence[]) {
  return buildResearchDatasets(evidence.map(source));
}

export function reEvaluateAnalysisPlan(plan: ValidatedAnalysisPlan, input: CapabilityEvaluationInput): ValidatedAnalysisPlan {
  const registry = createDefaultAnalysisCapabilityRegistry();
  const steps: AnalysisPlanStep[] = plan.steps.map((step) => {
    const evaluation = registry.evaluate(step.capabilityId, { ...input, explicitCapabilityId: step.capabilityId, explicitRequest: true }) ?? step.evaluation;
    return { ...step, evaluation, status: evaluation.valid && evaluation.executable ? "ready" : "blocked" };
  });
  const grouped = new Map<string, PlanMissingCapabilityRequirement>();
  for (const step of steps) for (const requirement of step.evaluation.missingRequirements) {
    const key = `${requirement.requirementId}\u0000${requirement.kind}`;
    const existing = grouped.get(key);
    grouped.set(key, existing ? { ...existing, requiredByStepIds: unique([...existing.requiredByStepIds, step.id]) } : { ...requirement, requiredByStepIds: [step.id] });
  }
  return { ...plan, steps, missingRequirements: [...grouped.values()], executable: steps.length > 0 && steps.every((step) => step.status === "ready") };
}

export function evaluateGapFulfillment(gaps: readonly ResearchGap[], plan: ValidatedAnalysisPlan, evidence: readonly ResearchFulfillmentEvidence[]): GapFulfillmentResult[] {
  const evidenceIds = evidence.map((item) => item.id);
  return gaps.map((gap) => {
    const dependent = plan.steps.filter((step) => gap.requiredByStepIds.includes(step.id));
    const missing = dependent.flatMap((step) => step.evaluation.missingRequirements).filter((requirement) => gap.sourceRequirementIds.includes(requirement.requirementId));
    if (!gap.researchable) return { gapId: gap.id, status: "unresolved", evidenceIds: [], requiredCount: gap.requiredCount, currentCount: gap.currentCount, reason: "Gap is not researchable without additional user or semantic context" };
    if (missing.length === 0) return { gapId: gap.id, status: "fulfilled", evidenceIds, requiredCount: gap.requiredCount, currentCount: gap.requiredCount, reason: "All dependent hard requirements are now satisfied" };
    return { gapId: gap.id, status: "still_missing", evidenceIds: [], requiredCount: gap.requiredCount, currentCount: gap.currentCount, reason: "Dependent hard requirements remain blocked after deterministic re-evaluation" };
  });
}

export function fulfillmentWarnings(buildWarnings: readonly ValidationIssue[]): ValidationIssue[] { return [...buildWarnings]; }
