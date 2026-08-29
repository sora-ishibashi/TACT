import type { CortexRule, NumericValue, ValidationIssue } from "../types";
import type { RankedItem, RankingCalculationInput, RankingCalculationResult, RankingItem } from "./types";
import { uniqueEvidenceIds, validateCompatibleValues } from "./helpers";

function rankingItemEvidenceIds(item: RankingItem): string[] {
  return uniqueEvidenceIds(item.sourceEvidenceIds, item.value?.sourceEvidenceIds);
}

function validValues(items: RankingItem[]): NumericValue[] {
  return items.flatMap((item) => item.value ? [item.value] : []);
}

export const rankingCalculationRule: CortexRule<RankingCalculationInput, RankingCalculationResult> = {
  id: "calculation.ranking",
  version: "1",
  category: "calculation",
  purpose: "Rank explicitly supplied numeric items with deterministic stable dense ranking.",
  execution: { deterministic: true, llmMode: "never" },
  requirements: [
    { id: "items", kind: "numeric", description: "At least one numeric item to rank", required: true, minimumCount: 1 },
  ],
  preconditions(input): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const ids = new Set<string>();

    if (input.direction !== "ascending" && input.direction !== "descending") {
      issues.push({ code: "INVALID_RANKING_DIRECTION", severity: "error", message: "Ranking direction must be ascending or descending" });
    }

    if (input.items.length === 0) {
      issues.push({ code: "INSUFFICIENT_DATA", severity: "error", message: "Ranking requires at least one item" });
    }

    for (const [index, item] of input.items.entries()) {
      if (!item.id.trim() || ids.has(item.id)) {
        issues.push({ code: "DUPLICATE_RANKING_ITEM_ID", severity: "error", message: `Ranking item ID must be unique: ${item.id}`, path: `items.${index}.id` });
      }
      ids.add(item.id);

      if (!item.value) {
        issues.push({
          code: "MISSING_NUMERIC_VALUE",
          severity: "error",
          message: `Ranking item ${item.id} has no numeric value`,
          evidenceIds: rankingItemEvidenceIds(item),
          path: `items.${index}.value`,
        });
      }
    }

    const values = validValues(input.items);

    if (values.length > 0) {
      issues.push(...validateCompatibleValues(values));
    }

    return issues;
  },
  execute(input) {
    const sorted = input.items
      .map((item, originalIndex) => ({ item, originalIndex, value: item.value as NumericValue }))
      .sort((left, right) => {
        const byValue = input.direction === "ascending"
          ? left.value.value - right.value.value
          : right.value.value - left.value.value;
        return byValue !== 0 ? byValue : left.originalIndex - right.originalIndex;
      });

    let rank = 0;
    let previousValue: number | undefined;
    const rankings: RankedItem[] = sorted.map(({ item, value }) => {
      if (previousValue === undefined || value.value !== previousValue) {
        rank += 1;
        previousValue = value.value;
      }
      return { id: item.id, rank, value, sourceEvidenceIds: rankingItemEvidenceIds(item) };
    });

    return {
      formulaId: "ranking",
      formula: "dense-ranking",
      inputs: Object.fromEntries(input.items.map((item) => [item.id, item.value ?? null])),
      sourceEvidenceIds: uniqueEvidenceIds(...input.items.map(rankingItemEvidenceIds)),
      metadata: { direction: input.direction, tieStrategy: "dense" },
      rankings,
    };
  },
  validate(output) {
    const issues: ValidationIssue[] = [];

    if (output.rankings.some((entry) => !Number.isInteger(entry.rank) || entry.rank < 1 || !Number.isFinite(entry.value.value))) {
      issues.push({ code: "INVALID_NUMERIC_VALUE", severity: "error", message: "Ranking output must contain finite values and positive integer ranks" });
    }

    return issues;
  },
};
