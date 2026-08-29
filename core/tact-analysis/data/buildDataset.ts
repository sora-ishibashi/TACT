import type { ColumnDefinition, Dataset, DatasetRow, DatasetValue, NumericValue, ValidationIssue } from "../types";
import { validateNumericConsistency } from "../validation/numericConsistency";
import { validateSourceCoverage } from "../validation/sourceCoverage";
import { validateDataset } from "./dataset";
import { uniqueObservationEvidenceIds, type EvidenceObservation } from "./observation";

const DATASET_COLUMNS: readonly ColumnDefinition[] = [
  { id: "entity", label: "Entity", type: "string" },
  { id: "period", label: "Period", type: "date" },
  { id: "metric", label: "Metric", type: "string" },
  { id: "value", label: "Value", type: "number" },
];

export interface DatasetBuildResult {
  datasets: Dataset[];
  observations: EvidenceObservation[];
  warnings: ValidationIssue[];
}

function periodKey(observation: EvidenceObservation): string {
  const { period } = observation;
  return period.kind === "point"
    ? `${period.kind}:${period.start}:${period.granularity}`
    : `${period.kind}:${period.start}:${period.end}:${period.granularity}`;
}

function observationKey(observation: EvidenceObservation): string {
  return `${observation.entity}\u0000${observation.metric}\u0000${periodKey(observation)}`;
}

function compatibilityKey(observation: EvidenceObservation): string {
  return `${observation.metric}\u0000${observation.value.unit ?? ""}\u0000${observation.value.currency ?? ""}\u0000${observation.period.granularity}`;
}

function deterministicId(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}

function valuesEqual(left: NumericValue, right: NumericValue): boolean {
  return left.value === right.value && left.unit === right.unit && left.currency === right.currency;
}

