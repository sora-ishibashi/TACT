import type { CortexRule, ValidationIssue } from "../types";
import type { CalculationResult, GrowthRateCalculationInput } from "./types";
import {
  formatRatio,
  uniqueEvidenceIds,
  validateCompatibleValues,
  validatePeriodOrder,
  validatePrecision,
} from "./helpers";

export const growthRateCalculationRule: CortexRule<GrowthRateCalculationInput, CalculationResult<"growth-rate">> = {
  id: "calculation.growth-rate",
  version: "1",
  category: "calculation",
  purpose: "Calculate relative change between explicitly supplied start and end values.",
  execution: { deterministic: true, llmMode: "never" },
  requirements: [
    { id: "start", kind: "numeric", description: "Start value", required: true, minimumCount: 1 },
    { id: "end", kind: "numeric", description: "End value", required: true, minimumCount: 1 },
  ],
  preconditions(input): ValidationIssue[] {
    const issues = [
      ...validateCompatibleValues([input.start, input.end]),
      ...validatePeriodOrder(input.start, input.end),
      ...validatePrecision(input.precision),
    ];

    if (input.start.value === 0) {
      issues.push({
        code: "DIVISION_BY_ZERO",
        severity: "error",
        message: "Growth-rate start value must not be zero",
        evidenceIds: uniqueEvidenceIds(input.start.sourceEvidenceIds, input.end.sourceEvidenceIds),
      });
    }

    return issues;
  },
  execute(input) {
    const absoluteChange = input.end.value - input.start.value;
    const value = absoluteChange / input.start.value;

    return {
      formulaId: "growth-rate",
      formula: "(end-start)/start",
      value,
      displayValue: formatRatio(value, input.precision),
      inputs: { start: input.start, end: input.end },
      sourceEvidenceIds: uniqueEvidenceIds(input.start.sourceEvidenceIds, input.end.sourceEvidenceIds),
      metadata: { absoluteChange },
    };
  },
  validate(output) {
    return Number.isFinite(output.value)
      ? []
      : [{ code: "INVALID_NUMERIC_VALUE", severity: "error", message: "Growth-rate result must be finite" }];
  },
};
