import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_FULFILLMENT_CYCLES, MAX_TOTAL_QUERIES, buildBoundedResearchQueries, isResearchFulfillmentEligible, normalizeResearchQuery, resolveResearchFulfillmentBudget, type ResearchGap } from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const base: ResearchGap = { id: "gap", kind: "time_series", targetEntity: "A", metric: "Revenue", period: { granularity: "year" }, requiredCount: 2, currentCount: 1, missingCount: 1, requiredByStepIds: ["step"], requiredByCapabilityIds: ["calculation.cagr"], sourceRequirementIds: ["time-series"], researchable: true, priority: "required", reason: "need point" };

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const capped = resolveResearchFulfillmentBudget({ maxCycles: 99, maxTotalQueries: 99, maxQueriesPerCycle: 99, maxQueriesPerGap: 99, maxGapsPerCycle: 99 });
  results.push(check("[Caps] caller cannot increase absolute cycle or total-query caps", capped.maxCycles === MAX_FULFILLMENT_CYCLES && capped.maxTotalQueries <= MAX_TOTAL_QUERIES && capped.maxQueriesPerCycle <= 6 && capped.maxQueriesPerGap <= 2));
  results.push(check("[Eligibility] only required researchable gaps are eligible", isResearchFulfillmentEligible(base) && !isResearchFulfillmentEligible({ ...base, priority: "supporting" }) && !isResearchFulfillmentEligible({ ...base, researchable: false })));
  results.push(check("[Query] time-series query uses only known semantic fields and never invents a missing year", buildBoundedResearchQueries(base, "Calculate CAGR").join(" ") === "A Revenue year"));
  results.push(check("[Query] ambiguous numeric and entity context remain queryless", buildBoundedResearchQueries({ ...base, kind: "numeric_value", metric: undefined }, "ratio").length === 0 && buildBoundedResearchQueries({ ...base, kind: "entity_context" }, "x").length === 0));
  results.push(check("[Dedup] query normalization is deterministic", normalizeResearchQuery(" A  Revenue  YEAR ") === "a revenue year"));
  const zero = resolveResearchFulfillmentBudget({ maxCycles: -1, maxQueriesPerCycle: Number.NaN, maxTotalQueries: -5 });
  results.push(check("[Budget] invalid values cannot create negative or unbounded work", zero.maxCycles === 0 && zero.maxTotalQueries === 0 && zero.maxQueriesPerCycle === 6));
  results.push(check("[Count] gaps with a zero missing count are not accidentally searched", !isResearchFulfillmentEligible({ ...base, missingCount: 0 })));
  return summarize("cortexResearchFulfillmentBudget", results);
}
const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
