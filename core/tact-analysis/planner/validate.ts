import type { AnalysisCapabilityRegistry } from "../capability/registry";
import type { AnalysisPurpose, CapabilityEvaluation } from "../capability/types";
import type { ValidationIssue } from "../types";
import { MAX_PLAN_REASON_LENGTH, MAX_PLAN_STEPS, type AnalysisPlanCandidate, type AnalysisPlanCandidateStep, type AnalysisPlanStep, type AnalysisPlannerInput, type PlanMissingCapabilityRequirement, type ValidatedAnalysisPlan } from "./types";

function warning(code: string, message: string, path?: string): ValidationIssue { return { code, severity: "warning", message, path }; }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function normalized(text: string): string { return text.trim().replace(/\s+/g, " "); }
function stepId(capabilityId: string): string { return `step:${capabilityId}`; }
function stableHash(text: string): string { let value = 2166136261; for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619); return (value >>> 0).toString(36); }

function candidateWithLocks(input: AnalysisPlannerInput, candidate: AnalysisPlanCandidate): AnalysisPlanCandidateStep[] {
  const existing = new Set(candidate.steps.map((step) => step.capabilityId));
  const locks = input.lockedCapabilityIds.filter((capabilityId) => !existing.has(capabilityId)).map((capabilityId) => ({ capabilityId, reason: "Explicit user capability request" }));
  return [...locks, ...candidate.steps];
}

function purposeIntersection(capabilityPurposes: readonly AnalysisPurpose[], purposes: readonly AnalysisPurpose[]): AnalysisPurpose[] {
  return capabilityPurposes.filter((purpose) => purposes.includes(purpose));
}

function aggregateMissing(steps: readonly AnalysisPlanStep[]): PlanMissingCapabilityRequirement[] {
  const grouped = new Map<string, PlanMissingCapabilityRequirement>();
  for (const step of steps) for (const requirement of step.evaluation.missingRequirements) {
    const key = `${requirement.requirementId}\0${requirement.kind}\0${requirement.description}\0${requirement.requiredCount ?? ""}`;
    const previous = grouped.get(key);
    if (previous) grouped.set(key, { ...previous, currentCount: Math.min(previous.currentCount ?? Number.POSITIVE_INFINITY, requirement.currentCount ?? Number.POSITIVE_INFINITY), requiredByStepIds: unique([...previous.requiredByStepIds, step.id]) });
    else grouped.set(key, { ...requirement, requiredByStepIds: [step.id] });
  }
  return [...grouped.values()].map((item) => ({ ...item, ...(item.currentCount === Number.POSITIVE_INFINITY ? { currentCount: undefined } : {}) })).sort((left, right) => left.requirementId.localeCompare(right.requirementId) || left.description.localeCompare(right.description));
}

function hasCycle(steps: readonly AnalysisPlanStep[]): Set<string> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>(); const visited = new Set<string>(); const cycle = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { cycle.add(id); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) { visit(dependency); if (cycle.has(dependency)) cycle.add(id); }
    visiting.delete(id); visited.add(id);
  };
  for (const step of steps) visit(step.id);
  return cycle;
}

