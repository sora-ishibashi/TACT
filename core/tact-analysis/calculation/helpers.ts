import type { NumericValue, TimePeriod, ValidationIssue } from "../types";
import { validateNumericConsistency } from "../validation/numericConsistency";

export function uniqueEvidenceIds(...groups: Array<readonly string[] | undefined>): string[] {
  const ids = new Set<string>();

  for (const group of groups) {
    for (const id of group ?? []) {
      if (id.trim()) {
        ids.add(id);
      }
    }
  }

  return [...ids];
}

export function formatRatio(value: number, precision = 1): string {
  const percentage = value * 100;
  const formatted = percentage.toFixed(precision).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return `${formatted}%`;
}

export function validatePrecision(precision: number | undefined): ValidationIssue[] {
  return precision === undefined || (Number.isInteger(precision) && precision >= 0 && precision <= 12)
    ? []
    : [{ code: "INVALID_PRECISION", severity: "error", message: "Precision must be an integer from 0 through 12" }];
}

/** Extends Foundation numeric checks by rejecting an unlabelled operand mixed with a labelled one. */
export function validateCompatibleValues(values: NumericValue[]): ValidationIssue[] {
  const issues = validateNumericConsistency({ values, allowDifferentPeriods: true });
  const evidenceIds = uniqueEvidenceIds(...values.map((value) => value.sourceEvidenceIds));
  const hasUnit = values.some((value) => value.unit !== undefined);
  const hasMissingUnit = values.some((value) => value.unit === undefined);
  const hasCurrency = values.some((value) => value.currency !== undefined);
  const hasMissingCurrency = values.some((value) => value.currency === undefined);

  if (hasUnit && hasMissingUnit) {
    issues.push({
      code: "NUMERIC_UNIT_MISMATCH",
      severity: "error",
      message: "Numeric operands cannot mix a unit-labelled value with an unlabelled value",
      evidenceIds,
    });
  }

  if (hasCurrency && hasMissingCurrency) {
    issues.push({
      code: "NUMERIC_CURRENCY_MISMATCH",
      severity: "error",
      message: "Numeric operands cannot mix a currency-labelled value with an unlabelled value",
      evidenceIds,
    });
  }

  return issues;
}

export function periodStart(period: TimePeriod | undefined): string | undefined {
  return period?.start;
}

export function validatePeriodOrder(start: NumericValue, end: NumericValue): ValidationIssue[] {
  const startPeriod = periodStart(start.period);
  const endPeriod = periodStart(end.period);

  if (startPeriod && endPeriod && endPeriod < startPeriod) {
    return [{
      code: "INVALID_PERIOD_ORDER",
      severity: "error",
      message: `End period ${endPeriod} occurs before start period ${startPeriod}`,
      evidenceIds: uniqueEvidenceIds(start.sourceEvidenceIds, end.sourceEvidenceIds),
    }];
  }

  return [];
}

/** Derives only exact annual point-to-point intervals; all other periods stay explicit. */
export function deriveAnnualPeriodCount(start: TimePeriod | undefined, end: TimePeriod | undefined): number | undefined {
  if (!start || !end || start.kind !== "point" || end.kind !== "point" ||
    start.granularity !== "year" || end.granularity !== "year") {
    return undefined;
  }

  const count = Number(end.start.slice(0, 4)) - Number(start.start.slice(0, 4));
  return Number.isInteger(count) && count > 0 ? count : undefined;
}
