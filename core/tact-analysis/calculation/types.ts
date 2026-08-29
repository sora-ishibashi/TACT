import type { NumericValue } from "../types";

export type CalculationFormulaId = "percentage" | "growth-rate" | "cagr" | "ranking";

/** A scalar calculation keeps the exact raw result separate from its display string. */
export interface CalculationResult<Formula extends Exclude<CalculationFormulaId, "ranking"> = Exclude<CalculationFormulaId, "ranking">> {
  formulaId: Formula;
  formula: string;
  value: number;
  displayValue?: string;
  inputs: Record<string, NumericValue | number | string | null>;
  sourceEvidenceIds: string[];
  metadata?: Record<string, unknown>;
}

export interface PercentageCalculationInput {
  part: NumericValue;
  whole: NumericValue;
  precision?: number;
}

export interface GrowthRateCalculationInput {
  start: NumericValue;
  end: NumericValue;
  precision?: number;
}

export interface CagrCalculationInput {
  start: NumericValue;
  end: NumericValue;
  /** Optional only when two exact annual point periods safely determine the count. */
  periods?: number;
  precision?: number;
}

export type RankingDirection = "ascending" | "descending";

export interface RankingItem {
  id: string;
  value: NumericValue | null | undefined;
  sourceEvidenceIds?: string[];
}

export interface RankingCalculationInput {
  items: RankingItem[];
  direction: RankingDirection;
}

export interface RankedItem {
  id: string;
  rank: number;
  value: NumericValue;
  sourceEvidenceIds: string[];
}

/** Phase 2A deliberately uses dense ranking: 1, 2, 2, 3. */
export interface RankingCalculationResult {
  formulaId: "ranking";
  formula: "dense-ranking";
  inputs: Record<string, NumericValue | number | string | null>;
  sourceEvidenceIds: string[];
  metadata: {
    direction: RankingDirection;
    tieStrategy: "dense";
  };
  rankings: RankedItem[];
}

export type CortexCalculationOutput = CalculationResult | RankingCalculationResult;
