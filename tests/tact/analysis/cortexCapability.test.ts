import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AnalysisCapabilityRegistry,
  analysisCapabilities,
  createDefaultAnalysisCapabilityRegistry,
  detectAnalysisPurposes,
  type Dataset,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

function point(period: string, value: number, evidenceId: string) {
  return {
    id: `${evidenceId}-row`, sourceEvidenceIds: [evidenceId], values: {
      entity: { raw: "A社", sourceEvidenceIds: [evidenceId] },
      period: { raw: period, sourceEvidenceIds: [evidenceId] },
      metric: { raw: "売上", sourceEvidenceIds: [evidenceId] },
      value: { raw: value, normalized: value, sourceEvidenceIds: [evidenceId] },
    },
  };
}

const columns: Dataset["columns"] = [
  { id: "entity", label: "Entity", type: "string" },
  { id: "period", label: "Period", type: "date" },
  { id: "metric", label: "Metric", type: "string" },
  { id: "value", label: "Value", type: "number", unit: "JPY" },
];

const timeSeries: Dataset = {
  id: "time-series", columns, sourceEvidenceIds: ["ev-2022", "ev-2023", "ev-2024"],
  rows: [point("2022", 100, "ev-2022"), point("2023", 130, "ev-2023"), point("2024", 169, "ev-2024")],
};

const comparison: Dataset = {
  id: "comparison", columns, sourceEvidenceIds: ["ev-a", "ev-b", "ev-c"],
  rows: [
    { ...point("2024", 169, "ev-a"), id: "a", values: { ...point("2024", 169, "ev-a").values, entity: { raw: "A社", sourceEvidenceIds: ["ev-a"] } } },
    { ...point("2024", 150, "ev-b"), id: "b", values: { ...point("2024", 150, "ev-b").values, entity: { raw: "B社", sourceEvidenceIds: ["ev-b"] } } },
    { ...point("2024", 120, "ev-c"), id: "c", values: { ...point("2024", 120, "ev-c").values, entity: { raw: "C社", sourceEvidenceIds: ["ev-c"] } } },
  ],
};

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const registry = createDefaultAnalysisCapabilityRegistry();
  const listed = registry.list();

  results.push(check("[Registry1] all ten capabilities are registered exactly once", listed.length === 10 && new Set(listed.map((capability) => capability.id)).size === 10));
  results.push(check("[Registry2] ordering is deterministic by kind then id", listed.map((capability) => capability.id).join(",") === "calculation.cagr,calculation.growth-rate,calculation.percentage,calculation.ranking,presentation.bar,presentation.line,presentation.table,framework.3c,framework.pest,framework.swot"));
  results.push(check("[Registry3] get and purpose lookup expose descriptive metadata", registry.get("calculation.cagr")?.rule.id === "calculation.cagr" && registry.get("calculation.cagr")?.rule.version === "1" && registry.findByPurpose("trend").map((capability) => capability.id).join(",") === "calculation.cagr,calculation.growth-rate,presentation.line"));
  results.push(check("[Registry4] unknown capability is not implicitly resolved", registry.get("framework.unknown") === undefined && registry.evaluate("framework.unknown", { objective: "分析" }) === undefined));

  const local = new AnalysisCapabilityRegistry();
  local.register(analysisCapabilities[0]);
  let duplicateRejected = false;
  try { local.register(analysisCapabilities[0]); } catch { duplicateRejected = true; }
  results.push(check("[Registry5] duplicate registration is rejected", duplicateRejected));

  const percentage = registry.evaluate("calculation.percentage", { objective: "calculate percentage", datasets: [timeSeries] });
  const cagr = registry.evaluate("calculation.cagr", { objective: "calculate CAGR", datasets: [timeSeries] });
  const ranking = registry.evaluate("calculation.ranking", { objective: "rank revenue", datasets: [comparison] });
  results.push(check("[Calculation1] percentage, CAGR, and ranking remain mapped to their existing Rules", registry.get("calculation.percentage")?.rule.id === "calculation.percentage" && percentage?.executable === true && cagr?.executable === true && ranking?.executable === true));
  results.push(check("[Calculation2] capability descriptions retain typed requirement contracts", listed.filter((capability) => capability.kind === "calculation").every((capability) => capability.requirements.every((requirement) => Boolean(requirement.id && requirement.kind)))));

  const purposes = detectAnalysisPurposes("市場の成長推移を比較してグラフにして");
  results.push(check("[Purpose1] deterministic purpose matcher recognizes objective metadata", purposes.includes("market") && purposes.includes("trend") && purposes.includes("compare") && purposes.includes("visualize")));
  results.push(check("[Purpose2] explanatory queries do not become execution intent", detectAnalysisPurposes("CAGRとは？")?.length === 0 && detectAnalysisPurposes("SWOTの使い方を教えて")?.length === 0));

  const invalid = registry.evaluate("presentation.table", { objective: "", datasets: [timeSeries] });
  results.push(check("[Semantics] valid is distinct from otherwise available Dataset data", invalid?.valid === false && invalid.executable === false && invalid.issues.some((issue) => issue.code === "CAPABILITY_INPUT_INVALID")));

  return summarize("cortexCapability", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
