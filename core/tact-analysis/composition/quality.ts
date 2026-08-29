import type { ArtifactBlock, TableBlock } from "../../tact-artifact/types";
import type { ValidationIssue } from "../types";
import type { AnalysisArtifactCandidate, ArtifactCandidateRole } from "./types";

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function warning(code: string, message: string): ValidationIssue { return { code, severity: "warning", message }; }

export type ExclusiveArtifactIntent =
  | "presentation.line"
  | "presentation.bar"
  | "presentation.table"
  | "presentation.any-chart"
  | "framework.swot"
  | "framework.3c"
  | "framework.pest"
  | "calculation.cagr"
  | "calculation.ranking";

const EXCLUSIVE_PATTERNS: ReadonlyArray<readonly [ExclusiveArtifactIntent, RegExp]> = [
  ["presentation.line", /(?:折れ線グラフ|line\s*chart)\s*(?:だけ|のみ|only\b)/i],
  ["presentation.bar", /(?:棒グラフ|bar\s*chart)\s*(?:だけ|のみ|only\b)/i],
  ["presentation.table", /(?:表|テーブル|table)\s*(?:だけ|のみ|only\b)/i],
  ["presentation.any-chart", /(?:グラフ|chart)\s*(?:だけ|のみ|only\b)/i],
  ["framework.swot", /swot\s*(?:だけ|のみ|only\b)/i],
  ["framework.3c", /3c\s*(?:だけ|のみ|only\b)/i],
  ["framework.pest", /pest\s*(?:だけ|のみ|only\b)/i],
  ["calculation.cagr", /cagr\s*(?:だけ|のみ|only\b)/i],
  ["calculation.ranking", /(?:ランキング|ranking|rank)\s*(?:だけ|のみ|only\b)/i],
];
const REQUEST_ACTION = /(?:にして|して|出して|表示|見せて|作って|作成|ください|お願い|only\b)/i;

/** Precision-first: a bare "Xだけ" or an explicit action may constrain display. */
export function detectExclusiveArtifactIntent(objective: string): ExclusiveArtifactIntent | undefined {
  const normalized = objective.trim();
  if (!normalized || /(?:とは|使い方|できますか|できるか|説明して|教えて)/.test(normalized) || /[?？]$/.test(normalized)) return undefined;
  for (const [intent, pattern] of EXCLUSIVE_PATTERNS) {
    if (!pattern.test(normalized)) continue;
    const compact = normalized.replace(/[。！？!?\s]/g, "");
    if (REQUEST_ACTION.test(normalized) || /(?:だけ|のみ|only)$/i.test(compact)) return intent;
  }
  return undefined;
}

function roleRank(role: ArtifactCandidateRole): number { return role === "primary" ? 0 : role === "supporting" ? 1 : 2; }
function isFramework(candidate: AnalysisArtifactCandidate): boolean { return candidate.capabilityIds.some((id) => id.startsWith("framework.")); }
function isPresentation(candidate: AnalysisArtifactCandidate): boolean { return candidate.capabilityIds.some((id) => id.startsWith("presentation.")); }

function matchesExclusive(candidate: AnalysisArtifactCandidate, intent: ExclusiveArtifactIntent): boolean {
  const ids = candidate.capabilityIds;
  if (intent === "presentation.any-chart") return ids.some((id) => id === "presentation.line" || id === "presentation.bar");
  return ids.includes(intent);
}

/** Content-only key: headings and runtime IDs must not defeat duplicate detection. */
export function structuralBlockSignature(block: ArtifactBlock): string {
  if (block.type === "table") return `table:${JSON.stringify(block.columns)}:${JSON.stringify(block.rows)}`;
  if (block.type === "chart") return `chart:${block.chartType}:${JSON.stringify(block.data)}`;
  if (block.type === "text" || block.type === "research_summary" || block.type === "finding" || block.type === "recommendation" || block.type === "hypothesis") return `${block.type}:${block.content}`;
  if (block.type === "evidence") return `evidence:${block.claim}:${block.source ?? ""}:${block.url ?? ""}`;
  return `example:${block.summary}:${JSON.stringify(block.fields ?? [])}`;
}

