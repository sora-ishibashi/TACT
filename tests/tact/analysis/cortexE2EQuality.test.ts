import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  composeAnalysisArtifactPlan,
  createDefaultAnalysisCapabilityRegistry,
  createFrameworkCortexRegistry,
  runCortexAnalysisPipeline,
} from "../../../core/tact-analysis";
import type { CortexAnalysisPipelineResult, CortexPipelineEvidence, RunCortexAnalysisPipelineInput } from "../../../core/tact-analysis/pipeline/types";
import { check, summarize, type CheckResult } from "../lib/check";

const revenueSeries: readonly CortexPipelineEvidence[] = [
  { id: "ev-a-2022", text: "A 2022 Revenue: 100", claim: "A 2022 Revenue: 100" },
  { id: "ev-a-2023", text: "A 2023 Revenue: 130", claim: "A 2023 Revenue: 130" },
  { id: "ev-a-2024", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" },
];
const revenueComparison: readonly CortexPipelineEvidence[] = [
  { id: "ev-a-2024", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" },
  { id: "ev-b-2024", text: "B 2024 Revenue: 150", claim: "B 2024 Revenue: 150" },
  { id: "ev-c-2024", text: "C 2024 Revenue: 120", claim: "C 2024 Revenue: 120" },
];

function run(objective: string, evidence: readonly CortexPipelineEvidence[], targetEntity = "A", overrides: Partial<RunCortexAnalysisPipelineInput> = {}) {
  return runCortexAnalysisPipeline({
    objective,
    evidence,
    targetEntity,
    cortexRegistry: createFrameworkCortexRegistry(),
    capabilityRegistry: createDefaultAnalysisCapabilityRegistry(),
    ...overrides,
  });
}

function composed(result: CortexAnalysisPipelineResult) {
  return composeAnalysisArtifactPlan(result);
}

function completed(result: CortexAnalysisPipelineResult, capabilityId: string): boolean {
  return result.execution?.steps.filter((step) => step.capabilityId === capabilityId && step.status === "completed").length === 1;
}

function exactlyOneTracePerPlannedStep(result: CortexAnalysisPipelineResult): boolean {
  return Boolean(result.plan && result.execution && result.execution.trace.length === result.plan.steps.length);
}

export async function runTests(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  const cagr = await run("A社の2022〜2024年の売上CAGRを計算して", revenueSeries);
  const cagrArtifact = composed(cagr);
  results.push(check("[CAGR] Japanese explicit request builds one verified Dataset, executes CAGR once, and composes one provenance-preserving Artifact", cagr.status === "completed" && completed(cagr, "calculation.cagr") && !cagr.fulfillment && cagrArtifact.blocks.length === 1 && cagrArtifact.sourceEvidenceIds.join(",") === "ev-a-2022,ev-a-2024" && exactlyOneTracePerPlannedStep(cagr)));

  const growth = await run("A社の2023年から2024年の売上成長率を出して", revenueSeries.slice(1));
  results.push(check("[Growth] explicit period request executes the existing growth Rule exactly once without search or a duplicate Artifact", growth.status === "completed" && completed(growth, "calculation.growth-rate") && !growth.fulfillment && composed(growth).blocks.length === 1 && exactlyOneTracePerPlannedStep(growth)));

  const ranking = await run("A社・B社・C社を2024年売上でランキングして", revenueComparison);
  const rankingArtifact = composed(ranking);
  results.push(check("[Ranking] same-period comparable evidence yields one dense-ranking output with row provenance", ranking.status === "completed" && completed(ranking, "calculation.ranking") && rankingArtifact.blocks.length === 1 && rankingArtifact.blocks[0]?.type === "table" && rankingArtifact.blocks[0].rowSourceEvidenceIds?.[0]?.[0] === "ev-a-2024"));

  const table = await run("A社とB社の売上を表で比較して", revenueComparison.slice(0, 2));
  const tableArtifact = composed(table);
  results.push(check("[Table] explicit table request uses the completed Presentation output directly and retains cell provenance", table.status === "completed" && completed(table, "presentation.table") && tableArtifact.blocks.length === 1 && tableArtifact.blocks[0]?.type === "table" && tableArtifact.blocks[0].cellSourceEvidenceIds?.[0]?.[3]?.[0] === "ev-a-2024"));

  const line = await run("A社の売上推移を折れ線グラフにして", revenueSeries);
  const lineArtifact = composed(line);
  results.push(check("[Line] explicit line request is completed once and produces a primary line Artifact with point provenance", line.status === "completed" && completed(line, "presentation.line") && lineArtifact.blocks.length === 1 && lineArtifact.blocks[0]?.type === "chart" && lineArtifact.blocks[0].chartType === "line" && lineArtifact.blocks[0].pointSourceEvidenceIds?.[2]?.[0] === "ev-a-2024"));

  const barOverride = await run("A社の売上推移を棒グラフにして", revenueSeries);
  const barArtifact = composed(barOverride);
  results.push(check("[Bar override] a valid explicit Bar request remains Bar even though a Line is structurally more suitable", barOverride.status === "completed" && completed(barOverride, "presentation.bar") && barArtifact.blocks.length === 1 && barArtifact.blocks[0]?.type === "chart" && barArtifact.blocks[0].chartType === "bar"));

  const swotEvidence: readonly CortexPipelineEvidence[] = [
    { id: "ev-strength", text: "company strength: loyal customers", claim: "company strength: loyal customers" },
    { id: "ev-weakness", text: "company weakness: limited capacity", claim: "company weakness: limited capacity" },
    { id: "ev-opportunity", text: "external opportunity: market expansion", claim: "external opportunity: market expansion" },
    { id: "ev-threat", text: "external threat: new competitor", claim: "external threat: new competitor" },
  ];
  const swot = await run("A社をSWOT分析して", swotEvidence);
  const swotArtifact = composed(swot);
  results.push(check("[SWOT] explicit Framework request remains deterministic fact-only without an inference/reviewer LLM call and becomes one Framework Artifact", swot.status === "completed" && completed(swot, "framework.swot") && swot.execution?.outputs[0]?.trace.llmUsed === false && swotArtifact.blocks.length === 1 && swotArtifact.blocks[0]?.id.startsWith("framework-table:")));

  const threeC = await run("A社を3C分析して", [
    { id: "ev-customer", text: "customer demand is increasing", claim: "customer demand is increasing" },
    { id: "ev-competitor", text: "competitor reduced price", claim: "competitor reduced price" },
    { id: "ev-company", text: "company retention is high", claim: "company retention is high" },
  ]);
  results.push(check("[3C] explicit Framework request traverses one bounded execution step and has no provider work", threeC.status === "completed" && completed(threeC, "framework.3c") && threeC.execution?.outputs[0]?.trace.llmUsed === false && composed(threeC).blocks.length === 1 && exactlyOneTracePerPlannedStep(threeC)));

  const pest = await run("A社の市場をPEST分析して", [
    { id: "ev-political", text: "political regulation changed", claim: "political regulation changed" },
    { id: "ev-economic", text: "GDP market growth increased", claim: "GDP market growth increased" },
    { id: "ev-social", text: "social population is ageing", claim: "social population is ageing" },
    { id: "ev-tech", text: "AI technology adoption increased", claim: "AI technology adoption increased" },
  ]);
  results.push(check("[PEST] explicit Framework request is finite, fact-only, and composes one Framework Artifact", pest.status === "completed" && completed(pest, "framework.pest") && pest.execution?.outputs[0]?.trace.llmUsed === false && composed(pest).blocks.length === 1 && exactlyOneTracePerPlannedStep(pest)));

  let genericPlannerCalls = 0;
  const generic = await run("A社とB社、どちらが伸びている？", revenueComparison, "A", {
    planner: {
      runLLMImpl: async () => {
        genericPlannerCalls += 1;
        return { content: JSON.stringify({ steps: [{ capabilityId: "presentation.table", reason: "verified comparison evidence" }] }) };
      },
    },
  });
  results.push(check("[Generic analysis] direct Japanese comparison/trend wording reaches one constrained mock-planner call, then executes only its validated capability", generic.status === "completed" && genericPlannerCalls === 1 && generic.summary.plannerLlmUsed && completed(generic, "presentation.table") && composed(generic).blocks.length === 1 && exactlyOneTracePerPlannedStep(generic)));

  const exclusive = await run("A社の売上CAGRを計算して、折れ線グラフだけ出して", revenueSeries);
  const exclusiveArtifact = composed(exclusive);
  results.push(check("[Exclusive intent] calculation may execute for the validated plan, but only the explicitly requested Line Artifact is displayed", exclusive.status === "completed" && completed(exclusive, "calculation.cagr") && completed(exclusive, "presentation.line") && exclusiveArtifact.blocks.length === 1 && exclusiveArtifact.blocks[0]?.type === "chart" && exclusiveArtifact.blocks[0].chartType === "line"));

  const missing = await run("A社の2022〜2024年の売上CAGRを計算して", [{ id: "ev-a-2024", text: "A 2024 Revenue: 100", claim: "A 2024 Revenue: 100" }]);
  results.push(check("[Missing evidence] incomplete time series becomes a traceable blocked plan and Gap, never a guessed result or implicit Search", missing.status === "blocked" && missing.plan?.steps[0]?.status === "blocked" && missing.gapPlan?.researchRequired === true && !missing.fulfillment && missing.execution?.outputs.length === 0 && composed(missing).blocks.length === 0));

  const conflict = await run("A社の2022〜2024年の売上CAGRを計算して", [
    { id: "ev-a-2022", text: "A 2022 Revenue: 100", claim: "A 2022 Revenue: 100" },
    { id: "ev-a-2024-a", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" },
    { id: "ev-a-2024-b", text: "A 2024 Revenue: 180", claim: "A 2024 Revenue: 180" },
  ]);
  results.push(check("[Conflicting evidence] conflicting observations do not pick or average a value, and no Calculation Artifact is fabricated", conflict.status === "blocked" && conflict.execution?.outputs.length === 0 && conflict.warnings.some((warning) => warning.code === "CONFLICTING_OBSERVATION") && composed(conflict).blocks.length === 0));

  const normal = await run("量子コンピュータとは？", []);
  results.push(check("[Normal Research] a non-analysis explanation leaves Cortex entirely not_applicable", normal.status === "not_applicable" && !normal.plan && !normal.gapPlan && !normal.execution && composed(normal).blocks.length === 0));

  const frameworkExplanation = await run("SWOT分析とは？", swotEvidence);
  results.push(check("[Explanation exclusion] a Framework explanation query does not execute SWOT or generate an Artifact", frameworkExplanation.status === "not_applicable" && !frameworkExplanation.execution && composed(frameworkExplanation).blocks.length === 0));

  const attachmentEvidence: readonly CortexPipelineEvidence[] = [
    { id: "attachment-pdf-2022", text: "A 2022 Revenue: 100", claim: "A 2022 Revenue: 100" },
    { id: "attachment-pdf-2024", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" },
  ];
  const attachment = await run("A社の2022〜2024年の売上CAGRを計算して", attachmentEvidence);
  results.push(check("[Attachment Evidence] supplied attachment-equivalent Evidence satisfies Calculation/Dataset flow without provider work and preserves attachment IDs", attachment.status === "completed" && completed(attachment, "calculation.cagr") && !attachment.fulfillment && attachment.execution?.outputs[0]?.sourceEvidenceIds.join(",") === "attachment-pdf-2022,attachment-pdf-2024" && composed(attachment).sourceEvidenceIds.join(",") === "attachment-pdf-2022,attachment-pdf-2024"));

  return summarize("cortexE2EQuality", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) runTests().then(({ fail }) => { if (fail) process.exitCode = 1; });
