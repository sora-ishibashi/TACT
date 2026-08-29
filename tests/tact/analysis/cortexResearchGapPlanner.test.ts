import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildConstrainedAnalysisPlan,
  buildResearchGapPlan,
  createDefaultAnalysisCapabilityRegistry,
  type Dataset,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const registry = createDefaultAnalysisCapabilityRegistry();
const columns: Dataset["columns"] = [
  { id: "entity", label: "Entity", type: "string" }, { id: "period", label: "Period", type: "date" },
  { id: "metric", label: "Metric", type: "string" }, { id: "value", label: "Value", type: "number", unit: "JPY" },
];
function row(id: string, entity: string, period: string, metric: string, value: number): Dataset["rows"][number] {
  return { id, sourceEvidenceIds: [`ev-${id}`], values: {
    entity: { raw: entity, sourceEvidenceIds: [`ev-${id}`] }, period: { raw: period, sourceEvidenceIds: [`ev-${id}`] },
    metric: { raw: metric, sourceEvidenceIds: [`ev-${id}`] }, value: { raw: value, normalized: value, sourceEvidenceIds: [`ev-${id}`] },
  } };
}
const oneRevenue: Dataset = { id: "one-revenue", columns, sourceEvidenceIds: ["ev-24"], rows: [row("24", "A", "2024", "Revenue", 100)] };
const timeSeries: Dataset = { id: "revenue-series", columns, sourceEvidenceIds: ["ev-22", "ev-23"], rows: [row("22", "A", "2022", "Revenue", 100), row("23", "A", "2023", "Revenue", 130)] };

async function plan(objective: string, datasets?: Dataset[], targetEntity?: string) {
  const result = await buildConstrainedAnalysisPlan({ objective, datasets, targetEntity }, { registry });
  if (!result.plan) throw new Error("Expected a validated plan fixture");
  return result.plan;
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  const cagrLinePlan = await plan("Calculate CAGR and make a line chart", [oneRevenue]);
  const cagrLine = buildResearchGapPlan({ plan: cagrLinePlan, datasets: [oneRevenue] });
  const timeGap = cagrLine.gaps[0];
  results.push(check("[TimeSeries] blocked CAGR plus Line creates one minimal merged temporal gap", cagrLine.gaps.length === 1 && timeGap.kind === "time_series" && timeGap.targetEntity === "A" && timeGap.metric === "Revenue" && timeGap.requiredCount === 2 && timeGap.currentCount === 1 && timeGap.missingCount === 1));
  results.push(check("[Trace] merged gap preserves both step, capability, and requirement sources", timeGap.requiredByStepIds.length === 2 && timeGap.requiredByCapabilityIds.join(",") === "calculation.cagr,presentation.line" && timeGap.sourceRequirementIds.join(",") === "time-series"));
  results.push(check("[Period] temporal gap preserves only known granularity and never invents a missing year", timeGap.period?.granularity === "year" && timeGap.period?.start === undefined));

  const growth = buildResearchGapPlan({ plan: await plan("Calculate growth rate", [oneRevenue]), datasets: [oneRevenue] });
  results.push(check("[Growth] a uniquely identified entity/metric produces one additional-period gap", growth.gaps[0]?.kind === "time_series" && growth.gaps[0]?.missingCount === 1 && growth.gaps[0]?.researchable));

  const percentage = buildResearchGapPlan({ plan: await plan("Calculate percentage", [oneRevenue]), datasets: [oneRevenue] });
  results.push(check("[Numeric] numeric requirement maps to a specified numeric-value gap", percentage.gaps[0]?.kind === "numeric_value" && percentage.gaps[0]?.targetEntity === "A" && percentage.gaps[0]?.metric === "Revenue" && percentage.gaps[0]?.period?.start === "2024-01-01"));

  const ranking = buildResearchGapPlan({ plan: await plan("Rank revenue", [oneRevenue]), datasets: [oneRevenue], targetEntity: "A" });
  results.push(check("[Comparison] missing comparison entity is unresolved rather than inventing a competitor", ranking.gaps.length === 0 && ranking.unresolvedRequirements[0]?.reason === "ambiguous_target" && ranking.researchRequired === false));

  const frameworkPartial = buildResearchGapPlan({ plan: await plan("Perform SWOT analysis", undefined, "A"), targetEntity: "A" });
  const frameworkEvidence = buildResearchGapPlan({ plan: await plan("Perform SWOT analysis", undefined, "A"), targetEntity: "A" });
  results.push(check("[Framework1] no-evidence SWOT makes one minimal evidence gap rather than four sections", frameworkEvidence.gaps.length === 1 && frameworkEvidence.gaps[0]?.kind === "evidence" && frameworkEvidence.gaps[0]?.researchable));
  const frameworkReady = await buildConstrainedAnalysisPlan({ objective: "Perform SWOT analysis", targetEntity: "A", evidence: [{ id: "ev", text: "company strength" }] }, { registry });
  const readyGap = frameworkReady.plan ? buildResearchGapPlan({ plan: frameworkReady.plan, targetEntity: "A" }) : undefined;
  results.push(check("[Framework2] partial but executable SWOT makes no suitability-only gap", readyGap?.gaps.length === 0 && readyGap.summary.blockedSteps === 0 && frameworkPartial.summary.blockedSteps === 1));

  const ambiguousMetric = buildResearchGapPlan({ plan: await plan("Calculate CAGR", undefined, "A"), targetEntity: "A" });
  results.push(check("[Ambiguity] missing metric remains unresolved and is not guessed", ambiguousMetric.gaps.length === 0 && ambiguousMetric.unresolvedRequirements[0]?.reason === "ambiguous_metric"));

  const ready = buildResearchGapPlan({ plan: await plan("Calculate CAGR", [timeSeries]), datasets: [timeSeries] });
  results.push(check("[Ready] ready step creates no required research gap", ready.gaps.length === 0 && ready.researchRequired === false && ready.summary.blockedSteps === 0));

  const repeated = buildResearchGapPlan({ plan: cagrLinePlan, datasets: [oneRevenue] });
  results.push(check("[Identity] same plan and context produce stable gap-plan and gap IDs", repeated.id === cagrLine.id && repeated.gaps[0]?.id === timeGap.id));
  results.push(check("[Safety] result is semantic planning only: no query, search result, Rule output, or execution trace", cagrLine.gaps.every((gap) => !("query" in gap) && !("output" in gap) && !("trace" in gap))));

  return summarize("cortexResearchGapPlanner", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
