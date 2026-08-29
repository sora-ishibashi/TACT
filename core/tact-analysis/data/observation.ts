import type { NumericValue, TimePeriod } from "../types";

/**
 * One exact, machine-readable fact observed in untrusted evidence.
 * Entity and metric are intentionally exact/safely-normalized labels only;
 * this layer never performs semantic entity or metric resolution.
 */
export interface EvidenceObservation {
  entity: string;
  metric: string;
  value: NumericValue;
  period: TimePeriod;
  sourceEvidenceIds: string[];
}

/** Safe display-preserving normalization; it deliberately does not fuzzy-match names. */
export function normalizeObservationEntity(value: string): string | undefined {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

/** Safe label normalization. Japanese labels remain exact; ASCII case is normalized. */
export function normalizeObservationMetric(value: string): string | undefined {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return normalized ? normalized.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : undefined;
}

export function uniqueObservationEvidenceIds(...groups: Array<readonly string[] | undefined>): string[] {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const id of group ?? []) {
      if (id.trim()) ids.add(id);
    }
  }
  return [...ids];
}
