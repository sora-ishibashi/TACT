import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildAnalysisPlannerInput,
  buildConstrainedAnalysisPlan,
  buildDeterministicPlanCandidate,
  createDefaultAnalysisCapabilityRegistry,
  detectExplicitCapabilityIds,
  type Dataset,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const columns: Dataset["columns"] = [
  { id: "entity", label: "Entity", type: "string" }, { id: "period", label: "Period", type: "date" },
  { id: "metric", label: "Metric", type: "string" }, { id: "value", label: "Value", type: "number", unit: "JPY" },
];
function row(id: string, period: string, value: number): Dataset["rows"][number] {
  return { id, sourceEvidenceIds: [`ev-${id}`], values: {
    entity: { raw: "A", sourceEvidenceIds: [`ev-${id}`] }, period: { raw: period, sourceEvidenceIds: [`ev-${id}`] },
    metric: { raw: "Revenue", sourceEvidenceIds: [`ev-${id}`] }, value: { raw: value, normalized: value, sourceEvidenceIds: [`ev-${id}`] },
  } };
}
const timeSeries: Dataset = { id: "time", columns, sourceEvidenceIds: ["ev-22", "ev-23", "ev-24"], rows: [row("22", "2022", 100), row("23", "2023", 130), row("24", "2024", 169)] };
const onePoint: Dataset = { ...timeSeries, id: "one", rows: [timeSeries.rows[0]] };

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const registry = createDefaultAnalysisCapabilityRegistry();

  results.push(check("[Intent1] explicit detector supports one or more exact capability requests", detectExplicitCapabilityIds("Calculate CAGR and make a line chart").join(",") === "calculation.cagr,presentation.line"));
  results.push(check("[Intent2] explanation query never locks a capability", detectExplicitCapabilityIds("What is CAGR?").length === 0));

  const swotInput = buildAnalysisPlannerInput({ objective: "Perform SWOT analysis", evidence: [{ id: "ev", text: "company strength" }] }, registry);
  const swot = await buildConstrainedAnalysisPlan({ objective: "Perform SWOT analysis", evidence: [{ id: "ev", text: "company strength" }] }, { registry });
  results.push(check("[Explicit1] single explicit Framework becomes a locked zero-LLM plan", swotInput.lockedCapabilityIds.join(",") === "framework.swot" && swot.summary.llmUsed === false && swot.plan?.steps.map((step) => step.capabilityId).join(",") === "framework.swot" && swot.plan.steps[0].status === "ready"));

  const multi = await buildConstrainedAnalysisPlan({ objective: "Calculate CAGR and make a line chart", datasets: [timeSeries] }, { registry });
  results.push(check("[Explicit2] multiple explicit capabilities remain a minimal zero-LLM plan", multi.summary.llmUsed === false && multi.plan?.steps.map((step) => step.capabilityId).join(",") === "calculation.cagr,presentation.line" && multi.plan.executable));

  const blocked = await buildConstrainedAnalysisPlan({ objective: "Calculate CAGR", datasets: [onePoint] }, { registry });
  results.push(check("[HardRequirement] locked explicit CAGR remains blocked when time-series data is insufficient", blocked.plan?.steps[0]?.status === "blocked" && blocked.plan.executable === false && blocked.plan.missingRequirements[0]?.kind === "time_series"));

  const bar = await buildConstrainedAnalysisPlan({ objective: "Make a bar chart", datasets: [timeSeries] }, { registry });
  results.push(check("[Override] explicit valid Bar is retained at medium suitability rather than substituted", bar.plan?.steps[0]?.capabilityId === "presentation.bar" && bar.plan.steps[0].evaluation.suitability === "medium" && bar.plan.steps[0].status === "ready"));

  const explanation = await buildConstrainedAnalysisPlan({ objective: "What is SWOT?" }, { registry });
  results.push(check("[NoPlan] explanation request produces no execution plan and no LLM call", !explanation.plan && explanation.summary.llmUsed === false));

  const simpleInput = buildAnalysisPlannerInput({ objective: "Calculate a percentage", datasets: [timeSeries] }, registry);
  const deterministic = buildDeterministicPlanCandidate(simpleInput);
  results.push(check("[Deterministic] a single compatible purpose can form a local candidate", deterministic?.steps[0]?.capabilityId === "calculation.percentage"));

  const first = await buildConstrainedAnalysisPlan({ objective: "Calculate CAGR", datasets: [timeSeries] }, { registry });
  const second = await buildConstrainedAnalysisPlan({ objective: "Calculate CAGR", datasets: [timeSeries] }, { registry });
  results.push(check("[Identity] plan and step IDs are deterministic rather than random UUIDs", first.plan?.id === second.plan?.id && first.plan?.steps[0]?.id === "step:calculation.cagr"));
  results.push(check("[NoExecution] planner result contains no Rule output, trace, Research, or Artifact mutation", multi.plan?.steps.every((step) => !("output" in step) && !("trace" in step)) === true));

  return summarize("cortexAnalysisPlanner", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
