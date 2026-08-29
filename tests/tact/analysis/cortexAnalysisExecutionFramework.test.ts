import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildConstrainedAnalysisPlan, createDefaultAnalysisCapabilityRegistry, createFrameworkCortexRegistry, executeAnalysisPlan } from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = []; const capabilities = createDefaultAnalysisCapabilityRegistry();
  const evidence = [{ id: "ev-company", text: "Company strength: A has loyal customers" }];
  const planned = await buildConstrainedAnalysisPlan({ objective: "Perform SWOT analysis", targetEntity: "A", evidence }, { registry: capabilities }); if (!planned.plan) throw new Error("expected framework plan");
  const factOnly = await executeAnalysisPlan({ plan: planned.plan, datasets: [], evidence, targetEntity: "A", registry: createFrameworkCortexRegistry(), capabilityRegistry: capabilities });
  const framework = factOnly.outputs[0]?.output as { sections?: { items: { kind: string; sourceEvidenceIds: string[] }[] }[] } | undefined;
  results.push(check("[SWOT] planned Framework reuses deterministic fact Rule and preserves item provenance", factOnly.steps[0]?.status === "completed" && framework?.sections?.some((section) => section.items.some((item) => item.kind === "fact" && item.sourceEvidenceIds[0] === "ev-company")) === true));
  results.push(check("[Policy] no Framework provider means no new LLM call and fact-only completion remains valid", factOnly.outputs[0]?.trace.llmUsed === false && factOnly.status === "completed"));
  const automatic = { ...planned.plan, steps: planned.plan.steps.map((step) => ({ ...step, evaluation: { ...step.evaluation, explicitRequest: false } })) };
  const automaticResult = await executeAnalysisPlan({ plan: automatic, datasets: [], evidence, targetEntity: "A", registry: createFrameworkCortexRegistry(), capabilityRegistry: capabilities });
  results.push(check("[Automatic] automatic Framework execution does not broaden the existing inference policy", automaticResult.steps[0]?.status === "completed" && automaticResult.outputs[0]?.trace.llmUsed === false));
  for (const [objective, text, expected] of [["Perform 3C analysis", "Customer: demand grew", "framework.3c"], ["Perform PEST analysis", "Economic GDP market growth", "framework.pest"]] as const) {
    const p = await buildConstrainedAnalysisPlan({ objective, evidence: [{ id: expected, text }] }, { registry: capabilities }); if (!p.plan) throw new Error("expected framework plan");
    const run = await executeAnalysisPlan({ plan: p.plan, datasets: [], evidence: [{ id: expected, text }], registry: createFrameworkCortexRegistry(), capabilityRegistry: capabilities });
    results.push(check(`[${expected}] deterministic framework Fact execution remains independently available`, run.steps[0]?.status === "completed" && run.outputs[0]?.rule.id === expected));
  }
  return summarize("cortexAnalysisExecutionFramework", results);
}
const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