function mergeRows(left: readonly string[][] | undefined, right: readonly string[][] | undefined): string[][] | undefined {
  if (!left && !right) return undefined;
  const count = Math.max(left?.length ?? 0, right?.length ?? 0);
  return Array.from({ length: count }, (_, index) => unique([...(left?.[index] ?? []), ...(right?.[index] ?? [])]));
}
function mergeCells(left: TableBlock["cellSourceEvidenceIds"], right: TableBlock["cellSourceEvidenceIds"]): TableBlock["cellSourceEvidenceIds"] {
  if (!left && !right) return undefined;
  const rowCount = Math.max(left?.length ?? 0, right?.length ?? 0);
  return Array.from({ length: rowCount }, (_, row) => {
    const columnCount = Math.max(left?.[row]?.length ?? 0, right?.[row]?.length ?? 0);
    return Array.from({ length: columnCount }, (_, column) => {
      const ids = unique([...(left?.[row]?.[column] ?? []), ...(right?.[row]?.[column] ?? [])]);
      return ids.length ? ids : undefined;
    });
  });
}

/** Merges only explicit provenance fields; it never changes represented content. */
export function mergeArtifactBlockProvenance(left: ArtifactBlock, right: ArtifactBlock): ArtifactBlock {
  if (left.type === "table" && right.type === "table") {
    return {
      ...left,
      sourceEvidenceIds: unique([...(left.sourceEvidenceIds ?? []), ...(right.sourceEvidenceIds ?? [])]),
      rowSourceEvidenceIds: mergeRows(left.rowSourceEvidenceIds, right.rowSourceEvidenceIds),
      cellSourceEvidenceIds: mergeCells(left.cellSourceEvidenceIds, right.cellSourceEvidenceIds),
    };
  }
  if (left.type === "chart" && right.type === "chart") {
    const pointCount = Math.max(left.pointSourceEvidenceIds?.length ?? 0, right.pointSourceEvidenceIds?.length ?? 0);
    const pointSourceEvidenceIds = Array.from({ length: pointCount }, (_, index) => unique([...(left.pointSourceEvidenceIds?.[index] ?? []), ...(right.pointSourceEvidenceIds?.[index] ?? [])]));
    return {
      ...left,
      sourceEvidenceIds: unique([...(left.sourceEvidenceIds ?? []), ...(right.sourceEvidenceIds ?? [])]),
      ...(pointSourceEvidenceIds.length ? { pointSourceEvidenceIds } : {}),
    };
  }
  return left;
}

function containsAllRows(container: TableBlock, contained: TableBlock): boolean {
  if (JSON.stringify(container.columns) !== JSON.stringify(contained.columns) || container.rows.length <= contained.rows.length) return false;
  const rows = new Set(container.rows.map((row) => JSON.stringify(row)));
  return contained.rows.every((row) => rows.has(JSON.stringify(row)));
}

function suppressStrictlyContainedCalculations(candidates: readonly AnalysisArtifactCandidate[]): AnalysisArtifactCandidate[] {
  const merged = [...candidates];
  const suppressed = new Set<number>();
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const contained = candidate.block;
    if (candidate.role === "primary" || !candidate.capabilityIds.some((id) => id.startsWith("calculation.")) || contained.type !== "table") continue;
    const containerIndex = candidates.findIndex((container) => {
      if (container === candidate || container.block.type !== "table") return false;
      return !container.capabilityIds.some((id) => id.startsWith("calculation."))
        && roleRank(container.role) <= roleRank(candidate.role)
        && containsAllRows(container.block, contained);
    });
    if (containerIndex < 0) continue;
    const container = merged[containerIndex]!;
    merged[containerIndex] = {
      ...container,
      block: mergeArtifactBlockProvenance(container.block, candidate.block),
      sourceStepIds: unique([...container.sourceStepIds, ...candidate.sourceStepIds]),
      capabilityIds: unique([...container.capabilityIds, ...candidate.capabilityIds]),
      explicitRequest: container.explicitRequest || candidate.explicitRequest,
    };
    suppressed.add(candidateIndex);
  }
  return merged.filter((_, index) => !suppressed.has(index));
}

