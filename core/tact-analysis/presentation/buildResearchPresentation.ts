import { datasetToBarChartBlock, datasetToLineChartBlock } from "./chartAdapter";
import { datasetToTableBlock } from "./tableAdapter";
import { detectPresentationIntent, type PresentationIntent } from "./detectPresentationIntent";
import { evaluatePresentation, inspectPresentationDataset } from "./evaluatePresentation";
import type { Dataset, ValidationIssue } from "../types";
import type { PresentationBuildResult, PresentationRecommendation, PresentationType, ResearchPresentation } from "./types";

function priority(suitability: PresentationRecommendation["suitability"]): number {
  return { high: 3, medium: 2, low: 1, "not-recommended": 0 }[suitability];
}

function requestedTypes(intent: PresentationIntent): PresentationType[] {
  if (intent === "table") return ["table"];
  if (intent === "bar-chart") return ["bar-chart"];
  if (intent === "line-chart") return ["line-chart"];
  return ["line-chart", "bar-chart"];
}

function titleFor(dataset: Dataset, type: PresentationType): string {
  const metric = dataset.rows[0]?.values.metric?.raw;
  const unit = dataset.columns.find((column) => column.id === "value")?.unit;
  const label = `${String(metric ?? "Dataset")}${unit ? ` (${unit})` : ""}`;
  return `${label} ${type === "table" ? "Table" : type === "bar-chart" ? "Bar Chart" : "Line Chart"}`;
}

function buildBlock(dataset: Dataset, type: PresentationType): ReturnType<typeof datasetToTableBlock> | ReturnType<typeof datasetToBarChartBlock> {
  const title = titleFor(dataset, type);
  if (type === "table") return datasetToTableBlock(dataset, { order: 0, title });
  if (type === "bar-chart") {
    const labelColumnId = inspectPresentationDataset(dataset).kind === "time-series" ? "period" : "entity";
    return datasetToBarChartBlock(dataset, { order: 0, labelColumnId, valueColumnId: "value", title });
  }
  return datasetToLineChartBlock(dataset, { order: 0, periodColumnId: "period", valueColumnId: "value", title });
}

function candidatePresentations(datasets: readonly Dataset[], types: readonly PresentationType[]): Array<{
  dataset: Dataset;
  type: PresentationType;
  recommendation: PresentationRecommendation;
}> {
  return datasets.flatMap((dataset) => types.map((type) => ({ dataset, type, recommendation: evaluatePresentation(dataset, type) })));
}

/**
 * Selects at most one presentation. Explicit requests take precedence over
 * recommendation; an invalid explicit request is surfaced as a warning and is
 * never silently changed into another chart type.
 */
export function buildResearchPresentations(query: string, datasets: readonly Dataset[]): PresentationBuildResult {
  const intent = detectPresentationIntent(query);
  if (!intent) return { requested: false, presentations: [], warnings: [] };

  const candidates = candidatePresentations(datasets, requestedTypes(intent));
  const valid = candidates.filter((candidate) => candidate.recommendation.valid);
  if (valid.length === 0) {
    const issues = candidates.flatMap((candidate) => candidate.recommendation.issues);
    return {
      requested: true,
      presentations: [],
      warnings: issues.length > 0
        ? issues
        : [{ code: "PRESENTATION_INVALID_FOR_DATASET", severity: "warning", message: "No safe dataset can satisfy the requested presentation" }],
    };
  }

  let selected: typeof valid[number] | undefined;
  if (intent === "chart") {
    const bestPriority = Math.max(...valid.map((candidate) => priority(candidate.recommendation.suitability)));
    const best = valid.filter((candidate) => priority(candidate.recommendation.suitability) === bestPriority);
    if (best.length === 1) selected = best[0];
  } else if (valid.length === 1) {
    selected = valid[0];
  }

  if (!selected) {
    return {
      requested: true,
      presentations: [],
      warnings: [{ code: "PRESENTATION_AMBIGUOUS", severity: "warning", message: "Multiple datasets are eligible; presentation was not guessed" }],
    };
  }

  const adapted = buildBlock(selected.dataset, selected.type);
  if (!adapted.ok) {
    return { requested: true, presentations: [], warnings: adapted.issues };
  }

  const presentation: ResearchPresentation = {
    type: selected.type,
    datasetId: selected.dataset.id,
    recommendation: selected.recommendation,
    block: adapted.block,
  };
  return { requested: true, presentations: [presentation], warnings: adapted.warnings };
}

export function presentationWarnings(result: PresentationBuildResult): ValidationIssue[] {
  return result.warnings;
}
