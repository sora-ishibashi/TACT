import type { MissingCapabilityRequirement } from "../capability/types";
import type { AnalysisPlanStep } from "../planner/types";
import type { ValidationIssue } from "../types";
import { deriveGapDataContext, finiteCount } from "./normalize";
import { evaluateResearchability, requirementToGapKind } from "./researchability";
import { MAX_RESEARCH_GAPS, type BuildResearchGapPlanInput, type ResearchGap, type ResearchGapPlan, type UnresolvedAnalysisRequirement } from "./types";

function warning(code: string, message: string): ValidationIssue { return { code, severity: "warning", message }; }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function hash(value: string): string { let result = 2166136261; for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619); return (result >>> 0).toString(36); }
function key(gap: Omit<ResearchGap, "id" | "requiredByStepIds" | "requiredByCapabilityIds" | "sourceRequirementIds" | "reason">): string {
  return JSON.stringify([gap.kind, gap.targetEntity, gap.metric, gap.period?.start, gap.period?.end, gap.period?.granularity, gap.unit, gap.currency, gap.priority]);
}
function unresolved(step: AnalysisPlanStep, requirement: MissingCapabilityRequirement, reason: UnresolvedAnalysisRequirement["reason"]): UnresolvedAnalysisRequirement {
  return { requirementId: requirement.requirementId, kind: requirement.kind, requiredByStepIds: [step.id], requiredByCapabilityIds: [step.capabilityId], reason, description: requirement.description };
}
function gapReason(kind: ResearchGap["kind"]): string {
  return ({ numeric_value: "Verified numeric value required by a blocked analysis step", time_series: "Additional comparable temporal point required by a blocked analysis step", comparison: "Additional comparable entity data required by a blocked analysis step", evidence: "At least one evidence item required by a blocked framework step", entity_context: "Target entity context required by a blocked analysis step", framework_coverage: "Framework coverage required by a blocked analysis step" })[kind];
}

function currentCountFor(kind: ResearchGap["kind"], requirement: MissingCapabilityRequirement, context: ReturnType<typeof deriveGapDataContext>): number | undefined {
  if (kind === "time_series") return context.temporalPointCount;
  if (kind === "comparison") return context.entityCount;
  if (kind === "numeric_value") return context.numericCount;
  if (kind === "evidence") return undefined;
  return requirement.currentCount;
}

export function mergeResearchGaps(candidates: readonly ResearchGap[]): ResearchGap[] {
  const merged = new Map<string, ResearchGap>();
  for (const candidate of candidates) {
    const candidateKey = key(candidate);
    const previous = merged.get(candidateKey);
    if (!previous) { merged.set(candidateKey, candidate); continue; }
    const counts = finiteCount(
      Math.max(previous.requiredCount ?? 0, candidate.requiredCount ?? 0),
      Math.max(previous.currentCount ?? 0, candidate.currentCount ?? 0),
    );
    merged.set(candidateKey, { ...previous, ...counts, requiredByStepIds: unique([...previous.requiredByStepIds, ...candidate.requiredByStepIds]), requiredByCapabilityIds: unique([...previous.requiredByCapabilityIds, ...candidate.requiredByCapabilityIds]), sourceRequirementIds: unique([...previous.sourceRequirementIds, ...candidate.sourceRequirementIds]) });
  }
  return [...merged.values()].sort((left, right) => left.requiredByStepIds[0].localeCompare(right.requiredByStepIds[0]) || left.kind.localeCompare(right.kind) || key(left).localeCompare(key(right)));
}

/** Applies the Phase 5C hard cap without silently discarding overflow gaps. */
export function limitResearchGaps(gaps: readonly ResearchGap[]): { retained: ResearchGap[]; overflow: ResearchGap[] } {
  const ordered = [...gaps].sort((left, right) =>
    (left.priority === "required" ? 0 : 1) - (right.priority === "required" ? 0 : 1) ||
    left.requiredByStepIds[0].localeCompare(right.requiredByStepIds[0]) ||
    left.kind.localeCompare(right.kind) || key(left).localeCompare(key(right)),
  );
  return { retained: ordered.slice(0, MAX_RESEARCH_GAPS), overflow: ordered.slice(MAX_RESEARCH_GAPS) };
}