function selectPrimary(candidates: readonly AnalysisArtifactCandidate[]): number | undefined {
  const explicit = candidates.map((candidate, index) => ({ candidate, index })).filter((item) => item.candidate.explicitRequest);
  const pool = explicit.length ? explicit : candidates.map((candidate, index) => ({ candidate, index }));
  if (!pool.length) return undefined;
  const explicitFramework = explicit.find((item) => isFramework(item.candidate));
  if (explicitFramework) return explicitFramework.index;
  const explicitPresentation = explicit.find((item) => isPresentation(item.candidate));
  if (explicitPresentation) return explicitPresentation.index;
  return pool[0]?.index;
}

function assignRoles(candidates: readonly AnalysisArtifactCandidate[]): AnalysisArtifactCandidate[] {
  const primary = selectPrimary(candidates);
  return candidates.map((candidate, index) => ({
    ...candidate,
    role: index === primary ? "primary" : candidate.explicitRequest ? "supporting" : "detail",
  }));
}

export interface ArtifactCompositionQualityResult {
  candidates: readonly AnalysisArtifactCandidate[];
  warnings: readonly ValidationIssue[];
}

/**
 * Deterministic display refinement only. No Rule, Search, LLM, or persistence
 * call occurs here. On an internal error, the original validated candidates
 * survive in stable order.
 */
export function applyArtifactCompositionQuality(
  objective: string,
  candidates: readonly AnalysisArtifactCandidate[],
): ArtifactCompositionQualityResult {
  try {
    const exclusive = detectExclusiveArtifactIntent(objective);
    const visible = exclusive ? candidates.filter((candidate) => matchesExclusive(candidate, exclusive)) : [...candidates];
    const assigned = assignRoles(visible);
    const ordered = assigned.map((candidate, index) => ({ candidate, index })).sort((left, right) =>
      roleRank(left.candidate.role) - roleRank(right.candidate.role)
      || left.candidate.planStepOrder - right.candidate.planStepOrder
      || left.candidate.capabilityIds.join(",").localeCompare(right.candidate.capabilityIds.join(","))
      || left.index - right.index,
    ).map((item) => item.candidate);
    const deduped: AnalysisArtifactCandidate[] = [];
    const bySignature = new Map<string, number>();
    for (const candidate of ordered) {
      const key = structuralBlockSignature(candidate.block);
      const existingIndex = bySignature.get(key);
      if (existingIndex === undefined) {
        bySignature.set(key, deduped.length);
        deduped.push(candidate);
        continue;
      }
      const existing = deduped[existingIndex]!;
      deduped[existingIndex] = {
        ...existing,
        block: mergeArtifactBlockProvenance(existing.block, candidate.block),
        sourceStepIds: unique([...existing.sourceStepIds, ...candidate.sourceStepIds]),
        capabilityIds: unique([...existing.capabilityIds, ...candidate.capabilityIds]),
        explicitRequest: existing.explicitRequest || candidate.explicitRequest,
      };
    }
    const suppressed = suppressStrictlyContainedCalculations(deduped);
    const warnings = [
      ...Array.from({ length: Math.max(0, ordered.length - deduped.length) }, () => warning("COMPOSITION_DUPLICATE_BLOCK", "A structurally duplicate Artifact block was merged")),
      ...Array.from({ length: Math.max(0, deduped.length - suppressed.length) }, () => warning("COMPOSITION_REDUNDANT_BLOCK", "A supporting calculation was already structurally contained in a displayed table")),
    ];
    return { candidates: suppressed, warnings };
  } catch (error) {
    return {
      candidates: assignRoles(candidates),
      warnings: [warning("COMPOSITION_QUALITY_FAILED", error instanceof Error ? error.message : "Artifact quality refinement was skipped")],
    };
  }
}
