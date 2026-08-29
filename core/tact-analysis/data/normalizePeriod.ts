import type { TimePeriod, TimeGranularity } from "../types";

export type NormalizePeriodResult =
  | { ok: true; value: TimePeriod }
  | { ok: false; code: "INVALID_PERIOD" | "AMBIGUOUS_PERIOD"; message: string };

interface ParsedPoint {
  start: string;
  granularity: TimeGranularity;
}

function parsePoint(input: string): ParsedPoint | undefined {
  const yearMatch = input.match(/^(\d{4})(?:年)?$/);

  if (yearMatch) {
    return { start: `${yearMatch[1]}-01-01`, granularity: "year" };
  }

  const monthMatch = input.match(/^(\d{4})(?:-(\d{2})|年(\d{1,2})月)$/);

  if (!monthMatch) {
    return undefined;
  }

  const month = Number(monthMatch[2] ?? monthMatch[3]);

  if (month < 1 || month > 12) {
    return undefined;
  }

  return {
    start: `${monthMatch[1]}-${String(month).padStart(2, "0")}-01`,
    granularity: "month",
  };
}

/** Parses exact year/month points and explicit Japanese wave-dash ranges only. */
export function normalizePeriod(input: string): NormalizePeriodResult {
  const raw = input.trim();

  if (!raw) {
    return { ok: false, code: "INVALID_PERIOD", message: "Period input is empty" };
  }

  if (/今月|昨年|今年|来年|頃|以降|以前/.test(raw)) {
    return { ok: false, code: "AMBIGUOUS_PERIOD", message: `Period is not exact: ${raw}` };
  }

  const rangeParts = raw.split(/[〜～]/);

  if (rangeParts.length === 2) {
    const start = parsePoint(rangeParts[0].trim());
    const end = parsePoint(rangeParts[1].trim());

    if (!start || !end || start.granularity !== end.granularity || start.start > end.start) {
      return { ok: false, code: "INVALID_PERIOD", message: `Invalid period range: ${raw}` };
    }

    return {
      ok: true,
      value: {
        kind: "range",
        raw,
        start: start.start,
        end: end.start,
        granularity: start.granularity,
      },
    };
  }

  if (rangeParts.length > 2) {
    return { ok: false, code: "INVALID_PERIOD", message: `Invalid period range: ${raw}` };
  }

  const point = parsePoint(raw);

  if (!point) {
    return { ok: false, code: "INVALID_PERIOD", message: `Unsupported period: ${raw}` };
  }

  return { ok: true, value: { kind: "point", raw, ...point } };
}