/**
 * Builds semantic, provider-independent research gaps only. It never creates a query,
 * invokes Research, executes a Rule, or calls an LLM.
 */
export function buildResearchGapPlan(input: BuildResearchGapPlanInput): ResearchGapPlan {
  const warnings: ValidationIssue[] = [];
  const unresolvedRequirements: UnresolvedAnalysisRequirement[] = [];
  const candidateGaps: ResearchGap[] = [];
  const context = deriveGapDataContext(input);
  const blockedSteps = input.plan.steps.filter((step) => step.status === "blocked");
  let sourceRequirements = 0;

  for (const step of blockedSteps) for (const requirement of step.evaluation.missingRequirements) {
    sourceRequirements += 1;
    const kind = requirementToGapKind(requirement.kind);
    if (!kind) { unresolvedRequirements.push(unresolved(step, requirement, "not_researchable")); continue; }
    const currentCount = currentCountFor(kind, requirement, context);
    const counts = finiteCount(requirement.requiredCount, currentCount ?? requirement.currentCount);
    if (counts.missingCount === 0) {
      warnings.push(warning("RESEARCH_GAP_REQUIREMENT_ALREADY_SATISFIED", `Skipped stale missing requirement: ${requirement.requirementId}`));
      continue;
    }
    const researchability = evaluateResearchability(kind, context, counts.missingCount);
    if (!researchability.researchable) { unresolvedRequirements.push(unresolved(step, requirement, researchability.reason ?? "not_researchable")); continue; }
    const draft = {
      kind,
      ...(context.targetEntity ? { targetEntity: context.targetEntity } : {}),
      ...(context.metric ? { metric: context.metric } : {}),
      ...(context.period ? { period: kind === "time_series" ? { granularity: context.period.granularity } : context.period } : {}),
      ...(context.unit ? { unit: context.unit } : {}),
      ...(context.currency ? { currency: context.currency } : {}),
      ...counts,
      requiredByStepIds: [step.id],
      requiredByCapabilityIds: [step.capabilityId],
      sourceRequirementIds: [requirement.requirementId],
      researchable: true,
      priority: "required" as const,
      reason: gapReason(kind),
    };
    candidateGaps.push({ ...draft, id: `research-gap:${hash(key(draft))}` });
  }

  const merged = mergeResearchGaps(candidateGaps);
  const { retained, overflow } = limitResearchGaps(merged);
  for (const gap of overflow) {
    warnings.push(warning("RESEARCH_GAP_LIMIT", `Research gap limit (${MAX_RESEARCH_GAPS}) reached; gap was retained as unresolved`));
    unresolvedRequirements.push({ requirementId: gap.sourceRequirementIds[0], kind: gap.kind === "numeric_value" ? "numeric" : gap.kind === "time_series" ? "time_series" : gap.kind === "comparison" ? "comparison" : gap.kind === "evidence" ? "evidence" : "target_entity", requiredByStepIds: gap.requiredByStepIds, requiredByCapabilityIds: gap.requiredByCapabilityIds, reason: "gap_limit", description: gap.reason });
  }
  const gaps = retained.map((gap) => ({ ...gap, id: `research-gap:${hash(key(gap))}` }));
  const planId = `research-gap-plan:${hash(JSON.stringify({ plan: input.plan.id, gaps: gaps.map((gap) => gap.id), unresolved: unresolvedRequirements.map((item) => [item.requirementId, item.reason, item.requiredByStepIds]) }))}`;
  return {
    id: planId,
    objective: input.plan.objective,
    gaps,
    unresolvedRequirements,
    warnings,
    researchRequired: gaps.some((gap) => gap.researchable && gap.priority === "required"),
    summary: { blockedSteps: blockedSteps.length, sourceRequirements, mergedGaps: gaps.length, researchableGaps: gaps.filter((gap) => gap.researchable).length, unresolvedRequirements: unresolvedRequirements.length },
  };
}
