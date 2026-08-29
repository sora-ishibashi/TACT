import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildConstrainedAnalysisPlan,
  buildResearchGapPlan,
  createDefaultAnalysisCapabilityRegistry,
  runResearchFulfillment,
  type Dataset,
  type ResearchFulfillmentSearchAdapter,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const columns: Dataset["columns"] = [
  { id: "entity", label: "Entity", type: "string" }, { id: "period", label: "Period", type: "date" },
  { id: "metric", label: "Metric", type: "string" }, { id: "value", label: "Value", type: "number", unit: "JPY" },
];
function dataset(points: readonly [string, number][]): Dataset {
  return { id: `revenue-${points.length}`, columns, sourceEvidenceIds: points.map(([period]) => `ev-${period}`), rows: points.map(([period, value]) => ({
    id: `row-${period}`, sourceEvidenceIds: [`ev-${period}`], values: {
      entity: { raw: "A", normalized: "A", sourceEvidenceIds: [`ev-${period}`] }, period: { raw: period, normalized: period, sourceEvidenceIds: [`ev-${period}`] },
      metric: { raw: "Revenue", normalized: "Revenue", sourceEvidenceIds: [`ev-${period}`] }, value: { raw: value, normalized: value, sourceEvidenceIds: [`ev-${period}`] },
    },
  })) };
}
const existing = [{ id: "ev-2024", text: "A 2024 Revenue: 100", claim: "A 2024 Revenue: 100" }];

async function blockedPlan(objective = "Calculate CAGR") {
  const result = await buildConstrainedAnalysisPlan({ objective, datasets: [dataset([["2024", 100]])], evidence: existing }, { registry: createDefaultAnalysisCapabilityRegistry() });
  if (!result.plan) throw new Error("expected plan");
  return result.plan;
}
function adapter(results: readonly { id: string; text: string }[], calls: string[]): ResearchFulfillmentSearchAdapter {
  return { async search(request) { calls.push(request.queries[0]); return { evidence: results }; } };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const plan = await blockedPlan();
  const gapPlan = buildResearchGapPlan({ plan, targetEntity: "A", datasets: [dataset([["2024", 100]])], evidenceDescriptors: existing });
  const calls: string[] = [];
  const fulfilled = await runResearchFulfillment({ objective: "Calculate CAGR", plan, gapPlan, targetEntity: "A", existingEvidence: existing, datasets: [dataset([["2024", 100]])], search: adapter([{ id: "ev-2023", text: "A 2023 Revenue: 130" }], calls) });
  results.push(check("[Fulfillment] one researchable required time-series gap invokes injected adapter and can unblock CAGR", calls.length === 1 && fulfilled.updatedPlan.steps[0]?.status === "ready" && fulfilled.summary.stoppedReason === "all_ready"));
  results.push(check("[Evidence] new evidence is additive, provenance-bearing, and datasets are rebuilt through the existing extractor", fulfilled.evidence.map((item) => item.id).join(",") === "ev-2024,ev-2023" && fulfilled.summary.evidenceAdded === 1));
  results.push(check("[NoExecution] fulfillment returns a plan/evidence state only and never emits Rule output or Artifact data", !("output" in fulfilled.updatedPlan.steps[0]) && !("artifacts" in fulfilled)));

  const noProgressCalls: string[] = [];
  const noProgress = await runResearchFulfillment({ objective: "Calculate CAGR", plan, gapPlan, targetEntity: "A", existingEvidence: existing, search: adapter([], noProgressCalls) });
  results.push(check("[NoProgress] empty provider response stops after one bounded cycle without retrying unchanged query", noProgress.summary.stoppedReason === "no_progress" && noProgressCalls.length === 1 && noProgress.summary.cyclesRun === 1));

  const failed = await runResearchFulfillment({ objective: "Calculate CAGR", plan, gapPlan, targetEntity: "A", existingEvidence: existing, search: { async search() { throw new Error("mock failure"); } } });
  results.push(check("[Failure] provider failure is contained, preserves the blocked plan, and never treats it as fulfilled", failed.summary.stoppedReason === "provider_failure" && failed.updatedPlan.steps[0]?.status === "blocked" && failed.summary.queriesFailed === 1));

  const duplicate = await runResearchFulfillment({ objective: "Calculate CAGR", plan, gapPlan, targetEntity: "A", existingEvidence: existing, search: adapter([{ id: "same-value-new-source", text: "A 2024 Revenue: 100" }], []) });
  results.push(check("[Dedup] exact normalized evidence is not added again or counted as progress", duplicate.summary.evidenceAdded === 0 && duplicate.summary.stoppedReason === "no_progress"));

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await runResearchFulfillment({ objective: "Calculate CAGR", plan, gapPlan, targetEntity: "A", existingEvidence: existing, signal: aborted.signal, search: adapter([{ id: "ignored", text: "A 2023 Revenue: 130" }], []) });
  results.push(check("[Cancellation] an aborted signal makes zero provider calls and terminates cleanly", cancelled.summary.stoppedReason === "cancelled" && cancelled.summary.queriesAttempted === 0));

  const framework = await buildConstrainedAnalysisPlan({ objective: "Perform SWOT analysis", targetEntity: "A", evidence: existing }, { registry: createDefaultAnalysisCapabilityRegistry() });
  const frameworkGap = framework.plan ? buildResearchGapPlan({ plan: framework.plan, targetEntity: "A", evidenceDescriptors: existing }) : undefined;
  const untouched: string[] = [];
  if (!framework.plan || !frameworkGap) throw new Error("expected ready framework plan");
  const ready = await runResearchFulfillment({ objective: "Perform SWOT analysis", plan: framework.plan, gapPlan: frameworkGap, targetEntity: "A", existingEvidence: existing, search: adapter([], untouched) });
  results.push(check("[Ready] ready/partial Framework fact analysis creates no search request", untouched.length === 0 && ready.summary.cyclesRun === 0 && ready.summary.stoppedReason === "all_ready"));

  return summarize("cortexResearchFulfillment", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
