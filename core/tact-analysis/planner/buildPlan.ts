import { createDefaultAnalysisCapabilityRegistry } from "../capability/bootstrap";
import type { CapabilityEvaluationInput } from "../capability/types";
import { buildAnalysisPlannerInput, buildDeterministicPlanCandidate, requestAnalysisPlanCandidate } from "./candidate";
import type { AnalysisPlannerOptions, AnalysisPlannerResult } from "./types";
import { validateAnalysisPlanCandidate } from "./validate";

function summary(llmUsed: boolean, candidateSteps: number, plan: ReturnType<typeof validateAnalysisPlanCandidate> | undefined, rejectedFromProvider = 0) {
  const steps = plan?.steps ?? [];
  const rejected = rejectedFromProvider + (plan?.warnings.filter((warning) => /^(?:PLANNER_UNKNOWN_CAPABILITY|PLANNER_UNOFFERED_CAPABILITY|PLANNER_INVALID_REASON|PLANNER_REASON_TOO_LONG|PLANNER_PURPOSE_MISMATCH|PLANNER_UNKNOWN_DEPENDENCY|PLANNER_SELF_DEPENDENCY|PLANNER_DEPENDENCY_CYCLE)$/.test(warning.code)).length ?? 0);
  return { llmUsed, candidateSteps, acceptedSteps: steps.length, rejectedSteps: rejected, readySteps: steps.filter((step) => step.status === "ready").length, blockedSteps: steps.filter((step) => step.status === "blocked").length };
}

/**
 * Builds a validated plan only. It never executes Rules, Research, or Artifact mutation.
 * Explicit/simple requests are deterministic; an ambiguous generic objective may use one LLM call.
 */
export async function buildConstrainedAnalysisPlan(input: CapabilityEvaluationInput, options: AnalysisPlannerOptions = {}): Promise<AnalysisPlannerResult> {
  const registry = options.registry ?? createDefaultAnalysisCapabilityRegistry();
  const plannerInput = buildAnalysisPlannerInput(input, registry);
  const deterministic = buildDeterministicPlanCandidate(plannerInput);
  if (deterministic) {
    const plan = validateAnalysisPlanCandidate(plannerInput, deterministic, registry);
    return { plan, warnings: plan.warnings, summary: summary(false, deterministic.steps.length, plan) };
  }
  if (plannerInput.purposes.length === 0 || plannerInput.availableCapabilities.length === 0) {
    const warnings = [{ code: "PLANNER_NO_CANDIDATE", severity: "info" as const, message: "No deterministic purpose-compatible capability candidate was available" }];
    return { warnings, summary: summary(false, 0, undefined) };
  }
  const requested = await requestAnalysisPlanCandidate(plannerInput, options);
  if (!requested.candidate) {
    const warnings = [{ code: "PLANNER_CANDIDATE_FAILED", severity: "warning" as const, message: requested.error ?? "Planner did not return a candidate" }];
    return { warnings, summary: summary(requested.llmUsed, 0, undefined) };
  }
  const plan = validateAnalysisPlanCandidate(plannerInput, requested.candidate, registry);
  return { plan, warnings: plan.warnings, summary: summary(requested.llmUsed, requested.candidate.steps.length, plan) };
}
