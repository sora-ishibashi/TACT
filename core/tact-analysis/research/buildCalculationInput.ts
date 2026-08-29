import type {
  CagrCalculationInput,
  GrowthRateCalculationInput,
  PercentageCalculationInput,
  RankingCalculationInput,
  RankingDirection,
} from "../calculation/types";
import type { ValidationIssue } from "../types";
import type { CalculationIntent } from "./types";
import type { NumericExtractionResult } from "./extractNumericEvidence";

export type CalculationRuleInput =
  | { intent: "percentage"; input: PercentageCalculationInput }
  | { intent: "growth-rate"; input: GrowthRateCalculationInput }
  | { intent: "cagr"; input: CagrCalculationInput }
  | { intent: "ranking"; input: RankingCalculationInput };

export interface CalculationInputBuildResult {
  value?: CalculationRuleInput;
  warnings: ValidationIssue[];
}

function insufficient(intent: CalculationIntent, message: string): CalculationInputBuildResult {
  return {
    warnings: [{ code: "INSUFFICIENT_DATA", severity: "warning", message: `${intent}: ${message}` }],
  };
}

function temporalPair(extracted: NumericExtractionResult) {
  const byEvidence = new Map<string, typeof extracted.temporal>();
  for (const reading of extracted.temporal) {
    const values = byEvidence.get(reading.evidenceId) ?? [];
    values.push(reading);
    byEvidence.set(reading.evidenceId, values);
  }

  for (const values of byEvidence.values()) {
    const sorted = [...values].sort((left, right) => left.value.period!.start.localeCompare(right.value.period!.start));
    const periods = new Set(sorted.map((reading) => reading.value.period!.start));
    if (sorted.length >= 2 && periods.size === sorted.length) {
      return { start: sorted[0].value, end: sorted.at(-1)!.value };
    }
  }

  return undefined;
}

function buildPercentage(extracted: NumericExtractionResult): CalculationInputBuildResult {
  const groups = new Map<string, typeof extracted.labelled>();
  for (const reading of extracted.labelled) {
    const values = groups.get(reading.evidenceId) ?? [];
    values.push(reading);
    groups.set(reading.evidenceId, values);
  }

  for (const values of groups.values()) {
    const part = values.find((reading) => ["part", "部分", "対象", "分子"].includes(reading.label));
    const whole = values.find((reading) => ["whole", "全体", "合計", "total", "分母"].includes(reading.label));
    if (part && whole) return { value: { intent: "percentage", input: { part: part.value, whole: whole.value } }, warnings: [] };
  }

  return insufficient("percentage", "requires explicit part and whole labels in the same evidence item");
}

function buildRanking(extracted: NumericExtractionResult, direction: RankingDirection): CalculationInputBuildResult {
  const groups = new Map<string, typeof extracted.ranking>();
  for (const reading of extracted.ranking) {
    const key = `${reading.evidenceId}\u0000${reading.metric}`;
    const values = groups.get(key) ?? [];
    values.push(reading);
    groups.set(key, values);
  }

  for (const values of groups.values()) {
    const ids = new Set(values.map((reading) => reading.itemLabel));
    if (values.length >= 2 && ids.size === values.length) {
      return {
        value: {
          intent: "ranking",
          input: {
            direction,
            items: values.map((reading) => ({ id: reading.itemLabel, value: reading.value })),
          },
        },
        warnings: [],
      };
    }
  }

  return insufficient("ranking", "requires at least two labelled values for the same explicit metric in one evidence item");
}

export function buildCalculationInput(
  intent: CalculationIntent,
  extracted: NumericExtractionResult,
  rankingDirection: RankingDirection = "descending"
): CalculationInputBuildResult {
  if (intent === "percentage") return buildPercentage(extracted);
  if (intent === "ranking") return buildRanking(extracted, rankingDirection);

  const pair = temporalPair(extracted);
  if (!pair) return insufficient(intent, "requires two exact year:value pairs in the same evidence item");

  return intent === "growth-rate"
    ? { value: { intent, input: { start: pair.start, end: pair.end } }, warnings: [] }
    : { value: { intent, input: { start: pair.start, end: pair.end } }, warnings: [] };
}
