import { normalizePeriod } from "../data/normalizePeriod";
import type { DatasetValue, TimeGranularity } from "../types";
import type { BuildResearchGapPlanInput, ResearchGapPeriod } from "./types";

function scalarString(value: DatasetValue | undefined): string | undefined {
  const candidate = value?.normalized ?? value?.raw;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}
function finiteValue(value: DatasetValue | undefined): boolean {
  const candidate = value?.normalized ?? value?.raw;
  return typeof candidate === "number" && Number.isFinite(candidate);
}
function only<T>(values: readonly T[]): T | undefined { return values.length === 1 ? values[0] : undefined; }
function unique(values: readonly string[]): string[] { return [...new Set(values.filter(Boolean))]; }

export interface GapDataContext {
  targetEntity?: string;
  metric?: string;
  period?: ResearchGapPeriod;
  unit?: string;
  currency?: string;
  numericCount: number;
  temporalPointCount: number;
  entityCount: number;
  metricCount: number;
}

/** Reads only exact Dataset values. It never resolves aliases or infers a missing period/metric. */
export function deriveGapDataContext(input: Pick<BuildResearchGapPlanInput, "targetEntity" | "datasets">): GapDataContext {
  const target = input.targetEntity?.trim();
  const rows = (input.datasets ?? []).flatMap((dataset) => dataset.rows.map((row) => ({ row, dataset })));
  const candidateRows = target
    ? rows.filter(({ row }) => scalarString(row.values.entity) === target)
    : rows;
  const entities = unique(candidateRows.map(({ row }) => scalarString(row.values.entity) ?? ""));
  const metrics = unique(candidateRows.map(({ row }) => scalarString(row.values.metric) ?? ""));
  const targetEntity = target ?? only(entities);
  const metric = only(metrics);
  const periodValues = candidateRows
    .map(({ row }) => scalarString(row.values.period))
    .map((raw) => raw ? normalizePeriod(raw) : undefined)
    .filter((result): result is NonNullable<typeof result> & { ok: true } => Boolean(result?.ok && result.value.kind === "point"));
  const starts = unique(periodValues.map((result) => result.value.start));
  const granularities = unique(periodValues.map((result) => result.value.granularity)) as TimeGranularity[];
  const period = only(starts) && only(granularities)
    ? { start: only(starts), granularity: only(granularities) }
    : only(granularities) ? { granularity: only(granularities) } : undefined;
  const units = unique(candidateRows.map(({ dataset }) => dataset.columns.find((column) => column.id === "value")?.unit ?? ""));
  const currencyColumns = candidateRows.map(({ dataset }) => dataset.columns.find((column) => column.id === "value")).filter((column): column is NonNullable<typeof column> => Boolean(column?.type === "currency"));
  const currencies = unique(currencyColumns.map((column) => column.unit ?? ""));
  return {
    targetEntity,
    metric,
    period,
    unit: only(units),
    currency: only(currencies),
    numericCount: candidateRows.filter(({ row }) => finiteValue(row.values.value)).length,
    temporalPointCount: starts.length,
    entityCount: entities.length,
    metricCount: metrics.length,
  };
}

export function finiteCount(requiredCount: number | undefined, currentCount: number | undefined): { requiredCount?: number; currentCount?: number; missingCount?: number } {
  const required = typeof requiredCount === "number" && Number.isFinite(requiredCount) && requiredCount >= 0 ? requiredCount : undefined;
  const current = typeof currentCount === "number" && Number.isFinite(currentCount) && currentCount >= 0 ? currentCount : undefined;
  if (required === undefined || current === undefined) return { requiredCount: required, currentCount: current };
  return { requiredCount: required, currentCount: current, missingCount: Math.max(required - current, 0) };
}
