import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildDatasets,
  buildResearchPresentations,
  datasetToBarChartBlock,
  datasetToLineChartBlock,
  datasetToTableBlock,
  detectPresentationIntent,
  evaluatePresentation,
  extractEvidenceObservations,
  mergeResearchPresentationBlocks,
  type NumericEvidenceSource,
} from "../../../core/tact-analysis";
import { check, summarize, type CheckResult } from "../lib/check";

function datasetFrom(sources: NumericEvidenceSource[]) {
  return buildDatasets(extractEvidenceObservations(sources).observations).datasets[0];
}

const timeSeries = datasetFrom([
  { id: "ev-time-2024", claim: "A", text: "A社 2024年 売上: 169億円" },
  { id: "ev-time-2022", claim: "A", text: "A社 2022年 売上: 100億円" },
  { id: "ev-time-2023", claim: "A", text: "A社 2023年 売上: 130億円" },
]);

const twoPointSeries = datasetFrom([
  { id: "ev-two-2022", claim: "A", text: "A社 2022年 売上: 100億円" },
  { id: "ev-two-2024", claim: "A", text: "A社 2024年 売上: 169億円" },
]);

const comparison = datasetFrom([
  { id: "ev-comp-a", claim: "A", text: "A社 2024年 売上: 169億円" },
  { id: "ev-comp-b", claim: "B", text: "B社 2024年 売上: 150億円" },
  { id: "ev-comp-c", claim: "C", text: "C社 2024年 売上: 120億円" },
]);

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  results.push(check("[Intent1] table, bar, line, and generic chart requests are explicit", detectPresentationIntent("表にして") === "table" && detectPresentationIntent("棒グラフにして") === "bar-chart" && detectPresentationIntent("折れ線グラフにして") === "line-chart" && detectPresentationIntent("グラフにして") === "chart"));
  results.push(check("[Intent2] presentation explanations do not trigger", detectPresentationIntent("グラフとは？") === undefined && detectPresentationIntent("棒グラフの使い方を説明して") === undefined));

  const tableComparison = evaluatePresentation(comparison, "table");
  const tableTime = evaluatePresentation(timeSeries, "table");
  const barComparison = evaluatePresentation(comparison, "bar-chart");
  const barTime = evaluatePresentation(timeSeries, "bar-chart");
  const lineTime = evaluatePresentation(timeSeries, "line-chart");
  const lineTwo = evaluatePresentation(twoPointSeries, "line-chart");
  const lineComparison = evaluatePresentation(comparison, "line-chart");
  results.push(check("[Rule1] table is valid for comparison and time series", tableComparison.valid && tableComparison.suitability === "high" && tableTime.valid));
  results.push(check("[Rule2] bar recommends comparison above a valid short time series", barComparison.valid && barComparison.suitability === "high" && barTime.valid && barTime.suitability === "medium"));
  results.push(check("[Rule3] line requires time series and distinguishes 3 from 2 points", lineTime.valid && lineTime.suitability === "high" && lineTwo.valid && lineTwo.suitability === "medium" && !lineComparison.valid));

  const table = datasetToTableBlock(comparison, { order: 3, title: "Revenue" });
  const bar = datasetToBarChartBlock(comparison, { order: 4, labelColumnId: "entity", valueColumnId: "value" });
  const line = datasetToLineChartBlock(timeSeries, { order: 5, periodColumnId: "period", valueColumnId: "value" });
  results.push(check("[Adapter1] Dataset produces existing TableBlock with cell provenance", table.ok && table.block.type === "table" && table.block.cellSourceEvidenceIds?.[0]?.[3]?.[0] === "ev-comp-a"));
  results.push(check("[Adapter2] comparison produces Bar ChartBlock with point provenance", bar.ok && bar.block.chartType === "bar" && bar.block.data.map((item) => item.label).join(",") === "A社,B社,C社" && bar.block.pointSourceEvidenceIds?.[1]?.[0] === "ev-comp-b"));
  results.push(check("[Adapter3] time series produces ordered Line ChartBlock with point provenance", line.ok && line.block.chartType === "line" && line.block.data.map((item) => item.label).join(",") === "2022年,2023年,2024年" && line.block.pointSourceEvidenceIds?.[2]?.[0] === "ev-time-2024"));

  const genericTime = buildResearchPresentations("A社の売上推移をグラフにして", [timeSeries]);
  const genericComparison = buildResearchPresentations("2024年の売上をグラフにして", [comparison]);
  const overrideBar = buildResearchPresentations("A社の売上推移を棒グラフにして", [timeSeries]);
  const invalidLine = buildResearchPresentations("2024年の売上を折れ線グラフにして", [comparison]);
  results.push(check("[Selection1] generic chart deterministically selects line for time series and bar for comparison", genericTime.presentations[0]?.block.type === "chart" && genericTime.presentations[0]?.block.chartType === "line" && genericComparison.presentations[0]?.block.type === "chart" && genericComparison.presentations[0]?.block.chartType === "bar"));
  results.push(check("[Selection2] explicit valid bar overrides a medium recommendation", overrideBar.presentations[0]?.type === "bar-chart" && overrideBar.presentations[0]?.block.type === "chart" && overrideBar.presentations[0]?.block.chartType === "bar"));
  results.push(check("[Selection3] invalid explicit line is not silently replaced", invalidLine.requested && invalidLine.presentations.length === 0 && invalidLine.warnings.some((issue) => issue.code === "PRESENTATION_INVALID_FOR_DATASET")));

  const missingValueDataset = {
    ...timeSeries,
    rows: timeSeries.rows.map((row, index) => index === 1 ? { ...row, values: { ...row.values, value: { ...row.values.value, raw: null, normalized: null } } } : row),
  };
  const missingLine = evaluatePresentation(missingValueDataset, "line-chart");
  results.push(check("[Validation1] missing chart values are rejected instead of treated as zero", !missingLine.valid && missingLine.issues.some((issue) => issue.code === "NON_NUMERIC_SERIES")));

  const merged = genericTime.presentations.length > 0
    ? mergeResearchPresentationBlocks([], genericTime.presentations)
    : [];
  results.push(check("[Artifact1] validated presentation merges through Artifact block adapter", merged.length === 1 && merged[0].type === "chart" && merged[0].chartType === "line" && merged[0].sourceEvidenceIds?.length === 3));

  return summarize("cortexPresentation", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (directFile === import.meta.url) {
  run().then(({ fail }) => {
    if (fail > 0) process.exitCode = 1;
  });
}
