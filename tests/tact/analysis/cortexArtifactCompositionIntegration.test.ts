import "dotenv/config";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { composeAnalysisArtifactPlan, createDefaultAnalysisCapabilityRegistry, createFrameworkCortexRegistry, runCortexAnalysisPipeline } from "../../../core/tact-analysis";
import { buildResearchOutcomeWithOptionalTable } from "../../../core/tact-conversation/orchestration";
import { check, summarize, type CheckResult } from "../lib/check";

const evidence = [{ id: "ev-2022", text: "A 2022 Revenue: 100", claim: "A 2022 Revenue: 100" }, { id: "ev-2024", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" }];
async function artifactPlan(objective: string) { return composeAnalysisArtifactPlan(await runCortexAnalysisPipeline({ objective, evidence, cortexRegistry: createFrameworkCortexRegistry(), capabilityRegistry: createDefaultAnalysisCapabilityRegistry() })); }

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const line = await artifactPlan("Make a line chart");
  const outcome = await buildResearchOutcomeWithOptionalTable(undefined, "Make a line chart", { kind: "normal", executionId: "execution", status: "completed", answer: "", capability: "research", evidence: [], keyFindings: [], presentations: [], frameworkArtifacts: [], analysisArtifactPlans: [line], cortexArtifactPlanRequested: true }, []);
  results.push(check("[Mutation integration] canonical Plan enters the existing research mutation path as exactly one Line block", outcome.blocks?.filter((block) => block.type === "chart").length === 1 && outcome.blocks?.find((block) => block.type === "chart")?.chartType === "line"));
  results.push(check("[Ownership] Cortex plan suppresses compatibility presentation/framework adapters, preventing duplicate blocks", outcome.blocks?.filter((block) => block.type === "chart").length === 1 && outcome.blocks?.filter((block) => block.type === "table").length === 0));

  const cagr = await artifactPlan("Calculate CAGR");
  const first = await buildResearchOutcomeWithOptionalTable(undefined, "Calculate CAGR", { kind: "normal", executionId: "execution", status: "completed", answer: "", capability: "research", evidence: [], keyFindings: [], analysisArtifactPlans: [cagr], cortexArtifactPlanRequested: true }, []);
  const second = await buildResearchOutcomeWithOptionalTable(undefined, "Calculate CAGR", { kind: "normal", executionId: "execution", status: "completed", answer: "", capability: "research", evidence: [], keyFindings: [], analysisArtifactPlans: [cagr], cortexArtifactPlanRequested: true }, first.blocks ?? []);
  results.push(check("[Dedup] reusing a canonical plan against existing Artifact blocks does not append the same block twice", first.blocks?.filter((block) => block.id.startsWith("cortex-calculation:")).length === 1 && second.blocks?.filter((block) => block.id.startsWith("cortex-calculation:")).length === 1));
  results.push(check("[Persistence boundary] composition returns blocks only; existing Conversation mutation remains the sole create/update owner", !Object.prototype.hasOwnProperty.call(cagr, "artifactId") && !Object.prototype.hasOwnProperty.call(cagr, "persisted")));
  return summarize("cortexArtifactCompositionIntegration", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
