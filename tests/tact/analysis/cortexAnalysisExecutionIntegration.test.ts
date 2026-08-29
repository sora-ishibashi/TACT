import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildConstrainedAnalysisPlan, createDefaultAnalysisCapabilityRegistry, createDefaultCortexRegistry, executeAnalysisPlan, type Dataset } from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const d: Dataset = { id: "d", columns: [{ id: "entity", label: "Entity", type: "string" }, { id: "period", label: "Period", type: "date" }, { id: "metric", label: "Metric", type: "string" }, { id: "value", label: "Value", type: "number" }], sourceEvidenceIds: ["e1", "e2", "e3"], rows: [["2022", 100], ["2023", 130], ["2024", 169]].map(([period, value]) => ({ id: String(period), sourceEvidenceIds: [`e${period}`], values: { entity: { raw: "A", sourceEvidenceIds: [`e${period}`] }, period: { raw: String(period), sourceEvidenceIds: [`e${period}`] }, metric: { raw: "Revenue", sourceEvidenceIds: [`e${period}`] }, value: { raw: value as number, normalized: value as number, sourceEvidenceIds: [`e${period}`] } } })) };

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = []; const capabilityRegistry = createDefaultAnalysisCapabilityRegistry();
  const planned = await buildConstrainedAnalysisPlan({ objective: "Calculate CAGR and make a line chart", datasets: [d] }, { registry: capabilityRegistry }); if (!planned.plan) throw new Error("expected plan");
  const result = await executeAnalysisPlan({ plan: planned.plan, datasets: [d], evidence: [], registry: createDefaultCortexRegistry(), capabilityRegistry });
  results.push(check("[Plan] only the two explicit planned capabilities execute in deterministic plan order", result.steps.map((step) => step.capabilityId).join(",") === "calculation.cagr,presentation.line" && result.steps.every((step) => step.status === "completed")));
  results.push(check("[Result] outputs contain validated completed results only and no Search/Planner/Artifact state", result.outputs.length === 2 && !("search" in result) && !("artifacts" in result)));
  results.push(check("[Trace] every attempted plan step has a deterministic dependency trace", result.trace.length === 2 && result.trace[0]?.stepId === "step:calculation.cagr"));
  results.push(check("[Summary] completed execution counts only planned ready steps and terminates finitely", result.summary.plannedSteps === 2 && result.summary.completed === 2 && result.summary.failedExecution === 0));
  return summarize("cortexAnalysisExecutionIntegration", results);
}
const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
