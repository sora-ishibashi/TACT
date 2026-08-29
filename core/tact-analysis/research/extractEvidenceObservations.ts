import { normalizeNumber } from "../data/normalizeNumber";
import { normalizePeriod } from "../data/normalizePeriod";
import {
  normalizeObservationEntity,
  normalizeObservationMetric,
  uniqueObservationEvidenceIds,
  type EvidenceObservation,
} from "../data/observation";
import type { ValidationIssue } from "../types";
import type { NumericEvidenceSource } from "./types";

const NUMBER_TOKEN = "[¥￥]?[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:万|億|兆)?(?:円|JPY)?%?";
const PERIOD_TOKEN = "20\\d{2}(?:年|-(?:0[1-9]|1[0-2])|年(?:[1-9]|1[0-2])月)?";
// This deliberately small, explicit vocabulary is extraction syntax, not a metric equivalence dictionary.
const METRIC_TOKEN = "売上|売り上げ|revenue|sales|価格|price|数量|units";
const AMBIGUOUS_NUMBER = /(?:約|およそ|概ね|以上|以下|未満|最大|最小)\s*[¥￥]?\d/;

export interface ObservationExtractionResult {
  observations: EvidenceObservation[];
  warnings: ValidationIssue[];
}

function sourceText(source: NumericEvidenceSource): string {
  return source.text?.trim() || source.claim.trim();
}

function makeObservation(
  entityRaw: string,
  metricRaw: string,
  periodRaw: string,
  valueRaw: string,
  evidenceId: string,
): EvidenceObservation | undefined {
  const entity = normalizeObservationEntity(entityRaw);
  const metric = normalizeObservationMetric(metricRaw);
  const period = normalizePeriod(periodRaw);
  const numeric = normalizeNumber(valueRaw);

  if (!entity || !metric || !period.ok || !numeric.ok) return undefined;

  const sourceEvidenceIds = [evidenceId];
  return {
    entity,
    metric,
    period: period.value,
    value: { ...numeric.value, period: period.value, sourceEvidenceIds },
    sourceEvidenceIds,
  };
}

/**
 * Extracts only adjacent entity/metric/period/value facts from untrusted text.
 * It never follows instructions in evidence and never associates distant prose.
 */
export function extractEvidenceObservations(
  sources: readonly NumericEvidenceSource[],
): ObservationExtractionResult {
  const observations: EvidenceObservation[] = [];
  const warnings: ValidationIssue[] = [];

  const patterns = [
    new RegExp(`(?:^|[\\n;；])\\s*([^:：=\\n;；]{1,80}?)\\s+(${PERIOD_TOKEN})\\s+(${METRIC_TOKEN})\\s*(?::|：|=)\\s*(${NUMBER_TOKEN})`, "gi"),
    new RegExp(`(?:^|[\\n;；])\\s*([^:：=\\n;；]{1,80}?)\\s+(${METRIC_TOKEN})\\s+(${PERIOD_TOKEN})\\s*(?::|：|=)\\s*(${NUMBER_TOKEN})`, "gi"),
    new RegExp(`(?:^|[\\n;；])\\s*(${PERIOD_TOKEN})\\s+([^:：=\\n;；]{1,80}?)\\s+(${METRIC_TOKEN})\\s*(?::|：|=)\\s*(${NUMBER_TOKEN})`, "gi"),
  ] as const;

  for (const source of sources) {
    const text = sourceText(source);
    if (AMBIGUOUS_NUMBER.test(text)) {
      warnings.push({
        code: "AMBIGUOUS_NUMERIC_EXPRESSION",
        severity: "warning",
        message: "Approximate or bounded numeric evidence was not used for dataset extraction",
        evidenceIds: [source.id],
      });
    }

    for (const [patternIndex, pattern] of patterns.entries()) {
      for (const match of text.matchAll(pattern)) {
        const observation = patternIndex === 0
          ? makeObservation(match[1], match[3], match[2], match[4], source.id)
          : patternIndex === 1
            ? makeObservation(match[1], match[2], match[3], match[4], source.id)
            : makeObservation(match[2], match[3], match[1], match[4], source.id);

        if (observation) observations.push(observation);
      }
    }
  }

  // Repeated syntactic forms may observe the same fact; preserve it once with deterministic provenance.
  const unique = new Map<string, EvidenceObservation>();
  for (const observation of observations) {
    const key = `${observation.entity}\u0000${observation.metric}\u0000${observation.period.start}\u0000${observation.value.value}\u0000${observation.value.unit ?? ""}\u0000${observation.value.currency ?? ""}`;
    const existing = unique.get(key);
    unique.set(key, existing
      ? {
          ...existing,
          sourceEvidenceIds: uniqueObservationEvidenceIds(existing.sourceEvidenceIds, observation.sourceEvidenceIds),
          value: {
            ...existing.value,
            sourceEvidenceIds: uniqueObservationEvidenceIds(existing.value.sourceEvidenceIds, observation.value.sourceEvidenceIds),
          },
        }
      : observation);
  }

  return { observations: [...unique.values()], warnings };
}
