import { normalizeNumber } from "../data/normalizeNumber";
import { normalizePeriod } from "../data/normalizePeriod";
import type { NumericValue, ValidationIssue } from "../types";
import type { NumericEvidenceSource } from "./types";

const NUMBER_TOKEN = "[¥￥]?[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:万|億|兆)?(?:円|JPY)?%?";
const METRIC_TOKEN = "売上|売り上げ|revenue|sales|価格|price|数量|units";
const AMBIGUOUS_NUMBER = /(?:約|およそ|概ね|以上|以下|未満|最大|最小)\s*[¥￥]?\d/;

export interface TemporalNumericEvidence {
  evidenceId: string;
  value: NumericValue;
}

export interface LabelledNumericEvidence {
  evidenceId: string;
  label: string;
  value: NumericValue;
}

export interface RankingNumericEvidence {
  evidenceId: string;
  itemLabel: string;
  metric: string;
  value: NumericValue;
}

export interface NumericExtractionResult {
  temporal: TemporalNumericEvidence[];
  labelled: LabelledNumericEvidence[];
  ranking: RankingNumericEvidence[];
  warnings: ValidationIssue[];
}

function normalizeValue(raw: string, evidenceId: string): NumericValue | undefined {
  const normalized = normalizeNumber(raw);
  return normalized.ok ? { ...normalized.value, sourceEvidenceIds: [evidenceId] } : undefined;
}

function sourceText(source: NumericEvidenceSource): string {
  return source.text?.trim() || source.claim.trim();
}

function issueForAmbiguousNumber(source: NumericEvidenceSource): ValidationIssue | undefined {
  return AMBIGUOUS_NUMBER.test(sourceText(source))
    ? {
        code: "AMBIGUOUS_NUMERIC_EXPRESSION",
        severity: "warning",
        message: "Approximate or bounded numeric evidence was not used for calculation",
        evidenceIds: [source.id],
      }
    : undefined;
}

/**
 * Extracts only tight `label: value` associations. It does not associate
 * distant prose, infer a metric, or recover numbers from approximate language.
 */
export function extractNumericEvidence(sources: readonly NumericEvidenceSource[]): NumericExtractionResult {
  const result: NumericExtractionResult = { temporal: [], labelled: [], ranking: [], warnings: [] };

  for (const source of sources) {
    const text = sourceText(source);
    const ambiguity = issueForAmbiguousNumber(source);
    if (ambiguity) result.warnings.push(ambiguity);

    const temporalPattern = new RegExp(`(20\\d{2}(?:年)?)\\s*(?::|：|=)\\s*(${NUMBER_TOKEN})`, "g");
    for (const match of text.matchAll(temporalPattern)) {
      const period = normalizePeriod(match[1]);
      const value = normalizeValue(match[2], source.id);
      if (period.ok && value) {
        result.temporal.push({ evidenceId: source.id, value: { ...value, period: period.value } });
      }
    }

    const labelledPattern = new RegExp(`(?:^|[\\n;；、,])\\s*(part|部分|対象|分子|whole|全体|合計|total|分母)\\s*(?::|：|=)\\s*(${NUMBER_TOKEN})`, "gi");
    for (const match of text.matchAll(labelledPattern)) {
      const value = normalizeValue(match[2], source.id);
      if (value) result.labelled.push({ evidenceId: source.id, label: match[1].toLowerCase(), value });
    }

    const rankingPattern = new RegExp(`(?:^|[\\n;；])\\s*([^:：=\\n;；]{1,48}?)\\s*(?:の)?\\s*(${METRIC_TOKEN})\\s*(?::|：|=)\\s*(${NUMBER_TOKEN})`, "gi");
    for (const match of text.matchAll(rankingPattern)) {
      const itemLabel = match[1].trim();
      const value = normalizeValue(match[3], source.id);
      if (value && itemLabel && !/^20\\d{2}年?$/.test(itemLabel)) {
        result.ranking.push({
          evidenceId: source.id,
          itemLabel,
          metric: match[2].toLowerCase(),
          value,
        });
      }
    }
  }

  return result;
}
