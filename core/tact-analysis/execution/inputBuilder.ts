import { buildCalculationInputFromDatasets } from "../data/datasetCalculation";
import { inspectPresentationDataset, evaluatePresentation } from "../presentation/evaluatePresentation";
import { datasetToBarChartBlock, datasetToLineChartBlock } from "../presentation/chartAdapter";
import { datasetToTableBlock } from "../presentation/tableAdapter";
import type { AnalysisPlanStep } from "../planner/types";
import type { Dataset, ValidationIssue } from "../types";
import type { CapabilityEvidenceDescriptor } from "../capability/types";

export type ExecutionInputBuildResult =
  | { ok: true; input: unknown; sourceEvidenceIds: string[] }
  | { ok: false; issues: ValidationIssue[] };

function sourceIds(dataset: Dataset): string[] { return [...new Set(dataset.sourceEvidenceIds)]; }
function issue(code: string, message: string): ExecutionInputBuildResult { return { ok: false, issues: [{ code, severity: "error", message }] }; }

/** Builds only existing typed inputs; it never fills absent entities, metrics, periods, units, or currencies. */
export function buildExecutionInput(step: AnalysisPlanStep, objective: string, datasets: readonly Dataset[], evidence: readonly CapabilityEvidenceDescriptor[], targetEntity?: string, explicitInputs?: Readonly<Record<string, unknown>>): ExecutionInputBuildResult {
  if (step.capabilityId.startsWith("calculation.")) {
    const explicit = explicitInputs?.[step.id];
    if (explicit !== undefined) return { ok: true, input: explicit, sourceEvidenceIds: [] };
    const intent = step.capabilityId.slice("calculation.".length) as "percentage" | "growth-rate" | "cagr" | "ranking";
    const built = buildCalculationInputFromDatasets(intent, datasets);
    return built.value ? { ok: true, input: built.value.input, sourceEvidenceIds: [...new Set(Object.values(built.value.input).flatMap((value) => typeof value === "object" && value && "sourceEvidenceIds" in value ? (value as { sourceEvidenceIds: string[] }).sourceEvidenceIds : []))] } : { ok: false, issues: built.warnings };
  }
  if (step.capabilityId.startsWith("framework.")) return { ok: true, input: { objective, targetEntity, evidence, datasets }, sourceEvidenceIds: evidence.map((item) => item.id) };
  if (!step.capabilityId.startsWith("presentation.")) return issue("UNSUPPORTED_CAPABILITY", `No typed execution builder exists for ${step.capabilityId}`);
  const type = step.capabilityId === "presentation.table" ? "table" : step.capabilityId === "presentation.bar" ? "bar-chart" : step.capabilityId === "presentation.line" ? "line-chart" : undefined;
  if (!type) return issue("UNSUPPORTED_CAPABILITY", `No presentation type exists for ${step.capabilityId}`);
  const candidates = datasets.map((dataset) => ({ dataset, evaluation: evaluatePresentation(dataset, type) })).filter((item) => item.evaluation.valid);
  if (candidates.length !== 1) return issue(candidates.length === 0 ? "PRESENTATION_INVALID_FOR_DATASET" : "PRESENTATION_AMBIGUOUS", candidates.length === 0 ? "No Dataset safely supports the planned presentation" : "Multiple Datasets match; execution will not guess");
  const dataset = candidates[0].dataset;
  const title = `${String(dataset.rows[0]?.values.metric?.raw ?? "Dataset")} ${type}`;
  const adapted = type === "table" ? datasetToTableBlock(dataset, { order: 0, title }) : type === "bar-chart" ? datasetToBarChartBlock(dataset, { order: 0, labelColumnId: inspectPresentationDataset(dataset).kind === "time-series" ? "period" : "entity", valueColumnId: "value", title }) : datasetToLineChartBlock(dataset, { order: 0, periodColumnId: "period", valueColumnId: "value", title });
  return adapted.ok ? { ok: true, input: { datasetId: dataset.id, type, block: adapted.block, warnings: adapted.warnings }, sourceEvidenceIds: sourceIds(dataset) } : { ok: false, issues: adapted.issues };
}
