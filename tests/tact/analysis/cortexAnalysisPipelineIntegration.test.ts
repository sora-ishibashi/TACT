import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDefaultAnalysisCapabilityRegistry,
  createFrameworkCortexRegistry,
  runCortexAnalysisPipeline,
  type ResearchFulfillmentSearchAdapter,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const series = [{ id: "attachment-2022", text: "A 2022 Revenue: 100", claim: "A 2022 Revenue: 100" }, { id: "attachment-2024", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" }];
function input(objective: string, overrides: Partial<Parameters<typeof runCortexAnalysisPipeline>[0]> = {}) {
  return { objective, evidence: series, cortexRegistry: createFrameworkCortexRegistry(), capabilityRegistry: createDefaultAnalysisCapabilityRegistry(), ...overrides };
}
function search(calls: string[]): ResearchFulfillmentSearchAdapter { return { async search(request) { calls.push(request.queries[0]); return { evidence: [] }; } }; }

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const attachmentSatisfied = await runCortexAnalysisPipeline(input("Calculate CAGR"));
  results.push(check("[Attachment-equivalent Evidence] supplied per-turn evidence can satisfy a time-series without a fulfillment search", attachmentSatisfied.execution?.status === "completed" && !attachmentSatisfied.fulfillment));

  let plannerCalls = 0;
  const generic = await runCortexAnalysisPipeline(input("Compare and visualize performance", {
    planner: { runLLMImpl: async () => { plannerCalls += 1; return { content: JSON.stringify({ steps: [{ capabilityId: "presentation.table", reason: "verified comparison" }] }) }; } },
  }));
  results.push(check("[Generic] an eligible ambiguous goal has at most one planner proposal call", plannerCalls === 1 && generic.planner?.summary.llmUsed === true));
  results.push(check("[Generic] untrusted planner output remains validated and executes only its allowed capability", generic.execution?.steps.length === 1 && generic.execution.steps[0]?.capabilityId === "presentation.table"));

  const plannerFailure = await runCortexAnalysisPipeline(input("Compare and visualize performance", {
    planner: { runLLMImpl: async () => { throw new Error("mock planner outage"); } },
  }));
  results.push(check("[Planner failure isolation] an optional generic planner outage is contained as Pipeline state instead of throwing", plannerFailure.status === "failed" && plannerFailure.planner?.summary.llmUsed === true && plannerFailure.warnings.some((warning) => warning.code === "PLANNER_CANDIDATE_FAILED")));

  const noPlan = await runCortexAnalysisPipeline(input("Market overview"));
  results.push(check("[Normal Research] passive overview text is not a generic Analysis action and leaves Cortex not_applicable", noPlan.status === "not_applicable" && !noPlan.execution));

  const calls: string[] = [];
  const blocked = await runCortexAnalysisPipeline(input("Calculate CAGR", { evidence: [{ id: "ev-2024", text: "A 2024 Revenue: 100", claim: "A 2024 Revenue: 100" }], targetEntity: "A", searchAdapter: search(calls) }));
  results.push(check("[Failure isolation] an empty bounded provider response leaves the Pipeline blocked rather than failing the Research-level analysis contract", blocked.status === "blocked" && calls.length === 1 && blocked.execution?.outputs.length === 0));
  results.push(check("[No double execution] blocked step has exactly one skipped trace and no Calculation result", blocked.execution?.trace.length === 1 && blocked.execution.steps[0]?.status === "skipped_blocked"));

  const requestedBar = await runCortexAnalysisPipeline(input("Make a bar chart"));
  results.push(check("[User override] an explicit valid Bar request is retained as Bar by the canonical path", (requestedBar.execution?.outputs[0]?.output as { block?: { chartType?: string } })?.block?.chartType === "bar"));
  results.push(check("[No synthesis] Pipeline result contains structured execution state only, not a cross-capability writer answer or Artifact mutation", !Object.prototype.hasOwnProperty.call(requestedBar, "answer") && !Object.prototype.hasOwnProperty.call(requestedBar, "artifacts")));

  const cancelled = new AbortController(); cancelled.abort();
  const cancelledResult = await runCortexAnalysisPipeline(input("Calculate CAGR", { signal: cancelled.signal }));
  results.push(check("[Cancellation] signal propagates to execution without a new search or an untraced result", cancelledResult.status === "cancelled" && cancelledResult.execution?.steps[0]?.status === "cancelled"));
  return summarize("cortexAnalysisPipelineIntegration", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
