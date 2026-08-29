import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  composeAnalysisArtifactPlan,
  createDefaultAnalysisCapabilityRegistry,
  createFrameworkCortexRegistry,
  runCortexAnalysisPipeline,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

const series = [{ id: "ev-2022", text: "A 2022 Revenue: 100", claim: "A 2022 Revenue: 100" }, { id: "ev-2024", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" }];
const comparison = [{ id: "ev-a", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" }, { id: "ev-b", text: "B 2024 Revenue: 150", claim: "B 2024 Revenue: 150" }, { id: "ev-c", text: "C 2024 Revenue: 120", claim: "C 2024 Revenue: 120" }];
function pipeline(objective: string, evidence = series) { return runCortexAnalysisPipeline({ objective, targetEntity: "A", evidence, cortexRegistry: createFrameworkCortexRegistry(), capabilityRegistry: createDefaultAnalysisCapabilityRegistry() }); }

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const cagr = await pipeline("Calculate CAGR"); const cagrPlan = composeAnalysisArtifactPlan(cagr);
  results.push(check("[CAGR] completed scalar result becomes an existing provenance-preserving TableBlock without recalculation", cagrPlan.blocks.length === 1 && cagrPlan.blocks[0]?.type === "table" && cagrPlan.blocks[0]?.id.startsWith("cortex-calculation:") && cagrPlan.sourceEvidenceIds.join(",") === "ev-2022,ev-2024"));
  results.push(check("[CAGR] exact display/raw value and formula are retained in deterministic Artifact rows", cagrPlan.blocks[0]?.type === "table" && cagrPlan.blocks[0].rows[0]?.[1] === "30%" && cagrPlan.blocks[0].rows[0]?.[2].startsWith("0.300") && cagrPlan.blocks[0].rows[0]?.[3] === "(end/start)^(1/periods)-1"));

  const rank = await pipeline("Rank Revenue", comparison); const rankPlan = composeAnalysisArtifactPlan(rank);
  results.push(check("[Ranking] dense ranking is adapted as a multi-row existing TableBlock with row provenance", rankPlan.blocks[0]?.type === "table" && rankPlan.blocks[0].rows.length === 3 && rankPlan.blocks[0].rows[0]?.[0] === "A" && rankPlan.blocks[0].rowSourceEvidenceIds?.[0]?.[0] === "ev-a"));

  const table = await pipeline("Make a table"); const tablePlan = composeAnalysisArtifactPlan(table);
  results.push(check("[Table] completed presentation reuses the exact Phase 5E block and cell provenance", tablePlan.blocks[0]?.type === "table" && tablePlan.blocks[0].cellSourceEvidenceIds?.[0]?.[3]?.[0] === "ev-2022"));
  const bar = await pipeline("Make a bar chart", comparison); const barPlan = composeAnalysisArtifactPlan(bar);
  results.push(check("[Bar] completed bar Presentation block is reused without a chart adapter rerun", barPlan.blocks[0]?.type === "chart" && barPlan.blocks[0].chartType === "bar" && barPlan.blocks[0].pointSourceEvidenceIds?.[0]?.[0] === "ev-a"));
  const line = await pipeline("Make a line chart"); const linePlan = composeAnalysisArtifactPlan(line);
  results.push(check("[Line] explicit line output is primary and preserves point provenance", linePlan.blocks[0]?.type === "chart" && linePlan.blocks[0].chartType === "line" && linePlan.blocks[0].pointSourceEvidenceIds?.[1]?.[0] === "ev-2024"));
  const lineWithCalculation = composeAnalysisArtifactPlan(await pipeline("Calculate CAGR and make a line chart"));
  results.push(check("[Intent ordering] an explicit Line request is placed before its supporting Calculation", lineWithCalculation.blocks[0]?.type === "chart" && lineWithCalculation.blocks[0].chartType === "line" && lineWithCalculation.blocks[1]?.type === "table" && lineWithCalculation.blocks[1].title === "CAGR"));

  for (const id of ["SWOT", "3C", "PEST"]) {
    const framework = await pipeline(`Perform ${id} analysis`); const artifactPlan = composeAnalysisArtifactPlan(framework);
    results.push(check(`[${id}] completed Framework result is adapted through the existing Framework table adapter`, artifactPlan.blocks[0]?.type === "table" && artifactPlan.blocks[0].id.startsWith("framework-table:") && artifactPlan.sourceStepIds.length === 1));
  }
  const frameworkWithTable = composeAnalysisArtifactPlan(await pipeline("Perform SWOT analysis and make a table"));
  results.push(check("[Intent ordering] an explicit Framework stays ahead of a paired generic Table request", frameworkWithTable.blocks[0]?.type === "table" && frameworkWithTable.blocks[0].id.startsWith("framework-table:") && frameworkWithTable.blocks[1]?.type === "table"));

  const blocked = await pipeline("Calculate CAGR", [{ id: "ev-only", text: "A 2024 Revenue: 100", claim: "A 2024 Revenue: 100" }]);
  results.push(check("[Validation gate] blocked/failed or non-completed steps never enter an Artifact Plan", composeAnalysisArtifactPlan(blocked).blocks.length === 0));
  const onlyUnplanned = { ...cagr, execution: { ...cagr.execution!, steps: [{ ...cagr.execution!.steps[0]!, stepId: "unplanned-step" }] } };
  results.push(check("[Validation gate] an execution output without a validated Plan step is never Artifactized", composeAnalysisArtifactPlan(onlyUnplanned).blocks.length === 0));
  results.push(check("[Empty] not-applicable Pipeline creates no fabricated block", composeAnalysisArtifactPlan(await pipeline("Explain CAGR")).blocks.length === 0));
  return summarize("cortexAnalysisComposition", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
