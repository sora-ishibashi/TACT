import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildDatasets,
  extractEvidenceObservations,
  normalizeObservationEntity,
  normalizeObservationMetric,
  runResearchCalculation,
  type EvidenceObservation,
  type NumericEvidenceSource,
} from "../../../core/tact-analysis";
import type { CortexCalculationOutput } from "../../../core/tact-analysis/calculation/types";
import { check, summarize, type CheckResult } from "../lib/check";

const timeSeriesEvidence: NumericEvidenceSource[] = [
  { id: "ev-a-2022", claim: "A annual revenue", text: "A社 2022年 売上: 100億円" },
  { id: "ev-a-2023", claim: "A annual revenue", text: "A社 売上 2023年: 130億円" },
  { id: "ev-a-2024", claim: "A annual revenue", text: "2024年 A社 売上: 169億円" },
];

function scalar(output: CortexCalculationOutput | undefined): output is Extract<CortexCalculationOutput, { value: number }> {
  if (!output || !("value" in output)) return false;
  return typeof output.value === "number";
}

function analysisOf(result: Awaited<ReturnType<typeof runResearchCalculation>>) {
  return result.analysis?.[0];
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  const extracted = extractEvidenceObservations(timeSeriesEvidence);
  results.push(check("[Observation1] three strict entity/metric/period/value forms extract safely", extracted.observations.length === 3 && extracted.observations[0].entity === "A社" && extracted.observations[0].metric === "売上" && extracted.observations[0].value.value === 10_000_000_000 && extracted.observations[0].period.granularity === "year" && extracted.observations[0].sourceEvidenceIds[0] === "ev-a-2022"));
  const ambiguous = extractEvidenceObservations([{ id: "ev-approx", claim: "approximate", text: "A社 2024年 売上: 約100億円" }]);
  results.push(check("[Observation2] approximate or unstructured evidence is rejected", ambiguous.observations.length === 0 && ambiguous.warnings.some((issue) => issue.code === "AMBIGUOUS_NUMERIC_EXPRESSION") && extractEvidenceObservations([{ id: "ev-prose", claim: "prose", text: "A社は近年大きく成長し100億円を突破した" }]).observations.length === 0));
  results.push(check("[Normalization1] entity whitespace and metric ASCII case normalize without semantic merge", normalizeObservationEntity("  A社\u3000") === "A社" && normalizeObservationMetric(" SALES ") === "sales" && normalizeObservationMetric("売上高") !== "売上"));

  const builtTimeSeries = buildDatasets(extracted.observations);
  const timeDataset = builtTimeSeries.datasets[0];
  results.push(check("[Dataset1] multi-evidence time series has deterministic rows and cell/row/dataset provenance", Boolean(timeDataset && timeDataset.rows.map((row) => row.values.period.normalized).join(",") === "2022-01-01,2023-01-01,2024-01-01" && timeDataset.sourceEvidenceIds.join(",") === "ev-a-2022,ev-a-2023,ev-a-2024" && timeDataset.rows[0].sourceEvidenceIds.join(",") === "ev-a-2022" && timeDataset.rows[0].values.value.sourceEvidenceIds.join(",") === "ev-a-2022")));

  const duplicate = buildDatasets(extractEvidenceObservations([
    { id: "ev-duplicate-a", claim: "same", text: "A社 2024年 売上: 100億円" },
    { id: "ev-duplicate-b", claim: "same", text: "A社 2024年 売上: 100億円" },
  ]).observations);
  results.push(check("[Dataset2] identical observations merge only provenance", duplicate.datasets.length === 1 && duplicate.datasets[0].rows.length === 1 && duplicate.datasets[0].rows[0].values.value.sourceEvidenceIds.join(",") === "ev-duplicate-a,ev-duplicate-b"));

  const conflict = buildDatasets(extractEvidenceObservations([
    { id: "ev-conflict-a", claim: "conflict", text: "A社 2024年 売上: 100億円" },
    { id: "ev-conflict-b", claim: "conflict", text: "A社 2024年 売上: 110億円" },
  ]).observations);
  results.push(check("[Dataset3] conflicting values are not selected or averaged", conflict.datasets.length === 0 && conflict.warnings.some((issue) => issue.code === "CONFLICTING_OBSERVATION")));

  const comparisonEvidence: NumericEvidenceSource[] = [
    { id: "ev-a", claim: "A", text: "A社 2024年 売上: 169億円" },
    { id: "ev-b", claim: "B", text: "B社 2024年 売上: 150億円" },
    { id: "ev-c", claim: "C", text: "C社 2024年 売上: 120億円" },
  ];
  const comparison = buildDatasets(extractEvidenceObservations(comparisonEvidence).observations);
  results.push(check("[Dataset4] cross-sectional comparison uses the same Dataset contract", comparison.datasets.length === 1 && comparison.datasets[0].rows.map((row) => row.values.entity.normalized).join(",") === "A社,B社,C社"));
  results.push(check("[Dataset5] missing observations stay absent and never become implicit zero", comparison.datasets[0].rows.every((row) => row.values.entity.normalized !== "D社") && comparison.datasets[0].rows.every((row) => row.values.value.normalized !== 0)));

  const incompatible = buildDatasets(extractEvidenceObservations([
    { id: "ev-unit-jpy", claim: "unit", text: "A社 2024年 売上: 100億円" },
    { id: "ev-unit-percent", claim: "unit", text: "B社 2024年 売上: 90%" },
  ]).observations);
  results.push(check("[Dataset6] incompatible units are separated and warned", incompatible.datasets.length === 2 && incompatible.warnings.some((issue) => issue.code === "NUMERIC_UNIT_MISMATCH")));
  const currencyPeriod = { kind: "point", raw: "2024年", start: "2024-01-01", granularity: "year" } as const;
  const currencyObservations: EvidenceObservation[] = [
    { entity: "A社", metric: "revenue", period: currencyPeriod, sourceEvidenceIds: ["ev-jpy"], value: { raw: "100円", value: 100, unit: "JPY", currency: "JPY", period: currencyPeriod, sourceEvidenceIds: ["ev-jpy"] } },
    { entity: "B社", metric: "revenue", period: currencyPeriod, sourceEvidenceIds: ["ev-usd"], value: { raw: "$100", value: 100, unit: "USD", currency: "USD", period: currencyPeriod, sourceEvidenceIds: ["ev-usd"] } },
  ];
  const currencyMismatch = buildDatasets(currencyObservations);
  results.push(check("[Dataset7] unsupported currency conversion is separated and warned", currencyMismatch.datasets.length === 2 && currencyMismatch.warnings.some((issue) => issue.code === "NUMERIC_CURRENCY_MISMATCH")));
  const invalidNumeric = buildDatasets([{ entity: "A社", metric: "revenue", period: currencyPeriod, sourceEvidenceIds: ["ev-invalid"], value: { raw: "NaN", value: Number.NaN, period: currencyPeriod, sourceEvidenceIds: ["ev-invalid"] } }]);
  results.push(check("[Dataset8] invalid numeric values are excluded rather than materialized", invalidNumeric.datasets.length === 0 && invalidNumeric.warnings.some((issue) => issue.code === "INVALID_NUMERIC_VALUE")));

  const cagr = await runResearchCalculation("A社の2022年から2024年のCAGRを計算して", [timeSeriesEvidence[0], timeSeriesEvidence[2]]);
  const cagrOutput = analysisOf(cagr)?.result?.output;
  results.push(check("[CAGR1] separate Evidence becomes one Dataset-backed CAGR with provenance", Boolean(analysisOf(cagr)?.status === "executed" && scalar(cagrOutput) && cagrOutput.formulaId === "cagr" && Math.abs(cagrOutput.value - 0.3) < 0.0000001 && analysisOf(cagr)?.result?.sourceEvidenceIds.join(",") === "ev-a-2022,ev-a-2024" && cagr.datasets?.[0].rows.length === 2)));

  const growth = await runResearchCalculation("A社の成長率を出して", [timeSeriesEvidence[1], timeSeriesEvidence[2]]);
  const growthOutput = analysisOf(growth)?.result?.output;
  results.push(check("[Growth1] separate Evidence becomes Dataset-backed growth-rate", Boolean(analysisOf(growth)?.status === "executed" && scalar(growthOutput) && growthOutput.formulaId === "growth-rate" && growthOutput.value === 0.3 && growthOutput.sourceEvidenceIds.join(",") === "ev-a-2023,ev-a-2024")));

  const ranking = await runResearchCalculation("売上順に並べて", comparisonEvidence);
  const rankingOutput = analysisOf(ranking)?.result?.output;
  results.push(check("[Ranking1] separate Evidence becomes dense ranking", Boolean(analysisOf(ranking)?.status === "executed" && rankingOutput && "rankings" in rankingOutput && rankingOutput.rankings.map((item) => `${item.id}:${item.rank}`).join(",") === "A社:1,B社:2,C社:3")));

  const metricMismatch = await runResearchCalculation("売上順に並べて", [
    { id: "ev-metric-a", claim: "metric", text: "A社 2024年 売上: 100億円" },
    { id: "ev-metric-b", claim: "metric", text: "B社 2024年 価格: 90億円" },
  ]);
  const periodMismatch = await runResearchCalculation("売上順に並べて", [
    { id: "ev-period-a", claim: "period", text: "A社 2023年 売上: 100億円" },
    { id: "ev-period-b", claim: "period", text: "B社 2024年 売上: 90億円" },
  ]);
  results.push(check("[Ranking2] mismatched metric or period cannot be ranked", analysisOf(metricMismatch)?.status === "skipped" && analysisOf(periodMismatch)?.status === "skipped"));

  const entityMismatch = await runResearchCalculation("CAGRを計算して", [
    { id: "ev-entity-a", claim: "entity", text: "A社 2022年 売上: 100億円" },
    { id: "ev-entity-b", claim: "entity", text: "B社 2024年 売上: 169億円" },
  ]);
  const conflictedCalculation = await runResearchCalculation("CAGRを計算して", [
    { id: "ev-calc-conflict-a", claim: "conflict", text: "A社 2022年 売上: 100億円" },
    { id: "ev-calc-conflict-b", claim: "conflict", text: "A社 2022年 売上: 110億円" },
    { id: "ev-calc-conflict-c", claim: "conflict", text: "A社 2024年 売上: 169億円" },
  ]);
  results.push(check("[CAGR2] entity mismatch and conflict skip without failing Research calculation", Boolean(analysisOf(entityMismatch)?.status === "skipped" && analysisOf(conflictedCalculation)?.status === "skipped" && conflictedCalculation.analysisWarnings?.some((issue) => issue.code === "CONFLICTING_OBSERVATION"))));

  const phase2bRegression = await runResearchCalculation("2022年から2024年のCAGRを計算して", [{ id: "ev-legacy-shape", claim: "annual", text: "2022年: 100億円\n2024年: 169億円" }]);
  const legacyOutput = analysisOf(phase2bRegression)?.result?.output;
  const noIntent = await runResearchCalculation("A社の売上を調査して", timeSeriesEvidence);
  results.push(check("[Regression1] Phase 2B same-evidence path remains available and no intent does nothing", Boolean(analysisOf(phase2bRegression)?.status === "executed" && scalar(legacyOutput) && legacyOutput.formulaId === "cagr" && !noIntent.analysis)));

  return summarize("cortexDataset", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (directFile === import.meta.url) {
  run().then(({ fail }) => {
    if (fail > 0) process.exitCode = 1;
  });
}
