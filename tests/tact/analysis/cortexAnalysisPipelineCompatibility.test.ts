import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDefaultAnalysisCapabilityRegistry,
  createFrameworkCortexRegistry,
  projectCortexPipelineForResearch,
  runCortexAnalysisPipeline,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const inputs = [{ id: "ev-2022", text: "A 2022 Revenue: 100", claim: "A 2022 Revenue: 100" }, { id: "ev-2024", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" }];
function pipeline(objective: string) {
  return runCortexAnalysisPipeline({ objective, targetEntity: "A", evidence: inputs, cortexRegistry: createFrameworkCortexRegistry(), capabilityRegistry: createDefaultAnalysisCapabilityRegistry() });
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const calculation = await pipeline("Calculate CAGR");
  const calculationProjection = projectCortexPipelineForResearch(calculation);
  results.push(check("[Calculation projection] completed Pipeline output keeps existing ResearchAnalysis intent/result contract", calculationProjection.analysis?.[0]?.intent === "cagr" && calculationProjection.analysis[0].status === "executed" && calculationProjection.analysis[0].result?.rule.id === "calculation.cagr"));
  results.push(check("[Calculation projection] compatibility projection does not fabricate presentation or Framework output", !calculationProjection.presentations && !calculationProjection.frameworks));

  const line = await pipeline("Make a line chart");
  const lineProjection = projectCortexPipelineForResearch(line);
  const linePresentation = lineProjection.presentations?.[0];
  results.push(check("[Presentation projection] existing ResearchPresentation preserves line block and Dataset provenance", lineProjection.presentationRequested === true && linePresentation?.block.type === "chart" && (linePresentation?.block.sourceEvidenceIds ?? []).join(",") === "ev-2022,ev-2024"));
  results.push(check("[Presentation projection] recommendation is re-evaluated only as metadata and does not execute a second adapter", lineProjection.presentations?.[0]?.recommendation.valid === true && line.execution?.outputs.length === 1));

  const framework = await pipeline("Perform SWOT analysis");
  const frameworkProjection = projectCortexPipelineForResearch(framework);
  results.push(check("[Framework projection] existing ResearchFrameworkAnalysis contract contains the executed result", frameworkProjection.frameworks?.[0]?.frameworkId === "framework.swot" && frameworkProjection.frameworks?.[0]?.result?.output?.frameworkId === "framework.swot"));
  results.push(check("[Framework artifact contract] compatibility derives the existing pure table candidate without mutation/persistence", frameworkProjection.frameworkArtifacts?.[0]?.block.type === "table" && frameworkProjection.frameworkArtifactRequested === true));

  const normal = await pipeline("Explain CAGR");
  const normalProjection = projectCortexPipelineForResearch(normal);
  results.push(check("[Normal Research] no Pipeline execution projects no legacy optional analysis fields", !normalProjection.analysis && !normalProjection.presentationRequested && !normalProjection.frameworkArtifactRequested));
  return summarize("cortexAnalysisPipelineCompatibility", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
