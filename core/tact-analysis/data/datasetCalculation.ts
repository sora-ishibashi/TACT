import type {
  CagrCalculationInput,
  GrowthRateCalculationInput,
  RankingCalculationInput,
  RankingDirection,
} from "../calculation/types";
import type { CalculationIntent } from "../research/types";
import { normalizePeriod } from "./normalizePeriod";
import { uniqueObservationEvidenceIds } from "./observation";
import type { Dataset, NumericValue, ValidationIssue } from "../types";

export type DatasetCalculationInput =
  | { intent: "growth-rate"; input: GrowthRateCalculationInput }
  | { intent: "cagr"; input: CagrCalculationInput }
  | { intent: "ranking"; input: RankingCalculationInput };

export interface DatasetCalculationInputResult {
  value?: DatasetCalculationInput;
  warnings: ValidationIssue[];
}

interface DatasetReading {
  entity: string;
  metric: string;
  value: NumericValue;
}

function insufficient(intent: CalculationIntent, message: string): DatasetCalculationInputResult {
  return { warnings: [{ code: "INSUFFICIENT_DATA", severity: "warning", message: `${intent}: ${message}` }] };
}

function datasetValueColumn(dataset: Dataset) {
  return dataset.columns.find((column) => column.id === "value");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readDataset(dataset: Dataset): { readings: DatasetReading[]; warnings: ValidationIssue[] } {
  const valueColumn = datasetValueColumn(dataset);
  if (!valueColumn) {
    return { readings: [], warnings: [{ code: "INVALID_DATASET_COLUMN", severity: "error", message: "Dataset is missing value column", path: `datasets.${dataset.id}` }] };
  }

  const readings: DatasetReading[] = [];
  const warnings: ValidationIssue[] = [];
  for (const row of dataset.rows) {
    const entity = asString(row.values.entity?.normalized ?? row.values.entity?.raw);
    const metric = asString(row.values.metric?.normalized ?? row.values.metric?.raw);
    const periodRaw = asString(row.values.period?.raw);
    const numeric = row.values.value?.normalized;
    const period = periodRaw ? normalizePeriod(periodRaw) : undefined;

    if (!entity || !metric || typeof numeric !== "number" || !Number.isFinite(numeric) || !period?.ok) {
      warnings.push({ code: "INVALID_DATASET_ROW", severity: "warning", message: `Dataset row ${row.id} cannot safely become a calculation input`, path: `datasets.${dataset.id}.rows.${row.id}` });
      continue;
    }

    const sourceEvidenceIds = uniqueObservationEvidenceIds(row.sourceEvidenceIds, row.values.value.sourceEvidenceIds);
    readings.push({
      entity,
      metric,
      value: {
        raw: typeof row.values.value.raw === "string" ? row.values.value.raw : String(row.values.value.raw),
        value: numeric,
        unit: valueColumn.unit,
        currency: valueColumn.type === "currency" ? valueColumn.unit : undefined,
        period: period.value,
        sourceEvidenceIds,
      },
    });
  }
  return { readings, warnings };
}

function compatibilityKey(reading: DatasetReading): string {
  return `${reading.entity}\u0000${reading.metric}\u0000${reading.value.unit ?? ""}\u0000${reading.value.currency ?? ""}`;
}

function temporalInput(
  intent: "growth-rate" | "cagr",
  readings: DatasetReading[],
): DatasetCalculationInputResult {
  const groups = new Map<string, DatasetReading[]>();
  for (const reading of readings) {
    const group = groups.get(compatibilityKey(reading)) ?? [];
    group.push(reading);
    groups.set(compatibilityKey(reading), group);
  }
  const candidates = [...groups.values()].filter((group) => {
    const points = group.filter((item) => item.value.period?.kind === "point");
    return points.length >= 2 && new Set(points.map((item) => item.value.period!.start)).size === points.length;
  });

  if (candidates.length !== 1) {
    return insufficient(intent, candidates.length === 0
      ? "requires two compatible exact points for one entity and metric"
      : "has multiple compatible series; an entity/metric selector is required");
  }

  const sorted = [...candidates[0]].sort((left, right) => left.value.period!.start.localeCompare(right.value.period!.start));
  const start = sorted[0].value;
  const end = sorted.at(-1)!.value;
  return intent === "growth-rate"
    ? { value: { intent, input: { start, end } }, warnings: [] }
    : { value: { intent, input: { start, end } }, warnings: [] };
}

function rankingInput(readings: DatasetReading[], direction: RankingDirection): DatasetCalculationInputResult {
  const groups = new Map<string, DatasetReading[]>();
  for (const reading of readings) {
    const period = reading.value.period;
    const periodKey = period?.kind === "point" ? `${period.start}:${period.granularity}` : undefined;
    if (!periodKey) continue;
    const key = `${reading.metric}\u0000${reading.value.unit ?? ""}\u0000${reading.value.currency ?? ""}\u0000${periodKey}`;
    const group = groups.get(key) ?? [];
    group.push(reading);
    groups.set(key, group);
  }
  const candidates = [...groups.values()].filter((group) => group.length >= 2 && new Set(group.map((item) => item.entity)).size === group.length);

  if (candidates.length !== 1) {
    return insufficient("ranking", candidates.length === 0
      ? "requires two compatible entities for one exact metric and period"
      : "has multiple comparable groups; a metric/period selector is required");
  }

  return {
    value: {
      intent: "ranking",
      input: { direction, items: candidates[0].map((item) => ({ id: item.entity, value: item.value })) },
    },
    warnings: [],
  };
}

/** Reconstructs existing Calculation Rule inputs from a validated Dataset; it never implements formulas. */
export function buildCalculationInputFromDatasets(
  intent: CalculationIntent,
  datasets: readonly Dataset[],
  rankingDirection: RankingDirection = "descending",
): DatasetCalculationInputResult {
  if (intent === "percentage") return insufficient(intent, "percentage requires an explicit part/whole relation and is not inferred from datasets");

  const read = datasets.map(readDataset);
  const warnings = read.flatMap((item) => item.warnings);
  const readings = read.flatMap((item) => item.readings);
  const built = intent === "ranking"
    ? rankingInput(readings, rankingDirection)
    : temporalInput(intent, readings);

  return { value: built.value, warnings: [...warnings, ...built.warnings] };
}
