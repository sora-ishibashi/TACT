import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildAnalysisPlannerInput,
  createDefaultAnalysisCapabilityRegistry,
  validateAnalysisPlanCandidate,
  type AnalysisPlannerInput,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const registry = createDefaultAnalysisCapabilityRegistry();
function input(purposes: AnalysisPlannerInput["purposes"], offered: string[] = registry.list().map((capability) => capability.id)): AnalysisPlannerInput {
  const base = buildAnalysisPlannerInput({ objective: "analysis" }, registry);
  return {
    ...base,
    purposes,
    availableCapabilities: registry.list().filter((capability) => offered.includes(capability.id)).map((capability) => ({ id: capability.id, kind: capability.kind, purposes: capability.purposes, description: capability.description, executable: false, suitability: "low", missingRequirements: [] })),
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const trend = input(["trend"], ["calculation.cagr", "presentation.line", "calculation.growth-rate"]);

  const valid = validateAnalysisPlanCandidate(trend, { steps: [{ id: "growth", capabilityId: "calculation.growth-rate", reason: "Measure the requested trend" }, { capabilityId: "presentation.line", reason: "Visualize the requested trend", dependsOn: ["growth"] }] }, registry);
  results.push(check("[Dependency1] valid dependency normalizes to deterministic step IDs", valid.steps.length === 2 && valid.steps[1].dependsOn[0] === "step:calculation.growth-rate"));
  results.push(check("[Applicability] unavailable data makes accepted steps blocked without discarding them", valid.steps.every((step) => step.status === "blocked") && valid.executable === false));

  const unknown = validateAnalysisPlanCandidate(trend, { steps: [{ capabilityId: "analysis.magic", reason: "Invented" }] }, registry);
  results.push(check("[Allowlist1] unknown capability is rejected", unknown.steps.length === 0 && unknown.warnings.some((warning) => warning.code === "PLANNER_UNKNOWN_CAPABILITY")));

  const unoffered = validateAnalysisPlanCandidate(input(["trend"], ["calculation.cagr"]), { steps: [{ capabilityId: "presentation.line", reason: "Not offered" }] }, registry);
  results.push(check("[Allowlist2] known but unoffered capability is rejected", unoffered.steps.length === 0 && unoffered.warnings.some((warning) => warning.code === "PLANNER_UNOFFERED_CAPABILITY")));

  const mismatch = validateAnalysisPlanCandidate(input(["ratio"], ["calculation.percentage", "framework.pest"]), { steps: [{ capabilityId: "framework.pest", reason: "Wrong purpose" }] }, registry);
  results.push(check("[Purpose] non-locked capability with no matching purpose is rejected", mismatch.steps.length === 0 && mismatch.warnings.some((warning) => warning.code === "PLANNER_PURPOSE_MISMATCH")));

  const duplicate = validateAnalysisPlanCandidate(trend, { steps: [{ capabilityId: "calculation.cagr", reason: "First" }, { capabilityId: "calculation.cagr", reason: "Second" }] }, registry);
  results.push(check("[Duplicate] duplicate capability is merged into one step", duplicate.steps.length === 1 && duplicate.warnings.some((warning) => warning.code === "PLANNER_DUPLICATE_CAPABILITY")));

  const unknownDependency = validateAnalysisPlanCandidate(trend, { steps: [{ capabilityId: "calculation.cagr", reason: "Bad dependency", dependsOn: ["missing"] }] }, registry);
  const selfDependency = validateAnalysisPlanCandidate(trend, { steps: [{ capabilityId: "calculation.cagr", reason: "Self dependency", dependsOn: ["calculation.cagr"] }] }, registry);
  results.push(check("[Dependency2] unknown and self dependencies are rejected", unknownDependency.steps.length === 0 && unknownDependency.warnings.some((warning) => warning.code === "PLANNER_UNKNOWN_DEPENDENCY") && selfDependency.steps.length === 0 && selfDependency.warnings.some((warning) => warning.code === "PLANNER_SELF_DEPENDENCY")));

  const cycle = validateAnalysisPlanCandidate(trend, { steps: [{ id: "a", capabilityId: "calculation.cagr", reason: "A", dependsOn: ["b"] }, { id: "b", capabilityId: "presentation.line", reason: "B", dependsOn: ["a"] }] }, registry);
  results.push(check("[Dependency3] dependency cycles are rejected deterministically", cycle.steps.length === 0 && cycle.warnings.filter((warning) => warning.code === "PLANNER_DEPENDENCY_CYCLE").length === 2));

  const all = input([], registry.list().map((capability) => capability.id));
  const overPlan = validateAnalysisPlanCandidate(all, { steps: registry.list().slice(0, 6).map((capability) => ({ capabilityId: capability.id, reason: "Allowed candidate" })) }, registry);
  results.push(check("[Limit] plan is capped at five steps", overPlan.steps.length === 5 && overPlan.warnings.some((warning) => warning.code === "PLANNER_MAX_STEPS")));

  const blocked = validateAnalysisPlanCandidate(trend, { steps: [{ capabilityId: "calculation.cagr", reason: "Need historical series" }, { capabilityId: "presentation.line", reason: "Need the same historical series" }] }, registry);
  results.push(check("[Missing] repeated missing requirement aggregates with requiring step IDs", blocked.missingRequirements.length === 1 && blocked.missingRequirements[0].kind === "time_series" && blocked.missingRequirements[0].requiredByStepIds.length === 2));

  const longReason = validateAnalysisPlanCandidate(trend, { steps: [{ capabilityId: "calculation.cagr", reason: "x".repeat(301) }] }, registry);
  results.push(check("[Reason] empty/oversized metadata is rejected rather than accepted", longReason.steps.length === 0 && longReason.warnings.some((warning) => warning.code === "PLANNER_REASON_TOO_LONG")));

  return summarize("cortexAnalysisPlannerValidation", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