function mergeMatchingObservations(observations: readonly EvidenceObservation[]): {
  observations: EvidenceObservation[];
  warnings: ValidationIssue[];
} {
  const groups = new Map<string, EvidenceObservation[]>();
  for (const observation of observations) {
    const key = observationKey(observation);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  const merged: EvidenceObservation[] = [];
  const warnings: ValidationIssue[] = [];

  for (const [key, group] of groups) {
    const first = group[0];
    const evidenceIds = uniqueObservationEvidenceIds(...group.map((item) => item.sourceEvidenceIds));
    const values = group.map((item) => item.value);
    const consistencyIssues = validateNumericConsistency({ values, allowDifferentPeriods: true, path: `observations.${key}` });
    const sameValue = group.every((item) => valuesEqual(first.value, item.value));

    const hardConsistencyFailure = consistencyIssues.some((issue) => issue.severity === "error");
    if (hardConsistencyFailure) {
      warnings.push(...consistencyIssues);
      continue;
    }

    if (!sameValue) {
      warnings.push({
        code: "CONFLICTING_OBSERVATION",
        severity: "error",
        message: `Conflicting observations for ${first.entity} / ${first.metric} / ${first.period.raw}`,
        evidenceIds,
        path: `observations.${key}`,
      });
      const units = new Set(values.map((value) => value.unit ?? "(unlabelled)"));
      const currencies = new Set(values.map((value) => value.currency ?? "(uncurried)"));
      if (units.size > 1) {
        warnings.push({
          code: "NUMERIC_UNIT_MISMATCH",
          severity: "warning",
          message: `Conflicting observations for ${key} use incompatible units`,
          evidenceIds,
        });
      }
      if (currencies.size > 1) {
        warnings.push({
          code: "NUMERIC_CURRENCY_MISMATCH",
          severity: "warning",
          message: `Conflicting observations for ${key} use incompatible currencies`,
          evidenceIds,
        });
      }
      continue;
    }

    merged.push({
      ...first,
      sourceEvidenceIds: evidenceIds,
      value: { ...first.value, sourceEvidenceIds: evidenceIds },
    });
  }

  return { observations: merged, warnings };
}

function incompatibleComparisonWarnings(observations: readonly EvidenceObservation[]): ValidationIssue[] {
  const groups = new Map<string, EvidenceObservation[]>();
  for (const observation of observations) {
    const key = `${observation.metric}\u0000${periodKey(observation)}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  const warnings: ValidationIssue[] = [];
  for (const [key, group] of groups) {
    const evidenceIds = uniqueObservationEvidenceIds(...group.map((item) => item.sourceEvidenceIds));
    const units = new Set(group.map((item) => item.value.unit ?? "(unlabelled)"));
    const currencies = new Set(group.map((item) => item.value.currency ?? "(uncurried)"));
    if (units.size > 1) {
      warnings.push({
        code: "NUMERIC_UNIT_MISMATCH",
        severity: "warning",
        message: `Observations for ${key} use incompatible units and were separated into distinct datasets`,
        evidenceIds,
      });
    }
    if (currencies.size > 1) {
      warnings.push({
        code: "NUMERIC_CURRENCY_MISMATCH",
        severity: "warning",
        message: `Observations for ${key} use incompatible currencies and were separated into distinct datasets`,
        evidenceIds,
      });
    }
  }
  return warnings;
}

function columnsFor(observation: EvidenceObservation): ColumnDefinition[] {
  return DATASET_COLUMNS.map((column) => column.id !== "value"
    ? { ...column }
    : {
        ...column,
        type: observation.value.currency ? "currency" : observation.value.unit === "%" ? "percentage" : "number",
        unit: observation.value.unit,
      });
}

function value(raw: string | number, normalized: string | number, sourceEvidenceIds: string[]): DatasetValue {
  return { raw, normalized, sourceEvidenceIds };
}

function toRow(observation: EvidenceObservation): DatasetRow {
  const sourceEvidenceIds = observation.sourceEvidenceIds;
  return {
    id: `row:${deterministicId(`${observation.entity}\u0000${observation.metric}\u0000${periodKey(observation)}`)}`,
    values: {
      entity: value(observation.entity, observation.entity, sourceEvidenceIds),
      period: value(observation.period.raw, observation.period.start, sourceEvidenceIds),
      metric: value(observation.metric, observation.metric, sourceEvidenceIds),
      value: value(observation.value.raw, observation.value.value, observation.value.sourceEvidenceIds),
    },
    sourceEvidenceIds,
  };
}

function compareObservations(left: EvidenceObservation, right: EvidenceObservation): number {
  return left.entity.localeCompare(right.entity) ||
    left.period.start.localeCompare(right.period.start) ||
    left.metric.localeCompare(right.metric);
}

/**
 * Builds one Dataset per exact metric/unit/currency/granularity combination.
 * Incompatible values are never mixed, converted, averaged, or silently selected.
 */
export function buildDatasets(observations: readonly EvidenceObservation[]): DatasetBuildResult {
  if (observations.length === 0) {
    return {
      datasets: [],
      observations: [],
      warnings: [{ code: "EMPTY_DATASET", severity: "warning", message: "No safe observations were available for dataset construction" }],
    };
  }

  const merged = mergeMatchingObservations(observations);
  const groups = new Map<string, EvidenceObservation[]>();
  for (const observation of merged.observations) {
    const key = compatibilityKey(observation);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  const datasets: Dataset[] = [];
  const warnings = [...merged.warnings, ...incompatibleComparisonWarnings(merged.observations)];

  for (const [key, group] of groups) {
    const sorted = [...group].sort(compareObservations);
    const sourceEvidenceIds = uniqueObservationEvidenceIds(...sorted.map((item) => item.sourceEvidenceIds));
    const dataset: Dataset = {
      id: `dataset:${deterministicId(key)}`,
      columns: columnsFor(sorted[0]),
      rows: sorted.map(toRow),
      sourceEvidenceIds,
    };
    warnings.push(...validateDataset(dataset), ...validateSourceCoverage(dataset));
    datasets.push(dataset);
  }

  return { datasets, observations: merged.observations, warnings };
}
