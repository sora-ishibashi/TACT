import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CortexRegistry, createDefaultAnalysisCapabilityRegistry, createDefaultCortexRegistry, executeAnalysisPlan, type CortexRule, type Dataset, type ValidatedAnalysisPlan } from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const dataset: Dataset = { id: "d", columns: [{ id: "entity", label: "Entity", type: "string" }, { id: "period", label: "Period", type: "date" }, { id: "metric", label: "Metric", type: "string" }, { id: "value", label: "Value", type: "number" }], sourceEvidenceIds: ["ev1", "ev2"], rows: ["2022", "2024"].map((period, index) => ({ id: period, sourceEvidenceIds: [`ev${index + 1}`], values: { entity: { raw: "A", sourceEvidenceIds: [`ev${index + 1}`] }, period: { raw: period, sourceEvidenceIds: [`ev${index + 1}`] }, metric: { raw: "Revenue", sourceEvidenceIds: [`ev${index + 1}`] }, value: { raw: index ? 169 : 100, normalized: index ? 169 : 100, sourceEvidenceIds: [`ev${index + 1}`] } } })) };
function manual(overrides: Partial<ValidatedAnalysisPlan["steps"][number]> = {}): ValidatedAnalysisPlan { const step = { id: "step:calculation.cagr", capabilityId: "calculation.cagr", ruleId: "calculation.cagr", ruleVersion: "1", purposes: ["trend"] as const, evaluation: { capabilityId: "calculation.cagr", valid: true, executable: true, suitability: "high" as const, explicitRequest: true, satisfiedRequirements: [], missingRequirements: [], reasons: [], issues: [] }, dependsOn: [], status: "ready" as const, reason: "CAGR", ...overrides }; return { id: "plan", objective: "Calculate CAGR", purposes: ["trend"], steps: [step], missingRequirements: [], warnings: [], executable: true }; }
const input = (plan: ValidatedAnalysisPlan) => ({ plan, datasets: [dataset], evidence: [], registry: createDefaultCortexRegistry(), capabilityRegistry: createDefaultAnalysisCapabilityRegistry() });

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const unknown = await executeAnalysisPlan(input(manual({ capabilityId: "analysis.magic", ruleId: "analysis.magic" })));
  results.push(check("[Capability] unknown planned capability fails validation without substitution", unknown.steps[0]?.status === "failed_validation" && unknown.steps[0]?.warnings[0]?.code === "UNKNOWN_CAPABILITY"));
  const rule = await executeAnalysisPlan(input(manual({ ruleId: "calculation.unknown" })));
  results.push(check("[Mapping] mismatched capability Rule mapping fails before Rule lookup", rule.steps[0]?.status === "failed_validation" && rule.steps[0]?.warnings[0]?.code === "RULE_VERSION_MISMATCH"));
  const version = await executeAnalysisPlan(input(manual({ ruleVersion: "2" })));
  results.push(check("[Version] version mismatch is never silently upgraded", version.steps[0]?.status === "failed_validation" && version.steps[0]?.warnings[0]?.code === "RULE_VERSION_MISMATCH"));
  const blocked = await executeAnalysisPlan(input(manual({ status: "blocked" })));
  results.push(check("[ReadyOnly] manually blocked step is skipped even when typed data is present", blocked.steps[0]?.status === "skipped_blocked"));
  const controller = new AbortController(); controller.abort(); const cancelled = await executeAnalysisPlan({ ...input(manual()), signal: controller.signal });
  results.push(check("[Cancellation] cancellation stops future execution without retry", cancelled.status === "cancelled" && cancelled.steps[0]?.status === "cancelled"));
  const cyclicPlan = { ...manual(), steps: [{ ...manual().steps[0], id: "a", dependsOn: ["b"] }, { ...manual().steps[0], id: "b", dependsOn: ["a"] }] };
  const cyclic = await executeAnalysisPlan(input(cyclicPlan));
  results.push(check("[Cycle] defensive dependency cycle detection prevents all Rule calls", cyclic.steps.every((step) => step.status === "failed_validation") && cyclic.outputs.length === 0));
  const throwing = new CortexRegistry();
  const throwRule: CortexRule = { id: "calculation.cagr", version: "1", category: "calculation", purpose: "test", execution: { deterministic: true, llmMode: "never" }, requirements: [], preconditions: () => [], execute: () => { throw new Error("expected"); }, validate: () => [] };
  throwing.register(throwRule);
  const thrown = await executeAnalysisPlan({ ...input(manual()), registry: throwing });
  results.push(check("[Isolation] Rule throw becomes failed_execution rather than escaping the execution result", thrown.steps[0]?.status === "failed_execution" && thrown.status === "failed"));
  const dependentPlan = { ...manual(), steps: [{ ...manual().steps[0], id: "first" }, { ...manual().steps[0], id: "second", dependsOn: ["first"] }] };
  const dependent = await executeAnalysisPlan({ ...input(dependentPlan), registry: throwing });
  results.push(check("[Dependency] a failed dependency skips only its dependent step", dependent.steps.map((step) => step.status).join(",") === "failed_execution,skipped_dependency"));
  const tooMany = { ...manual(), steps: Array.from({ length: 6 }, (_, index) => ({ ...manual().steps[0], id: `step-${index}` })) };
  const limited = await executeAnalysisPlan(input(tooMany));
  results.push(check("[Limit] execution has an absolute five-step cap and exposes overflow", limited.summary.plannedSteps === 6 && limited.steps.filter((step) => step.status === "failed_validation").length === 1));
  const unknownRulePlan = { ...manual({ capabilityId: "framework.swot", ruleId: "framework.swot" }), objective: "Perform SWOT analysis", purposes: ["structure"] as const, steps: [{ ...manual({ capabilityId: "framework.swot", ruleId: "framework.swot" }).steps[0], purposes: ["structure"] as const }] };
  const unknownRule = await executeAnalysisPlan({ plan: unknownRulePlan, datasets: [], evidence: [{ id: "ev", text: "Company strength" }], registry: createDefaultCortexRegistry(), capabilityRegistry: createDefaultAnalysisCapabilityRegistry() });
  results.push(check("[Rule] registered Capability with absent Rule Registry entry fails validation before Framework execution", unknownRule.steps[0]?.status === "failed_validation" && unknownRule.steps[0]?.warnings[0]?.code === "UNKNOWN_RULE"));
  const noDependents = await executeAnalysisPlan(input({ ...manual(), steps: [{ ...manual().steps[0], id: "first" }, { ...manual().steps[0], id: "independent" }] }));
  results.push(check("[Isolation] independent ready steps continue after no unrelated failure", noDependents.steps.every((step) => step.status === "completed")));
  return summarize("cortexAnalysisExecutionValidation", results);
}
const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
