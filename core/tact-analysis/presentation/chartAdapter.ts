import type { ChartBlock } from "../../tact-artifact/types";
import { collectDatasetEvidenceIds, validateDataset } from "../data/dataset";
import { normalizeNumber } from "../data/normalizeNumber";
import { normalizePeriod } from "../data/normalizePeriod";
import type { Dataset, DatasetValue, NumericValue, ValidationIssue } from "../types";
import { validateNumericConsistency } from "../validation/numericConsistency";
import { validateSourceCoverage } from "../validation/sourceCoverage";

export interface BarChartAdapterOptions {
  order: number;
  labelColumnId: string;
  valueColumnId: string;
  title?: string;
}

export interface LineChartAdapterOptions {
  order: number;
  periodColumnId: string;
  valueColumnId: string;
  title?: string;
}

export type ChartAdapterResult =
  | { ok: true; block: ChartBlock; warnings: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

function displayLabel(value: DatasetValue | undefined): string {
  if (!value || value.raw === null) {
    return "";
  }
  return String(value.raw);
}

function toNumericValue(value: DatasetValue, unit: string | undefined): NumericValue | undefined {
  if (typeof value.normalized === "number") {
    return {
      raw: String(value.raw ?? value.normalized),
      value: value.normalized,
      unit,
      currency: unit === "JPY" || unit === "USD" ? unit : undefined,
      sourceEvidenceIds: value.sourceEvidenceIds,
    };
  }

  if (typeof value.raw === "number") {
    return {
      raw: String(value.raw),
      value: value.raw,
      unit,
      currency: unit === "JPY" || unit === "USD" ? unit : undefined,
      sourceEvidenceIds: value.sourceEvidenceIds,
    };
  }

  if (typeof value.raw !== "string") {
    return undefined;
  }

  const parsed = normalizeNumber(value.raw);

  if (!parsed.ok) {
    return undefined;
  }

  return {
    ...parsed.value,
    unit: parsed.value.unit ?? unit,
    currency: parsed.value.currency ?? (unit === "JPY" || unit === "USD" ? unit : undefined),
    sourceEvidenceIds: value.sourceEvidenceIds,
  };
}

/**
 * Foundation v1 exposes only the Artifact renderer's current `bar` chart.
 * Invalid, non-numeric, or structurally unsupported input is rejected instead
 * of coercing a chart value.
 */
export function datasetToBarChartBlock(dataset: Dataset, options: BarChartAdapterOptions): ChartAdapterResult {
  const structuralIssues = validateDataset(dataset);
  const labelColumn = dataset.columns.find((column) => column.id === options.labelColumnId);
  const valueColumn = dataset.columns.find((column) => column.id === options.valueColumnId);

  if (!labelColumn || !valueColumn) {
    return {
      ok: false,
      issues: [
        ...structuralIssues,
        {
      code: "UNSUPPORTED_CHART_INPUT",
      severity: "error",
      message: "Chart label and value columns must exist in the dataset",
        },
      ],
    };
  }

  if (!["number", "percentage", "currency"].includes(valueColumn.type)) {
    structuralIssues.push({
      code: "UNSUPPORTED_CHART_INPUT",
      severity: "error",
      message: `Column ${valueColumn.id} is not a supported numeric chart column`,
      path: `columns.${valueColumn.id}`,
    });
  }

  if (structuralIssues.some((entry) => entry.severity === "error")) {
    return { ok: false, issues: structuralIssues };
  }

  const numericValues: NumericValue[] = [];
  const data: ChartBlock["data"] = [];
  const conversionIssues: ValidationIssue[] = [];

  for (const [rowIndex, row] of dataset.rows.entries()) {
    const numeric = toNumericValue(row.values[options.valueColumnId], valueColumn.unit);

    if (!numeric || !Number.isFinite(numeric.value)) {
      conversionIssues.push({
        code: "UNSUPPORTED_CHART_INPUT",
        severity: "error",
        message: `Row ${row.id} does not have a finite numeric value for ${valueColumn.id}`,
        evidenceIds: row.values[options.valueColumnId]?.sourceEvidenceIds,
        path: `rows.${rowIndex}.values.${valueColumn.id}`,
      });
      continue;
    }

    numericValues.push(numeric);
    data.push({ label: displayLabel(row.values[options.labelColumnId]), value: numeric.value });
  }

  const consistencyIssues = validateNumericConsistency({
    values: numericValues,
    expectedUnit: valueColumn.unit,
    path: `columns.${valueColumn.id}`,
  });
  const issues = [...conversionIssues, ...consistencyIssues];

  if (data.length === 0 || issues.some((entry) => entry.severity === "error")) {
    return {
      ok: false,
      issues: data.length === 0 && !issues.some((entry) => entry.severity === "error")
        ? [...issues, { code: "INSUFFICIENT_DATA", severity: "error", message: "A bar chart needs at least one numeric row" }]
        : issues,
    };
  }

  const now = new Date().toISOString();

  return {
    ok: true,
    warnings: validateSourceCoverage(dataset).filter((entry) => entry.severity !== "error"),
    block: {
      id: crypto.randomUUID(),
      type: "chart",
      title: options.title,
      chartType: "bar",
      data,
      sourceEvidenceIds: collectDatasetEvidenceIds(dataset),
      pointSourceEvidenceIds: dataset.rows.map((row) => [...(row.values[options.valueColumnId]?.sourceEvidenceIds ?? [])]),
      order: options.order,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** Converts one exact temporal numeric series into the existing ChartBlock contract. */
export function datasetToLineChartBlock(dataset: Dataset, options: LineChartAdapterOptions): ChartAdapterResult {
  const structuralIssues = validateDataset(dataset);
  const periodColumn = dataset.columns.find((column) => column.id === options.periodColumnId);
  const valueColumn = dataset.columns.find((column) => column.id === options.valueColumnId);

  if (!periodColumn || !valueColumn || !["number", "percentage", "currency"].includes(valueColumn.type)) {
    return {
      ok: false,
      issues: [
        ...structuralIssues,
        { code: "UNSUPPORTED_CHART_INPUT", severity: "error", message: "A line chart requires temporal and numeric dataset columns" },
      ],
    };
  }

  const rows = dataset.rows.map((row, rowIndex) => {
    const rawPeriod = row.values[options.periodColumnId]?.raw;
    const period = typeof rawPeriod === "string" ? rawPeriod : undefined;
    const numeric = row.values[options.valueColumnId]
      ? toNumericValue(row.values[options.valueColumnId], valueColumn.unit)
      : undefined;
    const normalizedPeriod = period ? normalizePeriod(period) : undefined;
    return { row, rowIndex, period, normalizedPeriod, numeric };
  });
  const issues: ValidationIssue[] = [];

  if (rows.some((item) => !item.normalizedPeriod?.ok || item.normalizedPeriod.value.kind !== "point")) {
    issues.push({ code: "INVALID_PERIOD", severity: "error", message: "Line chart rows require exact periods" });
  }
  if (rows.some((item) => !item.numeric || !Number.isFinite(item.numeric.value))) {
    issues.push({ code: "NON_NUMERIC_SERIES", severity: "error", message: "Line chart rows require finite numeric values" });
  }
  if (rows.length < 2) {
    issues.push({ code: "INSUFFICIENT_POINTS", severity: "error", message: "A line chart requires at least two points" });
  }

  const numericValues = rows.flatMap((item) => item.numeric ? [item.numeric] : []);
  issues.push(...validateNumericConsistency({ values: numericValues, expectedUnit: valueColumn.unit, allowDifferentPeriods: true, path: `columns.${valueColumn.id}` }));
  if (structuralIssues.some((issue) => issue.severity === "error") || issues.some((issue) => issue.severity === "error")) {
    return { ok: false, issues: [...structuralIssues, ...issues] };
  }

  const ordered = rows.filter((item): item is typeof item & { period: string; normalizedPeriod: { ok: true; value: { kind: "point"; start: string } }; numeric: NumericValue } =>
    Boolean(item.period && item.numeric && item.normalizedPeriod?.ok && item.normalizedPeriod.value.kind === "point")
  ).sort((left, right) => left.normalizedPeriod.value.start.localeCompare(right.normalizedPeriod.value.start));
  const distinctPeriods = new Set(ordered.map((item) => item.normalizedPeriod!.value.start));
  if (distinctPeriods.size !== ordered.length) {
    return { ok: false, issues: [{ code: "INVALID_PERIOD", severity: "error", message: "Line chart periods must be distinct" }] };
  }

  const now = new Date().toISOString();
  return {
    ok: true,
    warnings: validateSourceCoverage(dataset).filter((issue) => issue.severity !== "error"),
    block: {
      id: crypto.randomUUID(),
      type: "chart",
      title: options.title,
      chartType: "line",
      data: ordered.map((item) => ({ label: item.period!, value: item.numeric!.value })),
      sourceEvidenceIds: collectDatasetEvidenceIds(dataset),
      pointSourceEvidenceIds: ordered.map((item) => [...item.row.values[options.valueColumnId].sourceEvidenceIds]),
      order: options.order,
      createdAt: now,
      updatedAt: now,
    },
  };
}
