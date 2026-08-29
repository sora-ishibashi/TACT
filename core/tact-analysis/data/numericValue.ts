import type { NumericValue } from "../types";

export type NormalizeNumberResult =
  | { ok: true; value: NumericValue }
  | { ok: false; code: "AMBIGUOUS_NUMERIC_EXPRESSION" | "INVALID_NUMERIC_VALUE"; message: string };

export function isFiniteNumericValue(value: NumericValue): boolean {
  return Number.isFinite(value.value);
}
