import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildConstrainedAnalysisPlan, createDefaultAnalysisCapabilityRegistry, createDefaultCortexRegistry, executeAnalysisPlan, type Dataset } from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const columns: Dataset["columns"] = [{ id: "entity", label: "Entity", type: "string" }, { id: "period", label: "Period", type: "date" }, { id: "metric", label: "Metric", type: "string" }, { id: "value", label: "Value", type: "number", unit: "JPY" }];
function data(points: readonly [string, number][]): Dataset { return { id: "revenue", columns, sourceEvidenceIds: points.map(([p]) => `ev-${p}`), rows: points.map(([period, value]) => ({ id: period, sourceEvidenceIds: [`ev-${period}`], values: { entity: { raw: "A", sourceEvidenceIds: [`ev-${period}`] }, period: { raw: period, sourceEvidenceIds: [`ev-${period}`] }, metric: { raw: "Revenue", sourceEvidenceIds: [`ev-${period}`] }, value: { raw: value, normalized: value, sourceEvidenceIds: [`ev-${period}`] } } })) }; }
async function plan(objective: string, datasets: Dataset[]) { const result = await buildConstrainedAnalysisPlan({ objective, datasets }, { registry: createDefaultAnalysisCapabilityRegistry() }); if (!result.plan) throw new Error("expected plan"); return result.plan; }

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const capabilityRegistry = createDefaultAnalysisCapabilityRegistry(); const registry = createDefaultCortexRegistry(); const series = data([["2022", 100], ["2024", 169]]);
  const cagr = await plan("Calculate CAGR", [series]);
  const executed = await executeAnalysisPlan({ plan: cagr, datasets: [series], evidence: [], registry, capabilityRegistry });
  results.push(check("[CAGR] ready calculated step uses existing Registry Rule with source provenance", executed.status === "completed" && executed.steps[0]?.status === "completed" && executed.outputs[0]?.rule.id === "calculation.cagr" && executed.outputs[0]?.sourceEvidenceIds.join(",") === "ev-2022,ev-2024"));

  const blocked = await plan("Calculate CAGR", [data([["2024", 100]])]);
  const blockedResult = await executeAnalysisPlan({ plan: blocked, datasets: [data([["2024", 100]])], evidence: [], registry, capabilityRegistry });
  results.push(check("[Blocked] blocked plan step calls no Rule and is traceable as skipped_blocked", blockedResult.status === "blocked" && blockedResult.steps[0]?.status === "skipped_blocked" && blockedResult.outputs.length === 0));

  const table = await plan("Make a table", [series]);
  const tableResult = await executeAnalysisPlan({ plan: table, datasets: [series], evidence: [], registry, capabilityRegistry });
  results.push(check("[Table] presentation produces a pure provenance-preserving Table output without artifact mutation", tableResult.status === "completed" && (tableResult.outputs[0]?.output as { block?: { type?: string } })?.block?.type === "table" && tableResult.outputs[0]?.sourceEvidenceIds.length === 2));

  const line = await plan("Make a line chart", [series]);
  const lineResult = await executeAnalysisPlan({ plan: line, datasets: [series], evidence: [], registry, capabilityRegistry });
  results.push(check("[Line] presentation line reuses existing Dataset adapter as a pure result", lineResult.steps[0]?.status === "completed" && (lineResult.outputs[0]?.output as { block?: { chartType?: string } })?.block?.chartType === "line"));

  const stale = await executeAnalysisPlan({ plan: line, datasets: [data([["2024", 100]])], evidence: [], registry, capabilityRegistry });
  results.push(check("[Stale] stale ready plan is re-evaluated and never calls an invalid adapter", stale.steps[0]?.status === "failed_validation" && stale.steps[0]?.warnings.some((warning) => warning.code === "STALE_PLAN") === true));

  const percentage = await plan("Calculate percentage", [series]);
  const percentageResult = await executeAnalysisPlan({ plan: percentage, datasets: [series], evidence: [], registry, capabilityRegistry, explicitInputs: { "step:calculation.percentage": { part: { raw: "25", value: 25, sourceEvidenceIds: ["part"] }, whole: { raw: "100", value: 100, sourceEvidenceIds: ["whole"] } } } });
  results.push(check("[Percentage] explicit typed part/whole input executes the existing Rule without inferring their relation from Dataset rows", percentageResult.steps[0]?.status === "completed" && (percentageResult.outputs[0]?.output as { value?: number })?.value === 0.25));

  const growth = await plan("Calculate growth rate", [series]);
  const growthResult = await executeAnalysisPlan({ plan: growth, datasets: [series], evidence: [], registry, capabilityRegistry });
  results.push(check("[Growth] existing growth-rate Rule executes from the typed Dataset adapter", growthResult.steps[0]?.status === "completed" && (growthResult.outputs[0]?.output as { value?: number })?.value === 0.69));

  const comparison: Dataset = { ...series, id: "comparison", rows: [["A", 169], ["B", 150], ["C", 120]].map(([entity, value]) => ({ id: String(entity), sourceEvidenceIds: [`ev-${entity}`], values: { entity: { raw: String(entity), sourceEvidenceIds: [`ev-${entity}`] }, period: { raw: "2024", sourceEvidenceIds: [`ev-${entity}`] }, metric: { raw: "Revenue", sourceEvidenceIds: [`ev-${entity}`] }, value: { raw: value as number, normalized: value as number, sourceEvidenceIds: [`ev-${entity}`] } } })) };
  const ranking = await plan("Rank revenue", [comparison]);
  const rankingResult = await executeAnalysisPlan({ plan: ranking, datasets: [comparison], evidence: [], registry, capabilityRegistry });
  results.push(check("[Ranking] existing dense-ranking Rule executes only from one comparable Dataset", rankingResult.steps[0]?.status === "completed" && (rankingResult.outputs[0]?.output as { rankings?: unknown[] })?.rankings?.length === 3));
  const bar = await plan("Make a bar chart", [comparison]);
  const barResult = await executeAnalysisPlan({ plan: bar, datasets: [comparison], evidence: [], registry, capabilityRegistry });
  results.push(check("[Bar] existing Bar adapter is reused as a pure structured output", barResult.steps[0]?.status === "completed" && (barResult.outputs[0]?.output as { block?: { chartType?: string } })?.block?.chartType === "bar"));
  const ratioWithoutInput = await executeAnalysisPlan({ plan: percentage, datasets: [series], evidence: [], registry, capabilityRegistry });
  results.push(check("[NoGuess] percentage without explicit part/whole remains failed_validation instead of choosing Dataset rows", ratioWithoutInput.steps[0]?.status === "failed_validation" && ratioWithoutInput.outputs.length === 0));

  return summarize("cortexAnalysisExecution", results);
}
const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
