import { normalizePeriod } from "../data/normalizePeriod";
import { validateDataset } from "../data/dataset";
import type { Dataset, DatasetValue, ValidationIssue } from "../types";
import type { PresentationDatasetShape, PresentationRecommendation, PresentationType } from "./types";

function stringValue(value: DatasetValue | undefined): string | undefined {
  const candidate = value?.normalized ?? value?.raw;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function numericValue(value: DatasetValue | undefined): number | undefined {
  const candidate = value?.normalized ?? value?.raw;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function baseInvalid(issues: ValidationIssue[]): PresentationRecommendation {
  return { valid: false, suitability: "not-recommended", reasons: ["Dataset does not satisfy this presentation's required shape"], issues };
}

export function inspectPresentationDataset(dataset: Dataset): PresentationDatasetShape {
  const issues = [...validateDataset(dataset)];
  const required = ["entity", "period", "metric", "value"];
  for (const id of required) {
    if (!dataset.columns.some((column) => column.id === id)) {
      issues.push({ code: "INVALID_DATASET_COLUMN", severity: "error", message: `Presentation requires ${id} column`, path: `columns.${id}` });
    }
  }
  if (dataset.rows.length === 0) {
    issues.push({ code: "EMPTY_DATASET", severity: "error", message: "Presentation requires a non-empty dataset" });
  }

  const entities = new Set<string>();
  const metrics = new Set<string>();
  const periods = new Set<string>();
  for (const [index, row] of dataset.rows.entries()) {
    const entity = stringValue(row.values.entity);
    const metric = stringValue(row.values.metric);
    const periodRaw = typeof row.values.period?.raw === "string" ? row.values.period.raw : undefined;
    const value = numericValue(row.values.value);
    if (!entity) issues.push({ code: "MISSING_VALUE", severity: "error", message: "Dataset row has no entity", path: `rows.${index}.values.entity` });
    else entities.add(entity);
    if (!metric) issues.push({ code: "MISSING_VALUE", severity: "error", message: "Dataset row has no metric", path: `rows.${index}.values.metric` });
    else metrics.add(metric);
    const period = periodRaw ? normalizePeriod(periodRaw) : undefined;
    if (!period?.ok || period.value.kind !== "point") issues.push({ code: "INVALID_PERIOD", severity: "error", message: "Dataset row has no exact point period", path: `rows.${index}.values.period` });
    else periods.add(period.value.start);
    if (value === undefined) issues.push({ code: "NON_NUMERIC_SERIES", severity: "error", message: "Dataset row has no finite numeric value", path: `rows.${index}.values.value` });
  }

  const periodCount = periods.size;
  const kind = entities.size === 1 && metrics.size === 1 && periodCount >= 2
    ? "time-series"
    : entities.size >= 2 && metrics.size === 1 && periodCount === 1
      ? "comparison"
      : "generic";
  return { dataset, kind, rowCount: dataset.rows.length, entityCount: entities.size, metricCount: metrics.size, periodCount, issues };
}

export function evaluatePresentation(dataset: Dataset, type: PresentationType): PresentationRecommendation {
  const shape = inspectPresentationDataset(dataset);
  const structuralErrors = shape.issues.filter((issue) => issue.severity === "error");

  if (type === "table") {
    return structuralErrors.some((issue) => issue.code === "INVALID_DATASET_COLUMN" || issue.code === "EMPTY_DATASET")
      ? baseInvalid(structuralErrors)
      : { valid: true, suitability: "high", reasons: ["Table preserves the verified Dataset rows and their provenance"], issues: shape.issues };
  }

  if (structuralErrors.length > 0) return baseInvalid(structuralErrors);

  if (type === "line-chart") {
    if (shape.kind !== "time-series") {
      return baseInvalid([{ code: "PRESENTATION_INVALID_FOR_DATASET", severity: "error", message: "Line charts require one entity, one metric, and multiple exact periods" }]);
    }
    return {
      valid: true,
      suitability: shape.rowCount >= 3 ? "high" : "medium",
      reasons: [shape.rowCount >= 3 ? "Three or more temporal points show a trend clearly" : "Two temporal points can be shown but establish only a minimal trend"],
      issues: [],
    };
  }

  if (shape.kind === "comparison") {
    return { valid: true, suitability: "high", reasons: ["One metric at one period supports direct entity comparison"], issues: [] };
  }
  if (shape.kind === "time-series") {
    return { valid: true, suitability: "medium", reasons: ["A short time series can be compared as bars, though a line is the stronger default"], issues: [] };
  }
  return baseInvalid([{ code: "PRESENTATION_INVALID_FOR_DATASET", severity: "error", message: "Bar charts require a single comparable metric and period, or one simple time series" }]);
}
