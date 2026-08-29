import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildAnalysisContext,
  detectCalculationIntent,
  extractNumericEvidence,
  runResearchCalculation,
  type NumericEvidenceSource,
} from "../../../core/tact-analysis";
import type { CalculationResult, CortexCalculationOutput } from "../../../core/tact-analysis/calculation/types";
import { assembleResearchContext } from "../../../core/tact-research/contextAssembly";
import { check, summarize, type CheckResult } from "../lib/check";

const annualRevenueEvidence: NumericEvidenceSource = {
  id: "ev-revenue",
  claim: "Annual revenue values",
  text: "2022年: 100億円\n2024年: 169億円",
};

function analysisOf(result: Awaited<ReturnType<typeof runResearchCalculation>>) {
  return result.analysis?.[0];
}

function isScalarOutput(
  output: CortexCalculationOutput | undefined,
): output is CalculationResult {
  if (!output || !("value" in output)) return false;
  return typeof output.value === "number";
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  results.push(check("[Intent1] explicit CAGR calculation", detectCalculationIntent("2022年から2024年のCAGRを計算して") === "cagr"));
  results.push(check("[Intent2] explicit growth/ranking/percentage calculation", detectCalculationIntent("成長率を出して") === "growth-rate" && detectCalculationIntent("売上順に並べて") === "ranking" && detectCalculationIntent("割合を計算して") === "percentage"));
  results.push(check("[Intent3] conceptual and ordinary research requests do not fire", detectCalculationIntent("CAGRとは何ですか？") === undefined && detectCalculationIntent("成長率について説明して") === undefined && detectCalculationIntent("日本の市場を調査して") === undefined));

  const extracted = extractNumericEvidence([annualRevenueEvidence, {
    id: "ev-percent", claim: "part and whole", text: "part: 25; whole: 100",
  }, {
    id: "ev-approx", claim: "approximate", text: "2022年: 約100億円",
  }]);
  results.push(check("[Extract1] exact year, JPY magnitude, and labelled values become NumericValue", extracted.temporal.length === 2 && extracted.temporal[0].value.value === 10000000000 && extracted.temporal[0].value.currency === "JPY" && extracted.temporal[0].value.period?.kind === "point" && extracted.labelled.length === 2));
  results.push(check("[Extract2] approximate numeric text is not used", extracted.temporal.every((item) => item.evidenceId !== "ev-approx") && extracted.warnings.some((issue) => issue.code === "AMBIGUOUS_NUMERIC_EXPRESSION")));

  const cagr = await runResearchCalculation("2022年から2024年のCAGRを計算して", [annualRevenueEvidence]);
  const cagrAnalysis = analysisOf(cagr);
  const cagrOutput = cagrAnalysis?.result?.output;
  results.push(check("[CAGR1] registry executes safely with derived annual periods", Boolean(cagrAnalysis?.status === "executed" && cagrAnalysis.result?.rule.id === "calculation.cagr" && isScalarOutput(cagrOutput) && Math.abs(cagrOutput.value - 0.3) < 0.0000001)));
  results.push(check("[CAGR2] provenance survives Evidence -> NumericValue -> AnalysisResult", Boolean(cagrAnalysis?.result?.sourceEvidenceIds.join(",") === "ev-revenue" && isScalarOutput(cagrOutput) && cagrOutput.sourceEvidenceIds.join(",") === "ev-revenue")));

  const growth = await runResearchCalculation("成長率を計算して", [{
    id: "ev-growth", claim: "annual revenue growth", text: "2022年: 100億円\n2023年: 130億円",
  }]);
  const growthOutput = analysisOf(growth)?.result?.output;
  results.push(check("[Growth1] exact chronological annual values execute growth-rate", Boolean(analysisOf(growth)?.status === "executed" && isScalarOutput(growthOutput) && growthOutput.formulaId === "growth-rate" && growthOutput.value === 0.3)));

  const growthInvalidPeriod = await runResearchCalculation("成長率を計算して", [{
    id: "ev-duplicate-period", claim: "duplicate annual values", text: "2022年: 100\n2022年: 130",
  }]);
  const growthMismatchedUnit = await runResearchCalculation("成長率を計算して", [{
    id: "ev-growth-unit-mismatch", claim: "mixed annual values", text: "2022年: 100億円\n2023年: 130%",
  }]);
  results.push(check("[Growth2] invalid periods and incompatible units skip without failure", Boolean(analysisOf(growthInvalidPeriod)?.status === "skipped" && growthInvalidPeriod.analysisWarnings?.some((issue) => issue.code === "INSUFFICIENT_DATA") && analysisOf(growthMismatchedUnit)?.status === "skipped" && growthMismatchedUnit.analysisWarnings?.some((issue) => issue.code === "NUMERIC_UNIT_MISMATCH"))));

  const percentage = await runResearchCalculation("割合を計算して", [{
    id: "ev-share", claim: "explicit share", text: "part: 25; whole: 100",
  }]);
  const percentageOutput = analysisOf(percentage)?.result?.output;
  results.push(check("[Percentage1] explicit part/whole executes", Boolean(analysisOf(percentage)?.status === "executed" && analysisOf(percentage)?.result?.rule.id === "calculation.percentage" && isScalarOutput(percentageOutput) && percentageOutput.value === 0.25)));
  const ambiguousPercentage = await runResearchCalculation("割合を計算して", [{ id: "ev-unrelated", claim: "A: 20, B: 100", text: "A: 20, B: 100" }]);
  const zeroWhole = await runResearchCalculation("割合を計算して", [{ id: "ev-zero", claim: "zero whole", text: "part: 25; whole: 0" }]);
  results.push(check("[Percentage2] ambiguous relation and zero whole skip safely", Boolean(analysisOf(ambiguousPercentage)?.status === "skipped" && analysisOf(zeroWhole)?.status === "skipped" && zeroWhole.analysisWarnings?.some((issue) => issue.code === "DIVISION_BY_ZERO"))));

  const rankingEvidence: NumericEvidenceSource = {
    id: "ev-ranking",
    claim: "Revenue by company",
    text: "Apple 売上: 100億円\nGoogle 売上: 250億円\nMicrosoft 売上: 180億円\nAmazon 売上: 180億円",
  };
  const ranking = await runResearchCalculation("売上順に並べて", [rankingEvidence]);
  const rankingOutput = analysisOf(ranking)?.result?.output;
  results.push(check("[Ranking1] comparable explicit metric uses dense ranking", Boolean(analysisOf(ranking)?.status === "executed" && rankingOutput && "rankings" in rankingOutput && rankingOutput.rankings.map((item) => `${item.id}:${item.rank}`).join(",") === "Google:1,Microsoft:2,Amazon:2,Apple:3")));
  const mismatchedRanking = await runResearchCalculation("売上順に並べて", [{ id: "ev-ranking-mismatch", claim: "mixed units", text: "Apple 売上: 100億円\nGoogle 売上: 90%" }]);
  const unclearRanking = await runResearchCalculation("売上順に並べて", [{ id: "ev-ranking-unclear", claim: "Apple: 100; Google: 90", text: "Apple: 100; Google: 90" }]);
  results.push(check("[Ranking2] mixed units and unclear metric skip", Boolean(analysisOf(mismatchedRanking)?.status === "skipped" && mismatchedRanking.analysisWarnings?.some((issue) => issue.code === "NUMERIC_UNIT_MISMATCH") && analysisOf(unclearRanking)?.status === "skipped")));

  const skipped = await runResearchCalculation("CAGRを計算して", [{ id: "ev-no-number", claim: "Market grew significantly", text: "Market grew significantly" }]);
  results.push(check("[Fallback1] no numeric evidence stays non-fatal and records a warning", Boolean(analysisOf(skipped)?.status === "skipped" && skipped.analysisWarnings?.some((issue) => issue.code === "INSUFFICIENT_DATA"))));

  const analysisContext = buildAnalysisContext(cagr.analysis);
  const skippedContext = buildAnalysisContext(skipped.analysis);
  results.push(check("[Context1] only successful deterministic results enter LLM context", analysisContext.includes("calculation.cagr@1") && analysisContext.includes("Do not recalculate") && !analysisContext.includes("169000") && skippedContext === ""));

  const assembled = assembleResearchContext({
    query: "2022年から2024年のCAGRを計算して",
    context: { knowledge: [], memories: [], examples: [], recentExecutions: [] },
    evidence: [],
    attachmentEvidence: [],
    requirements: [],
    analysis: cagr.analysis,
  });
  results.push(check("[Context2] canonical assembly receives analysis without a new LLM contract", Boolean(assembled.analysisContext?.includes("CALCULATED ANALYSIS") && assembled.systemPrompt.includes("Do not recalculate"))));

  return summarize("cortexResearchIntegration", results);
}

const directFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (directFile === import.meta.url) {
  run().then(({ fail }) => {
    if (fail > 0) process.exitCode = 1;
  });
}
