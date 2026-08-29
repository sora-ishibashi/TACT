import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDefaultAnalysisCapabilityRegistry,
  createFrameworkCortexRegistry,
  isCortexAnalysisEligible,
  runCortexAnalysisPipeline,
  type ResearchFulfillmentSearchAdapter,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const registry = () => createFrameworkCortexRegistry();
const capabilities = () => createDefaultAnalysisCapabilityRegistry();
const onePoint = [{ id: "ev-2024", text: "A 2024 Revenue: 100", claim: "A 2024 Revenue: 100" }];
const series = [{ id: "ev-2022", text: "A 2022 Revenue: 100", claim: "A 2022 Revenue: 100" }, { id: "ev-2024", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" }];

function mockSearch(additions: readonly { id: string; text: string }[], calls: string[]): ResearchFulfillmentSearchAdapter {
  return { async search(request) { calls.push(request.queries[0]); return { evidence: additions }; } };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const normal = await runCortexAnalysisPipeline({ objective: "Explain CAGR", evidence: series, cortexRegistry: registry(), capabilityRegistry: capabilities() });
  results.push(check("[Eligibility] explanation request is not applicable and creates no plan/gap/execution", normal.status === "not_applicable" && !normal.plan && !normal.gapPlan && !normal.execution));
  results.push(check("[Eligibility] explicit and generic deterministic signals are distinguishable without an LLM", isCortexAnalysisEligible("Calculate CAGR") && isCortexAnalysisEligible("Compare these results") && !isCortexAnalysisEligible("Explain ranking")));

  const ready = await runCortexAnalysisPipeline({ objective: "Calculate CAGR", evidence: series, cortexRegistry: registry(), capabilityRegistry: capabilities() });
  results.push(check("[Ready] Dataset is built once and CAGR is planned then executed through the existing Rule", ready.status === "completed" && ready.datasets.length === 1 && ready.execution?.outputs[0]?.rule.id === "calculation.cagr"));
  results.push(check("[Ready] ready calculation creates no fulfillment gap or provider work", !ready.gapPlan && !ready.fulfillment && ready.summary.fulfillmentAttempted === false));
  results.push(check("[Provenance] execution retains the original evidence IDs", ready.execution?.outputs[0]?.sourceEvidenceIds.join(",") === "ev-2022,ev-2024"));

  const calls: string[] = [];
  const fulfilled = await runCortexAnalysisPipeline({ objective: "Calculate CAGR", evidence: onePoint, targetEntity: "A", cortexRegistry: registry(), capabilityRegistry: capabilities(), searchAdapter: mockSearch([{ id: "ev-2023", text: "A 2023 Revenue: 130" }], calls) });
  results.push(check("[Fulfillment] only blocked hard requirements use the injected bounded adapter and can unblock a plan", calls.length === 1 && fulfilled.fulfillment?.updatedPlan.steps[0]?.status === "ready" && fulfilled.execution?.steps[0]?.status === "completed"));
  results.push(check("[Fulfillment] fulfilled evidence is the execution input, with no recursive Research call", fulfilled.evidence.map((item) => item.id).join(",") === "ev-2024,ev-2023" && fulfilled.summary.fulfillmentAttempted));

  const blocked = await runCortexAnalysisPipeline({ objective: "Calculate CAGR", evidence: onePoint, targetEntity: "A", cortexRegistry: registry(), capabilityRegistry: capabilities() });
  results.push(check("[Blocked] no adapter preserves a blocked plan and still produces a traceable no-Rule execution result", blocked.status === "blocked" && blocked.execution?.steps[0]?.status === "skipped_blocked" && !blocked.fulfillment));

  const noProgressCalls: string[] = [];
  const noProgress = await runCortexAnalysisPipeline({ objective: "Calculate CAGR", evidence: onePoint, targetEntity: "A", cortexRegistry: registry(), capabilityRegistry: capabilities(), searchAdapter: mockSearch([], noProgressCalls) });
  results.push(check("[NoProgress] a failed fulfillment remains non-fatal and does not fabricate a Calculation output", noProgress.status === "blocked" && noProgressCalls.length === 1 && noProgress.execution?.outputs.length === 0));

  const line = await runCortexAnalysisPipeline({ objective: "Make a line chart", evidence: series, cortexRegistry: registry(), capabilityRegistry: capabilities() });
  results.push(check("[Presentation] explicit line request is planned/executed once as a pure presentation output", line.status === "completed" && (line.execution?.outputs[0]?.output as { block?: { chartType?: string } })?.block?.chartType === "line"));

  const framework = await runCortexAnalysisPipeline({ objective: "Perform SWOT analysis", targetEntity: "A", evidence: [{ id: "ev-strength", text: "Our company has 100 customers", claim: "Our company has 100 customers" }], cortexRegistry: registry(), capabilityRegistry: capabilities() });
  results.push(check("[Framework] explicit Framework fact execution uses the same plan path and remains LLM-free without a provider", framework.status === "completed" && framework.execution?.outputs[0]?.rule.id === "framework.swot" && framework.execution.outputs[0]?.trace.llmUsed === false));

  return summarize("cortexAnalysisPipeline", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
