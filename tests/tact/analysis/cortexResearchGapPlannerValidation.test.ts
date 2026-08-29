import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_RESEARCH_GAPS,
  evaluateResearchability,
  finiteCount,
  limitResearchGaps,
  mergeResearchGaps,
  requirementToGapKind,
  type ResearchGap,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

function gap(id: string, overrides: Partial<ResearchGap> = {}): ResearchGap {
  return {
    id, kind: "time_series", targetEntity: "A", metric: "Revenue", period: { granularity: "year" }, unit: "JPY",
    requiredCount: 2, currentCount: 1, missingCount: 1, requiredByStepIds: [id], requiredByCapabilityIds: [id], sourceRequirementIds: ["time-series"],
    researchable: true, priority: "required", reason: "Need one more point", ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  results.push(check("[Mapping] Requirement kinds use a finite deterministic mapping", requirementToGapKind("numeric") === "numeric_value" && requirementToGapKind("time_series") === "time_series" && requirementToGapKind("comparison") === "comparison" && requirementToGapKind("evidence") === "evidence" && requirementToGapKind("dataset") === undefined));
  results.push(check("[Count] missing count is finite, non-negative, and never invented when unknown", finiteCount(2, 1).missingCount === 1 && finiteCount(2, 3).missingCount === 0 && finiteCount(undefined, 1).missingCount === undefined));

  const merged = mergeResearchGaps([gap("one"), gap("two", { requiredByCapabilityIds: ["presentation.line"], sourceRequirementIds: ["time-series-line"] })]);
  results.push(check("[Merge1] identical safe keys merge provenance and retain maximal count semantics", merged.length === 1 && merged[0].requiredByStepIds.join(",") === "one,two" && merged[0].requiredByCapabilityIds.join(",") === "one,presentation.line" && merged[0].missingCount === 1));
  results.push(check("[Merge2] different metric/entity/unit/currency never merge", mergeResearchGaps([gap("metric"), gap("profit", { metric: "Operating income" })]).length === 2 && mergeResearchGaps([gap("entity"), gap("other", { targetEntity: "B" })]).length === 2 && mergeResearchGaps([gap("jpy"), gap("usd", { currency: "USD" })]).length === 2 && mergeResearchGaps([gap("unit"), gap("count", { unit: "count" })]).length === 2));

  const overflowInput = Array.from({ length: MAX_RESEARCH_GAPS + 3 }, (_, index) => gap(`step-${index}`, { metric: `Metric-${index}` }));
  const limited = limitResearchGaps(overflowInput);
  results.push(check("[Limit] hard cap retains deterministic required gaps and exposes overflow", limited.retained.length === MAX_RESEARCH_GAPS && limited.overflow.length === 3 && limited.retained.map((item) => item.id).join(",") === "step-0,step-1,step-2,step-3,step-4"));
  const supportingFirst = limitResearchGaps([gap("support", { priority: "supporting" }), ...overflowInput]);
  results.push(check("[Priority] required gaps sort before supporting gaps", supportingFirst.retained.every((item) => item.priority === "required")));

  results.push(check("[Researchability1] time series and numeric require identity, metric, and numeric period context", evaluateResearchability("time_series", { targetEntity: "A", metric: "Revenue", numericCount: 1, temporalPointCount: 1, entityCount: 1, metricCount: 1 }, 1).researchable && !evaluateResearchability("numeric_value", { targetEntity: "A", metric: "Revenue", numericCount: 1, temporalPointCount: 1, entityCount: 1, metricCount: 1 }, 1).researchable));
  results.push(check("[Researchability2] comparison and ambiguous contexts remain non-researchable", evaluateResearchability("comparison", { targetEntity: "A", metric: "Revenue", numericCount: 1, temporalPointCount: 1, entityCount: 1, metricCount: 1 }, 1).reason === "ambiguous_target" && evaluateResearchability("time_series", { metric: "Revenue", numericCount: 0, temporalPointCount: 0, entityCount: 0, metricCount: 1 }, 1).reason === "ambiguous_target"));
  results.push(check("[Researchability3] evidence needs target context but has no per-section expansion", evaluateResearchability("evidence", { targetEntity: "A", numericCount: 0, temporalPointCount: 0, entityCount: 0, metricCount: 0 }, 1).researchable && evaluateResearchability("evidence", { numericCount: 0, temporalPointCount: 0, entityCount: 0, metricCount: 0 }, 1).reason === "insufficient_context"));

  return summarize("cortexResearchGapPlannerValidation", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
