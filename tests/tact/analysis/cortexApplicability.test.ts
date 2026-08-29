import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDefaultAnalysisCapabilityRegistry, mayExecuteCapability, type Dataset } from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const columns: Dataset["columns"] = [
  { id: "entity", label: "Entity", type: "string" }, { id: "period", label: "Period", type: "date" },
  { id: "metric", label: "Metric", type: "string" }, { id: "value", label: "Value", type: "number", unit: "JPY" },
];
function row(id: string, entity: string, period: string, value: number): Dataset["rows"][number] {
  return { id, sourceEvidenceIds: [`ev-${id}`], values: {
    entity: { raw: entity, sourceEvidenceIds: [`ev-${id}`] }, period: { raw: period, sourceEvidenceIds: [`ev-${id}`] },
    metric: { raw: "売上", sourceEvidenceIds: [`ev-${id}`] }, value: { raw: value, normalized: value, sourceEvidenceIds: [`ev-${id}`] },
  } };
}
const timeSeries: Dataset = { id: "times", columns, sourceEvidenceIds: ["ev-22", "ev-23", "ev-24"], rows: [row("22", "A社", "2022", 100), row("23", "A社", "2023", 130), row("24", "A社", "2024", 169)] };
const twoPointSeries: Dataset = { ...timeSeries, id: "two", rows: timeSeries.rows.slice(0, 2) };
const comparison: Dataset = { id: "compare", columns, sourceEvidenceIds: ["ev-a", "ev-b", "ev-c"], rows: [row("a", "A社", "2024", 169), row("b", "B社", "2024", 150), row("c", "C社", "2024", 120)] };
const registry = createDefaultAnalysisCapabilityRegistry();

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const base = { objective: "分析する" };
  const percentageMissing = registry.evaluate("calculation.percentage", base)!;
  const growth = registry.evaluate("calculation.growth-rate", { ...base, datasets: [timeSeries] })!;
  const cagrFew = registry.evaluate("calculation.cagr", { ...base, datasets: [twoPointSeries] })!;
  const cagrMissing = registry.evaluate("calculation.cagr", base)!;
  const ranking = registry.evaluate("calculation.ranking", { ...base, datasets: [comparison] })!;
  const rankingInvalid = registry.evaluate("calculation.ranking", { ...base, datasets: [timeSeries] })!;
  results.push(check("[Calculation1] percentage requires verified numeric values", !percentageMissing.executable && percentageMissing.missingRequirements[0]?.kind === "numeric" && percentageMissing.missingRequirements[0]?.requiredCount === 2));
  results.push(check("[Calculation2] growth and CAGR accept compatible time series", growth.executable && growth.suitability === "high" && cagrFew.executable));
  results.push(check("[Calculation3] time-series and comparison hard requirements are not inferred", !cagrMissing.executable && cagrMissing.missingRequirements[0]?.kind === "time_series" && ranking.executable && !rankingInvalid.executable));

  const table = registry.evaluate("presentation.table", { ...base, datasets: [comparison] })!;
  const bar = registry.evaluate("presentation.bar", { ...base, datasets: [comparison] })!;
  const line = registry.evaluate("presentation.line", { ...base, datasets: [timeSeries] })!;
  const lineTwo = registry.evaluate("presentation.line", { ...base, datasets: [twoPointSeries] })!;
  results.push(check("[Presentation1] table and comparison bar are high suitability", table.executable && table.suitability === "high" && bar.executable && bar.suitability === "high"));
  results.push(check("[Presentation2] line uses the existing time-series recommendation", line.executable && line.suitability === "high" && lineTwo.executable && lineTwo.suitability === "medium"));

  const explicitBar = registry.evaluate("presentation.bar", { ...base, datasets: [timeSeries], explicitRequest: true, explicitCapabilityId: "presentation.bar" })!;
  const explicitCagrMissing = registry.evaluate("calculation.cagr", { ...base, explicitRequest: true, explicitCapabilityId: "calculation.cagr" })!;
  results.push(check("[Override] explicit valid bar remains executable despite medium suitability", explicitBar.explicitRequest && explicitBar.executable && explicitBar.suitability === "medium" && mayExecuteCapability(explicitBar)));
  results.push(check("[Override] explicit request never overrides a missing hard requirement", explicitCagrMissing.explicitRequest && !explicitCagrMissing.executable && !mayExecuteCapability(explicitCagrMissing)));

  const swotPartial = registry.evaluate("framework.swot", { ...base, evidence: [{ id: "one", text: "company strength" }] })!;
  const swotBroader = registry.evaluate("framework.swot", { ...base, targetEntity: "A company", evidence: [{ id: "one", text: "company strength" }, { id: "two", text: "external market regulation" }] })!;
  const threeC = registry.evaluate("framework.3c", { ...base, evidence: [{ id: "c", text: "customer demand" }] })!;
  const pest = registry.evaluate("framework.pest", { ...base, evidence: [{ id: "p", text: "government policy" }] })!;
  const frameworkMissing = registry.evaluate("framework.pest", base)!;
  results.push(check("[Framework1] partial evidence remains executable but low suitability", swotPartial.executable && swotPartial.suitability === "low" && threeC.executable && threeC.suitability === "low"));
  results.push(check("[Framework2] broader explicit coverage raises suitability without making sections mandatory", swotBroader.executable && swotBroader.suitability === "high" && swotBroader.satisfiedRequirements.includes("target-entity") && pest.executable));
  results.push(check("[Framework3] no evidence makes framework fact extraction non-executable", !frameworkMissing.executable && frameworkMissing.missingRequirements[0]?.kind === "evidence"));

  const matrix = registry.evaluateAll({ ...base, datasets: [timeSeries, comparison], evidence: [{ id: "env", text: "市場の規制" }] });
  results.push(check("[Matrix1] all evaluations are returned in deterministic capability order", matrix.length === 10 && matrix.map((item) => item.capabilityId).join(",") === registry.list().map((item) => item.id).join(",")));
  results.push(check("[Matrix2] evaluation is metadata only and returns no Rule execution result", matrix.every((item) => !("output" in item) && !("trace" in item))));
  results.push(check("[Semantics] executable and suitability remain separate dimensions", explicitBar.executable && explicitBar.suitability === "medium" && percentageMissing.valid && !percentageMissing.executable));

  return summarize("cortexApplicability", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
