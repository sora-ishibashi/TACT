import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reviewResearchFrameworks } from "../../../core/tact-analysis/research/framework";
import type { FrameworkResult, ResearchFrameworkAnalysis } from "../../../core/tact-analysis/framework/types";
import { check, summarize, type CheckResult } from "../lib/check";

const evidence = [{ id: "ev1", claim: "", text: "external opportunity: market growth" }];
const output: FrameworkResult = { frameworkId: "framework.swot", frameworkVersion: "1", sourceEvidenceIds: ["ev1"], warnings: [], sections: [{ id: "opportunity", label: "Opportunity", sourceEvidenceIds: ["ev1"], items: [{ id: "fact", sectionId: "opportunity", kind: "fact", text: "external opportunity: market growth", sourceEvidenceIds: ["ev1"] }, { id: "inf", sectionId: "opportunity", kind: "inference", text: "market growth may be a tailwind", sourceEvidenceIds: ["ev1"] }] }] };
function base(): { frameworks: ResearchFrameworkAnalysis[]; frameworkWarnings: [] } {
  return { frameworks: [{ frameworkId: "framework.swot", warnings: [], inference: { attempted: true, llmUsed: true, acceptedCount: 1, warnings: [] }, result: { id: "result", rule: { id: "framework.swot", version: "1" }, status: "success", output, sourceEvidenceIds: ["ev1"], warnings: [], trace: { startedAt: "", completedAt: "", deterministic: true, llmUsed: false, inputIds: [] } } }], frameworkWarnings: [] };
}

export async function run() {
  const checks: CheckResult[] = [];
  let calls = 0;
  const reviewed = await reviewResearchFrameworks(base(), "SWOT analysis", evidence, { runLLMImpl: async () => { calls += 1; return { content: JSON.stringify({ reviews: [{ inferenceId: "inf", verdict: "supported", supportedEvidenceIds: ["ev1"], reason: "grounded" }] }) }; } });
  checks.push(check("[Research] one reviewer call enriches Framework result before Artifact adaptation", calls === 1 && reviewed.frameworks?.[0]?.reviewer?.supported === 1 && reviewed.frameworks[0]?.result?.output?.sections[0]?.items.length === 2));
  const failed = await reviewResearchFrameworks(base(), "SWOT analysis", evidence, { runLLMImpl: async () => { throw new Error("mock reviewer failure"); } });
  checks.push(check("[Research] reviewer failure preserves Research while returning Fact-only framework", failed.frameworks?.[0]?.reviewer?.failed === true && failed.frameworks[0]?.result?.output?.sections[0]?.items.length === 1));
  let zeroCalls = 0;
  const noGenerated = base(); noGenerated.frameworks[0].inference = { attempted: false, llmUsed: false, acceptedCount: 0, warnings: [] };
  await reviewResearchFrameworks(noGenerated, "SWOT analysis", evidence, { runLLMImpl: async () => { zeroCalls += 1; return { content: "{}" }; } });
  checks.push(check("[Research] no accepted inference skips reviewer", zeroCalls === 0));
  return summarize("cortexFrameworkReviewerIntegration", checks);
}

const direct = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (direct === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
