import type { CortexRule, ValidationIssue } from "../types";
import type { CagrCalculationInput, CalculationResult } from "./types";
import {
  deriveAnnualPeriodCount,
  formatRatio,
  uniqueEvidenceIds,
  validateCompatibleValues,
  validatePeriodOrder,
  validatePrecision,
} from "./helpers";

function resolvedPeriods(input: CagrCalculationInput): number | undefined {
  return input.periods ?? deriveAnnualPeriodCount(input.start.period, input.end.period);
}

export const cagrCalculationRule: CortexRule<CagrCalculationInput, CalculationResult<"cagr">> = {
  id: "calculation.cagr",
  version: "1",
  category: "calculation",
  purpose: "Calculate compound annual growth from explicit values and an explicit or exact annual period count.",
  execution: { deterministic: true, llmMode: "never" },
  requirements: [
    { id: "start", kind: "numeric", description: "Positive start value", required: true, minimumCount: 1 },
    { id: "end", kind: "numeric", description: "Non-negative end value", required: true, minimumCount: 1 },
    { id: "periods", kind: "temporal", description: "Positive explicit period count or exact annual point periods", required: true, minimumCount: 1 },
  ],
  preconditions(input): ValidationIssue[] {
    const issues = [
      ...validateCompatibleValues([input.start, input.end]),
      ...validatePeriodOrder(input.start, input.end),
      ...validatePrecision(input.precision),
    ];
    const periods = resolvedPeriods(input);
    const evidenceIds = uniqueEvidenceIds(input.start.sourceEvidenceIds, input.end.sourceEvidenceIds);

    if (input.start.value <= 0) {
      issues.push({ code: "UNSUPPORTED_NUMERIC_DOMAIN", severity: "error", message: "CAGR start value must be greater than zero", evidenceIds });
    }
    if (input.end.value < 0) {
      issues.push({ code: "UNSUPPORTED_NUMERIC_DOMAIN", severity: "error", message: "CAGR end value must not be negative", evidenceIds });
    }
    if (periods === undefined || !Number.isFinite(periods) || periods <= 0) {
      issues.push({ code: "INVALID_PERIOD_COUNT", severity: "error", message: "CAGR requires a positive period count", evidenceIds });
    }

    return issues;
  },
  execute(input) {
    const periods = resolvedPeriods(input);

    if (periods === undefined) {
      throw new Error("CAGR period count must satisfy preconditions");
    }

    const value = Math.pow(input.end.value / input.start.value, 1 / periods) - 1;

    return {
      formulaId: "cagr",
      formula: "(end/start)^(1/periods)-1",
      value,
      displayValue: formatRatio(value, input.precision),
      inputs: { startValue: input.start, endValue: input.end, periods },
      sourceEvidenceIds: uniqueEvidenceIds(input.start.sourceEvidenceIds, input.end.sourceEvidenceIds),
      metadata: { periodsSource: input.periods === undefined ? "derived-annual-points" : "explicit" },
    };
  },
  validate(output) {
    return Number.isFinite(output.value)
      ? []
      : [{ code: "INVALID_NUMERIC_VALUE", severity: "error", message: "CAGR result must be finite" }];
  },
};
