import type { NumericValue, TimePeriod, ValidationIssue } from "../types";
import { isFiniteNumericValue } from "../data/numericValue";

export interface NumericConsistencyInput {
  values: NumericValue[];
  expectedUnit?: string;
  expectedCurrency?: string;
  requirePeriod?: boolean;
  /** Growth/CAGR intentionally compare different points in time. */
  allowDifferentPeriods?: boolean;
  path?: string;
}

function periodKey(period: TimePeriod | undefined): string | undefined {
  if (!period) {
    return undefined;
  }
  return period.kind === "point"
    ? `${period.kind}:${period.start}:${period.granularity}`
    : `${period.kind}:${period.start}:${period.end}:${period.granularity}`;
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function validateNumericConsistency(input: NumericConsistencyInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const values = input.values;

  if (values.length === 0) {
    return [{ code: "INSUFFICIENT_DATA", severity: "error", message: "No numeric values were provided", path: input.path }];
  }

  const evidenceIds = values.flatMap((value) => value.sourceEvidenceIds);

  if (values.some((value) => !isFiniteNumericValue(value))) {
    issues.push({
      code: "INVALID_NUMERIC_VALUE",
      severity: "error",
      message: "Numeric values must be finite (not NaN or Infinity)",
      evidenceIds,
      path: input.path,
    });
  }

  const units = distinct(values.map((value) => value.unit));
  const currencies = distinct(values.map((value) => value.currency));
  const periods = distinct(values.map((value) => periodKey(value.period)));

  if (input.expectedUnit && values.some((value) => value.unit !== input.expectedUnit)) {
    issues.push({
      code: "NUMERIC_UNIT_MISMATCH",
      severity: "error",
      message: `All numeric values must use unit ${input.expectedUnit}`,
      evidenceIds,
      path: input.path,
    });
  } else if (units.length > 1) {
    issues.push({
      code: "NUMERIC_UNIT_MISMATCH",
      severity: "error",
      message: `Numeric values use incompatible units: ${units.join(", ")}`,
      evidenceIds,
      path: input.path,
    });
  }

  if (input.expectedCurrency && values.some((value) => value.currency !== input.expectedCurrency)) {
    issues.push({
      code: "NUMERIC_CURRENCY_MISMATCH",
      severity: "error",
      message: `All numeric values must use currency ${input.expectedCurrency}`,
      evidenceIds,
      path: input.path,
    });
  } else if (currencies.length > 1) {
    issues.push({
      code: "NUMERIC_CURRENCY_MISMATCH",
      severity: "error",
      message: `Numeric values use incompatible currencies: ${currencies.join(", ")}`,
      evidenceIds,
      path: input.path,
    });
  }

  if (input.requirePeriod && values.some((value) => !value.period)) {
    issues.push({
      code: "MISSING_PERIOD",
      severity: "warning",
      message: "Each numeric value needs a period for this operation",
      evidenceIds,
      path: input.path,
    });
  }

  if (!input.allowDifferentPeriods && periods.length > 1) {
    issues.push({
      code: "PERIOD_MISMATCH",
      severity: "warning",
      message: "Numeric values refer to different periods",
      evidenceIds,
      path: input.path,
    });
  }

  return issues;
}