/** Deterministically turns an untrusted candidate into a constrained, non-executing plan. */
export function validateAnalysisPlanCandidate(input: AnalysisPlannerInput, candidate: AnalysisPlanCandidate, registry: AnalysisCapabilityRegistry): ValidatedAnalysisPlan {
  const warnings: ValidationIssue[] = [];
  const offered = new Set(input.availableCapabilities.map((capability) => capability.id));
  const byCapability = new Map<string, AnalysisPlanCandidateStep>();
  const aliases = new Map<string, string>();

  for (const [index, entry] of candidateWithLocks(input, candidate).entries()) {
    const locked = input.lockedCapabilityIds.includes(entry.capabilityId);
    const capability = registry.get(entry.capabilityId);
    if (!capability) { warnings.push(warning("PLANNER_UNKNOWN_CAPABILITY", `Unknown capability: ${entry.capabilityId}`, `steps.${index}.capabilityId`)); continue; }
    if (!offered.has(entry.capabilityId)) { warnings.push(warning("PLANNER_UNOFFERED_CAPABILITY", `Capability was not offered to this planner: ${entry.capabilityId}`, `steps.${index}.capabilityId`)); continue; }
    const reason = normalized(entry.reason);
    if (!reason) { warnings.push(warning("PLANNER_INVALID_REASON", "Plan steps require a non-empty reason", `steps.${index}.reason`)); continue; }
    if (reason.length > MAX_PLAN_REASON_LENGTH) { warnings.push(warning("PLANNER_REASON_TOO_LONG", `Plan step reason exceeds ${MAX_PLAN_REASON_LENGTH} characters`, `steps.${index}.reason`)); continue; }
    const matchingPurposes = purposeIntersection(capability.purposes, input.purposes);
    if (!locked && input.purposes.length > 0 && matchingPurposes.length === 0) { warnings.push(warning("PLANNER_PURPOSE_MISMATCH", `Capability does not match a detected purpose: ${entry.capabilityId}`, `steps.${index}.capabilityId`)); continue; }
    const previous = byCapability.get(entry.capabilityId);
    if (previous) {
      byCapability.set(entry.capabilityId, { ...previous, dependsOn: unique([...(previous.dependsOn ?? []), ...(entry.dependsOn ?? [])]) });
      aliases.set(entry.id ?? entry.capabilityId, entry.capabilityId);
      warnings.push(warning("PLANNER_DUPLICATE_CAPABILITY", `Duplicate capability was merged: ${entry.capabilityId}`, `steps.${index}`));
      continue;
    }
    byCapability.set(entry.capabilityId, { ...entry, reason: locked ? "Explicit user capability request" : reason });
    aliases.set(entry.capabilityId, entry.capabilityId);
    aliases.set(stepId(entry.capabilityId), entry.capabilityId);
    if (entry.id?.trim()) aliases.set(entry.id, entry.capabilityId);
  }

  const selected = [...byCapability.values()].slice(0, MAX_PLAN_STEPS);
  if (byCapability.size > MAX_PLAN_STEPS) warnings.push(warning("PLANNER_MAX_STEPS", `Plan was limited to ${MAX_PLAN_STEPS} steps`));
  const selectedIds = new Set(selected.map((step) => step.capabilityId));
  const draft: AnalysisPlanStep[] = [];
  for (const entry of selected) {
    const capability = registry.get(entry.capabilityId)!;
    const evaluation: CapabilityEvaluation = capability.evaluate({ ...input.capabilityInput, explicitRequest: input.lockedCapabilityIds.includes(capability.id), explicitCapabilityId: input.lockedCapabilityIds.includes(capability.id) ? capability.id : undefined });
    const unresolved = (entry.dependsOn ?? []).filter((dependency) => !aliases.has(dependency) || !selectedIds.has(aliases.get(dependency)!));
    if (unresolved.length > 0) {
      warnings.push(warning("PLANNER_UNKNOWN_DEPENDENCY", `Plan step has unknown dependency: ${unresolved.join(", ")}`, `steps.${entry.capabilityId}.dependsOn`));
      continue;
    }
    const dependencies = unique((entry.dependsOn ?? []).map((dependency) => stepId(aliases.get(dependency)!)));
    const id = stepId(capability.id);
    if (dependencies.includes(id)) { warnings.push(warning("PLANNER_SELF_DEPENDENCY", `Plan step cannot depend on itself: ${capability.id}`, `steps.${capability.id}.dependsOn`)); continue; }
    draft.push({ id, capabilityId: capability.id, ruleId: capability.rule.id, ruleVersion: capability.rule.version, purposes: purposeIntersection(capability.purposes, input.purposes), evaluation, dependsOn: dependencies, status: evaluation.valid && evaluation.executable ? "ready" : "blocked", reason: entry.reason });
  }

  const cycle = hasCycle(draft);
  const steps = cycle.size === 0 ? draft : draft.filter((step) => {
    if (!cycle.has(step.id)) return true;
    warnings.push(warning("PLANNER_DEPENDENCY_CYCLE", `Plan step is part of a dependency cycle: ${step.capabilityId}`, `steps.${step.capabilityId}.dependsOn`));
    return false;
  });
  const missingRequirements = aggregateMissing(steps);
  const executable = steps.length > 0 && steps.every((step) => step.status === "ready");
  const id = `analysis-plan:${stableHash(JSON.stringify({ objective: input.objective, purposes: input.purposes, steps: steps.map((step) => [step.capabilityId, step.dependsOn]) }))}`;
  return { id, objective: input.objective, purposes: [...input.purposes], steps, missingRequirements, warnings, executable };
}
