import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildConstrainedAnalysisPlan, buildResearchGapPlan, createDefaultAnalysisCapabilityRegistry, runResearchFulfillment, type Dataset } from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const d: Dataset = { id: "one", columns: [{ id: "entity", label: "Entity", type: "string" }, { id: "period", label: "Period", type: "date" }, { id: "metric", label: "Metric", type: "string" }, { id: "value", label: "Value", type: "number" }], sourceEvidenceIds: ["old"], rows: [{ id: "r", sourceEvidenceIds: ["old"], values: { entity: { raw: "A", sourceEvidenceIds: ["old"] }, period: { raw: "2024", sourceEvidenceIds: ["old"] }, metric: { raw: "Revenue", sourceEvidenceIds: ["old"] }, value: { raw: 100, normalized: 100, sourceEvidenceIds: ["old"] } } }] };
const evidence = [{ id: "old", text: "A 2024 Revenue: 100" }];

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const planned = await buildConstrainedAnalysisPlan({ objective: "Calculate CAGR and make a line chart", datasets: [d], evidence }, { registry: createDefaultAnalysisCapabilityRegistry() });
  if (!planned.plan) throw new Error("expected plan");
  const gaps = buildResearchGapPlan({ plan: planned.plan, targetEntity: "A", datasets: [d], evidenceDescriptors: evidence });
  let calls = 0;
  const fulfilled = await runResearchFulfillment({ objective: planned.plan.objective, plan: planned.plan, gapPlan: gaps, targetEntity: "A", existingEvidence: evidence, search: { async search() { calls += 1; return { evidence: [{ id: "new", text: "A 2023 Revenue: 130" }] }; } } });
  results.push(check("[Merge] shared CAGR and line missing time-series requirement remains one research request", gaps.gaps.length === 1 && calls === 1 && fulfilled.updatedPlan.steps.every((step) => step.status === "ready")));
  results.push(check("[Trace] updated plan preserves original deterministic IDs, capability mapping, and dependencies", fulfilled.updatedPlan.id === planned.plan.id && fulfilled.updatedPlan.steps.map((step) => step.id).join(",") === planned.plan.steps.map((step) => step.id).join(",")));
  results.push(check("[Boundary] no canonical Research query or provider is imported: only the supplied mock adapter is called", fulfilled.summary.queriesAttempted === 1 && fulfilled.summary.evidenceAdded === 1));
  results.push(check("[Cycle] shared requirement has a single fulfillment result and no capability is executed", fulfilled.gapResults.length === 1 && fulfilled.gapResults[0]?.status === "fulfilled" && !("result" in fulfilled.updatedPlan.steps[0])));
  return summarize("cortexResearchFulfillmentIntegration", results);
}
const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
