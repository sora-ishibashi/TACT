import type { NumericValue } from "../types";
import type { NormalizeNumberResult } from "./numericValue";

const AMBIGUOUS_EXPRESSION = /約|およそ|概ね|以上|以下|未満|超|最大|最小|程度|ほぼ|[<>≦≧]/;
const JAPANESE_MAGNITUDE: Record<string, number> = {
  "万": 10_000,
  "億": 100_000_000,
  "兆": 1_000_000_000_000,
};

function decimalPrecision(value: string): number | undefined {
  const decimal = value.split(".")[1];
  return decimal === undefined ? undefined : decimal.length;
}

function invalid(
  code: "AMBIGUOUS_NUMERIC_EXPRESSION" | "INVALID_NUMERIC_VALUE",
  message: string
): NormalizeNumberResult {
  return { ok: false, code, message };
}

/**
 * Converts only unambiguous scalar number expressions. It intentionally rejects
 * approximations and inequality language rather than silently changing meaning.
 */
export function normalizeNumber(input: string): NormalizeNumberResult {
  const raw = input.trim();

  if (!raw) {
    return invalid("INVALID_NUMERIC_VALUE", "Numeric input is empty");
  }

  if (AMBIGUOUS_EXPRESSION.test(raw)) {
    return invalid("AMBIGUOUS_NUMERIC_EXPRESSION", `Numeric input is not exact: ${raw}`);
  }

  let candidate = raw.replace(/\s+/g, "");
  let currency: string | undefined;
  let unit: string | undefined;

  const hasYenPrefix = /^[¥￥]/.test(candidate);
  const hasYenSuffix = /(円|JPY)$/i.test(candidate);

  if (hasYenPrefix || hasYenSuffix) {
    currency = "JPY";
    unit = "JPY";
    candidate = candidate.replace(/^[¥￥]/, "").replace(/(円|JPY)$/i, "");
  }

  let percentage = false;

  if (candidate.endsWith("%")) {
    percentage = true;
    unit = "%";
    candidate = candidate.slice(0, -1);
  }

  if (!candidate || (percentage && currency)) {
    return invalid("INVALID_NUMERIC_VALUE", `Unsupported numeric expression: ${raw}`);
  }

  const match = candidate.match(/^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(万|億|兆)?$/);

  if (!match) {
    return invalid("INVALID_NUMERIC_VALUE", `Unsupported numeric expression: ${raw}`);
  }

  const numericPart = match[1].replace(/,/g, "");
  const baseValue = Number(numericPart);
  const magnitude = match[2] ? JAPANESE_MAGNITUDE[match[2]] : 1;
  const value = baseValue * magnitude;

  if (!Number.isFinite(value)) {
    return invalid("INVALID_NUMERIC_VALUE", `Numeric value is not finite: ${raw}`);
  }

  const normalized: NumericValue = {
    raw,
    value,
    sourceEvidenceIds: [],
  };

  if (unit) {
    normalized.unit = unit;
  }

  if (currency) {
    normalized.currency = currency;
  }

  const precision = decimalPrecision(numericPart);

  if (precision !== undefined) {
    normalized.precision = precision;
  }

  return { ok: true, value: normalized };
}
