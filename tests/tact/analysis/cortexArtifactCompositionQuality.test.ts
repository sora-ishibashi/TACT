import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyArtifactCompositionQuality,
  composeAnalysisArtifactPlan,
  createDefaultAnalysisCapabilityRegistry,
  createFrameworkCortexRegistry,
  detectExclusiveArtifactIntent,
  runCortexAnalysisPipeline,
  structuralBlockSignature,
  type AnalysisArtifactCandidate,
} from "../../../core/tact-analysis";
import type { TableBlock } from "../../../core/tact-artifact/types";
import { check, summarize, type CheckResult } from "../lib/check";

const evidence = [
  { id: "ev-2022", text: "A 2022 Revenue: 100", claim: "A 2022 Revenue: 100" },
  { id: "ev-2024", text: "A 2024 Revenue: 169", claim: "A 2024 Revenue: 169" },
];

async function pipeline(objective: string) {
  return runCortexAnalysisPipeline({ objective, targetEntity: "A", evidence, cortexRegistry: createFrameworkCortexRegistry(), capabilityRegistry: createDefaultAnalysisCapabilityRegistry() });
}

function table(id: string, title: string, rows: string[][], sourceEvidenceIds: string[]): TableBlock {
  return {
    id, type: "table", title, columns: ["Calculation", "Display value"], rows,
    sourceEvidenceIds, rowSourceEvidenceIds: rows.map(() => [...sourceEvidenceIds]),
    cellSourceEvidenceIds: rows.map(() => [undefined, [...sourceEvidenceIds]]),
    order: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function candidate(block: TableBlock, capabilityId: string, explicitRequest: boolean, planStepOrder: number): AnalysisArtifactCandidate {
  return { block, role: "detail", sourceStepIds: [`step:${capabilityId}:${planStepOrder}`], capabilityIds: [capabilityId], explicitRequest, planStepOrder };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const lineAndCagr = composeAnalysisArtifactPlan(await pipeline("Calculate CAGR and make a line chart"));
  results.push(check("[Primary] locked explicit Line is primary and its Calculation is supporting", lineAndCagr.candidates?.[0]?.capabilityIds[0] === "presentation.line" && lineAndCagr.candidates?.[0]?.role === "primary" && lineAndCagr.candidates?.[0]?.explicitRequest === true && lineAndCagr.candidates?.[1]?.capabilityIds[0] === "calculation.cagr" && lineAndCagr.candidates?.[1]?.role === "supporting"));

  const tableAndCagr = composeAnalysisArtifactPlan(await pipeline("Calculate CAGR and make a table"));
  results.push(check("[Primary] explicit Table is primary", tableAndCagr.candidates?.[0]?.capabilityIds[0] === "presentation.table" && tableAndCagr.candidates?.[0]?.role === "primary"));

  const frameworkAndTable = composeAnalysisArtifactPlan(await pipeline("Perform SWOT analysis and make a table"));
  results.push(check("[Primary] explicit Framework remains primary when paired with a generic Table", frameworkAndTable.candidates?.[0]?.capabilityIds[0] === "framework.swot" && frameworkAndTable.candidates?.[0]?.role === "primary"));

  const repeated = composeAnalysisArtifactPlan(await pipeline("Calculate CAGR and make a line chart"));
  results.push(check("[Ordering] identical inputs have stable role/capability/block ordering", lineAndCagr.candidates?.map((item) => `${item.role}:${item.capabilityIds.join(",")}:${structuralBlockSignature(item.block)}`).join("|") === repeated.candidates?.map((item) => `${item.role}:${item.capabilityIds.join(",")}:${structuralBlockSignature(item.block)}`).join("|")));

  const lineOnly = composeAnalysisArtifactPlan(await pipeline("Calculate CAGR and make a line chart only"));
  results.push(check("[Exclusive] graph-only output suppresses non-chart Artifact blocks without changing execution", lineOnly.blocks.length === 1 && lineOnly.candidates?.[0]?.capabilityIds[0] === "presentation.line"));
  const tableOnly = composeAnalysisArtifactPlan(await pipeline("Calculate CAGR and make a table only"));
  results.push(check("[Exclusive] table-only output suppresses the supporting Calculation block", tableOnly.blocks.length === 1 && tableOnly.candidates?.[0]?.capabilityIds[0] === "presentation.table"));
  results.push(check("[Exclusive] Japanese graph-only phrasing is detected without an LLM", detectExclusiveArtifactIntent("グラフだけ") === "presentation.any-chart"));
  results.push(check("[Exclusive] explanatory questions do not become exclusive display commands", detectExclusiveArtifactIntent("Does a line chart only show a trend?") === undefined));

  const duplicate = applyArtifactCompositionQuality("make a table", [
    candidate(table("first", "First label", [["cagr", "30%"]], ["ev-1"]), "presentation.table", true, 0),
    candidate(table("second", "Second label", [["cagr", "30%"]], ["ev-2"]), "presentation.table", true, 1),
  ]);
  results.push(check("[Dedupe] structural duplicates ignore runtime IDs/headings and merge block/row/cell provenance", duplicate.candidates.length === 1 && duplicate.candidates[0]?.block.type === "table" && duplicate.candidates[0].block.sourceEvidenceIds?.join(",") === "ev-1,ev-2" && duplicate.candidates[0].block.rowSourceEvidenceIds?.[0]?.join(",") === "ev-1,ev-2" && duplicate.candidates[0].block.cellSourceEvidenceIds?.[0]?.[1]?.join(",") === "ev-1,ev-2" && duplicate.candidates[0].sourceStepIds.length === 2));

  const contained = applyArtifactCompositionQuality("make a table", [
    candidate(table("primary", "Verified values", [["cagr", "30%"], ["note", "verified"]], ["ev-1"]), "presentation.table", true, 0),
    candidate(table("support", "CAGR", [["cagr", "30%"]], ["ev-2"]), "calculation.cagr", true, 1),
  ]);
  results.push(check("[Redundancy] only a strictly row/column-contained supporting Calculation is suppressed with provenance retained", contained.candidates.length === 1 && contained.candidates[0]?.sourceStepIds.length === 2 && contained.candidates[0]?.block.type === "table" && contained.candidates[0].block.sourceEvidenceIds?.join(",") === "ev-1,ev-2" && contained.warnings.some((item) => item.code === "COMPOSITION_REDUNDANT_BLOCK")));

  const semanticOnly = applyArtifactCompositionQuality("make a table", [
    candidate(table("primary", "Values", [["metric", "30%"]], ["ev-1"]), "presentation.table", true, 0),
    candidate(table("support", "CAGR", [["cagr", "30%"]], ["ev-1"]), "calculation.cagr", true, 1),
  ]);
  results.push(check("[Redundancy] semantic-looking but structurally different rows are retained", semanticOnly.candidates.length === 2));

  results.push(check("[Heading] calculation/framework/presentation headings are short and deterministic", lineAndCagr.blocks[0]?.type === "chart" && lineAndCagr.blocks[0].title === "revenue推移" && frameworkAndTable.blocks[0]?.title === "SWOT分析" && lineAndCagr.blocks[1]?.title === "CAGR"));
  const withoutMetric = {
    ...await pipeline("Make a line chart"),
  };
  const unknownMetricPlan = composeAnalysisArtifactPlan({
    ...withoutMetric,
    datasets: withoutMetric.datasets.map((dataset) => ({
      ...dataset,
      rows: dataset.rows.map((row) => {
        const values = Object.fromEntries(Object.entries(row.values).filter(([columnId]) => columnId !== "metric"));
        return { ...row, values };
      }),
    })),
  });
  results.push(check("[Heading] missing Dataset metric does not invent a presentation title", unknownMetricPlan.blocks[0]?.type === "chart" && unknownMetricPlan.blocks[0].title === undefined));

  const explosive = new Proxy(table("explosive", "Safe fallback", [["cagr", "30%"]], ["ev-1"]), { get() { throw new Error("quality test"); } });
  const fallback = applyArtifactCompositionQuality("make a table", [candidate(explosive, "presentation.table", true, 0)]);
  results.push(check("[Failure] quality errors retain the original validated candidate rather than dropping it", fallback.candidates.length === 1 && fallback.warnings.some((item) => item.code === "COMPOSITION_QUALITY_FAILED")));
  results.push(check("[Safety] empty quality input stays empty and has no execution/LLM/Search surface", applyArtifactCompositionQuality("", []).candidates.length === 0 && !("llm" in lineAndCagr) && !("search" in lineAndCagr) && !("executionResult" in lineAndCagr)));
  return summarize("cortexArtifactCompositionQuality", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directFile === import.meta.url) run().then(({ fail }) => { if (fail) process.exitCode = 1; });
