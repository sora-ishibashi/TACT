import type { ResearchGap } from "../gap/types";

function compact(parts: readonly (string | undefined)[]): string | undefined {
  const query = parts.filter((part): part is string => Boolean(part?.trim())).join(" ").replace(/\s+/g, " ").trim();
  return query || undefined;
}

/**
 * Deterministic semantic query labels only. They are intentionally conservative and
 * never invent a missing year, competitor, metric, or provider-specific syntax.
 */
export function buildBoundedResearchQueries(gap: ResearchGap, objective: string): string[] {
  const period = gap.period?.start && gap.period?.end && gap.period.start !== gap.period.end
    ? `${gap.period.start} ${gap.period.end}`
    : gap.period?.start;
  switch (gap.kind) {
    case "numeric_value": return gap.targetEntity && gap.metric ? [compact([gap.targetEntity, gap.metric, period])!] : [];
    case "time_series": return gap.targetEntity && gap.metric ? [compact([gap.targetEntity, gap.metric, gap.period?.granularity])!] : [];
    case "evidence": return gap.targetEntity ? [compact([gap.targetEntity, objective])!] : [];
    case "comparison": return gap.targetEntity && gap.metric && period ? [compact([gap.targetEntity, gap.metric, period])!] : [];
    default: return [];
  }
}

export function normalizeResearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}
