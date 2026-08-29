import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCortexFulfillmentSearchAdapter } from "../../../core/tact-research/cortexFulfillmentAdapter";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  let received: { queries: string[]; objective: string; max: number } | undefined;
  const adapter = createCortexFulfillmentSearchAdapter(async (queries, objective, max) => {
    received = { queries, objective, max: max ?? -1 };
    return {
      evidence: [{ id: "existing-ev", claim: "A revenue", source: "https://example.invalid/a", confidence: "high", evidence: "A 2023 Revenue: 130", score: 1, createdBy: "test", createdAt: 0, tags: [] }],
      searchProvider: "mock", queriesUsed: queries, searchQueryCount: queries.length, searchRequestCount: 1, searchAttempts: [],
    };
  });
  const result = await adapter.search({ cycle: 1, objective: "Calculate CAGR", queries: ["A Revenue"], gap: { id: "gap", kind: "time_series", requiredByStepIds: [], requiredByCapabilityIds: [], sourceRequirementIds: [], researchable: true, priority: "required", reason: "need one point" } });
  results.push(check("[Adapter] forwards only the bounded request query/objective to existing web research with max three Evidence", received?.queries.join(",") === "A Revenue" && received.objective === "Calculate CAGR" && received.max === 3));
  results.push(check("[Adapter] maps existing selected Evidence into provider-independent fulfillment evidence without inventing IDs", result.evidence[0]?.id === "existing-ev" && result.evidence[0]?.text === "A 2023 Revenue: 130" && result.evidence[0]?.url === "https://example.invalid/a"));
  return summarize("cortexResearchFulfillmentAdapter", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
