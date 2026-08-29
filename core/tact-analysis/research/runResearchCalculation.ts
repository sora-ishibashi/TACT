import { createDefaultCortexRegistry } from "../calculation/bootstrap";
import type { DatasetBuildResult } from "../data/buildDataset";
import { buildCalculationInputFromDatasets } from "../data/datasetCalculation";
import type {
  CagrCalculationInput,
  CalculationResult,
  GrowthRateCalculationInput,
  PercentageCalculationInput,
  RankingCalculationInput,
  RankingCalculationResult,
} from "../calculation/types";
import type { AnalysisResult, ValidationIssue } from "../types";
import { buildCalculationInput, type CalculationRuleInput } from "./buildCalculationInput";
import { detectCalculationIntent, detectRankingDirection } from "./detectCalculationIntent";
import { extractNumericEvidence } from "./extractNumericEvidence";
import { buildResearchDatasets } from "./buildResearchDataset";
import type { NumericEvidenceSource, ResearchAnalysis, ResearchCalculationRun } from "./types";

async function executeCalculation(
  input: CalculationRuleInput
): Promise<AnalysisResult<CalculationResult | RankingCalculationResult>> {
  const registry = createDefaultCortexRegistry();

  switch (input.intent) {
    case "percentage":
      return registry.execute<PercentageCalculationInput, CalculationResult<"percentage">>(
        "calculation.percentage",
        input.input
      );
    case "growth-rate":
      return registry.execute<GrowthRateCalculationInput, CalculationResult<"growth-rate">>(
        "calculation.growth-rate",
        input.input
      );
    case "cagr":
      return registry.execute<CagrCalculationInput, CalculationResult<"cagr">>(
        "calculation.cagr",
        input.input
      );
    case "ranking":
      return registry.execute<RankingCalculationInput, RankingCalculationResult>(
        "calculation.ranking",
        input.input
      );
  }
}

function skipped(intent: ResearchAnalysis["intent"], warnings: ValidationIssue[], datasets?: ResearchCalculationRun["datasets"]): ResearchCalculationRun {
  return { analysis: [{ intent, status: "skipped", warnings }], analysisWarnings: warnings, datasets };
}

/**
 * Canonical Research adapter. It is intentionally a one-shot, deterministic
 * calculation attempt: it never searches, asks an LLM to extract values, or
 * retries with different evidence.
 */
export async function runResearchCalculation(
  query: string,
  evidence: readonly NumericEvidenceSource[],
  existingDatasetBuild?: DatasetBuildResult,
): Promise<ResearchCalculationRun> {
  const intent = detectCalculationIntent(query);
  if (!intent) return {};

  try {
    const datasetBuild = existingDatasetBuild ?? buildResearchDatasets(evidence);
    const datasetInput = buildCalculationInputFromDatasets(intent, datasetBuild.datasets, detectRankingDirection(query));
    const extracted = extractNumericEvidence(evidence);
    // Preserve the Phase 2B same-evidence path when no structured observation
    // was available. Once an observation exists, conflict-safe Dataset selection
    // is authoritative and the older loose path must not bypass a conflict.
    const useDatasetInput = intent !== "percentage" && datasetBuild.observations.length > 0;
    const built = useDatasetInput
      ? datasetInput
      : buildCalculationInput(intent, extracted, detectRankingDirection(query));
    const initialWarnings = useDatasetInput
      ? [...datasetBuild.warnings, ...datasetInput.warnings]
      : [...extracted.warnings, ...built.warnings];

    if (!built.value) return skipped(intent, initialWarnings, datasetBuild.datasets);

    const result = await executeCalculation(built.value);
    const warnings = [...initialWarnings, ...result.warnings];

    if (result.status !== "success" || !result.output) {
      return {
        analysis: [{ intent, status: "skipped", result, warnings }],
        analysisWarnings: warnings,
        datasets: datasetBuild.datasets,
      };
    }

    return {
      analysis: [{ intent, status: "executed", result, warnings }],
      analysisWarnings: warnings.length > 0 ? warnings : undefined,
      datasets: datasetBuild.datasets,
    };
  } catch (error) {
    return skipped(intent, [{
      code: "CALCULATION_INTEGRATION_FAILED",
      severity: "warning",
      message: error instanceof Error ? error.message : "Calculation integration skipped after an unexpected error",
    }]);
  }
}
