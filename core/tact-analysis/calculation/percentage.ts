import type { CortexRule, ValidationIssue } from "../types";
import type { CalculationResult, PercentageCalculationInput } from "./types";
import { formatRatio, uniqueEvidenceIds, validateCompatibleValues, validatePrecision } from "./helpers";

export const percentageCalculationRule: CortexRule<PercentageCalculationInput, CalculationResult<"percentage">> = {
  id: "calculation.percentage",
  version: "1",
  category: "calculation",
  purpose: "Calculate an exact part-to-whole ratio without interpreting the operands.",
  execution: { deterministic: true, llmMode: "never" },
  requirements: [
    { id: "part", kind: "numeric", description: "The measured part", required: true, minimumCount: 1 },
    { id: "whole", kind: "numeric", description: "The corresponding whole", required: true, minimumCount: 1 },
  ],
  preconditions(input): ValidationIssue[] {
    const issues = [...validateCompatibleValues([input.part, input.whole]), ...validatePrecision(input.precision)];

    if (input.whole.value === 0) {
      issues.push({
        code: "DIVISION_BY_ZERO",
        severity: "error",
        message: "Percentage whole must not be zero",
        evidenceIds: uniqueEvidenceIds(input.part.sourceEvidenceIds, input.whole.sourceEvidenceIds),
      });
    }

    return issues;
  },
  execute(input) {
    const value = input.part.value / input.whole.value;
    return {
      formulaId: "percentage",
      formula: "part/whole",
      value,
      displayValue: formatRatio(value, input.precision),
      inputs: { part: input.part, whole: input.whole },
      sourceEvidenceIds: uniqueEvidenceIds(input.part.sourceEvidenceIds, input.whole.sourceEvidenceIds),
    };
  },
  validate(output) {
    return Number.isFinite(output.value)
      ? []
      : [{ code: "INVALID_NUMERIC_VALUE", severity: "error", message: "Percentage result must be finite" }];
  },
};
