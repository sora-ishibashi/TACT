import type { CalculationResult, RankingCalculationResult } from "../calculation/types";
import type { ResearchAnalysis } from "./types";

function isRankingResult(value: CalculationResult | RankingCalculationResult): value is RankingCalculationResult {
  return value.formulaId === "ranking";
}

function formatInput(value: unknown): string {
  if (value && typeof value === "object" && "raw" in value) {
    const numeric = value as { raw: unknown };
    return String(numeric.raw);
  }
  return String(value);
}

/** Emits only successful deterministic results; skipped and failed values are never presented as facts. */
export function buildAnalysisContext(analyses: readonly ResearchAnalysis[] | undefined): string {
  const successful = (analyses ?? []).filter(
    (analysis) => analysis.status === "executed" && analysis.result?.status === "success" && analysis.result.output
  );

  if (successful.length === 0) return "";

  const blocks = successful.map((analysis) => {
    const result = analysis.result!.output!;
    const header = `Rule: ${analysis.result!.rule.id}@${analysis.result!.rule.version}`;
    const evidence = `Evidence IDs: ${analysis.result!.sourceEvidenceIds.join(", ") || "(none supplied)"}`;

    if (isRankingResult(result)) {
      return `${header}\nResult: ${result.rankings.map((item) => `${item.id} #${item.rank}`).join(", ")}\n${evidence}`;
    }

    const inputs = Object.entries(result.inputs).map(([key, value]) => `${key}=${formatInput(value)}`).join(", ");
    return `${header}\nFormula: ${result.formula}\nResult: ${result.displayValue ?? String(result.value)}\nInputs: ${inputs}\n${evidence}`;
  });

  return `
========================
CALCULATED ANALYSIS (DETERMINISTIC)
========================
The following calculation results were produced by deterministic Cortex rules.
Do not recalculate, alter, round differently, or replace these numeric results.
Use them only to explain or interpret the supplied evidence, and preserve their evidence IDs.

${blocks.join("\n\n")}`.trim();
}
