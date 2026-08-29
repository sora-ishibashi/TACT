import type { TableBlock } from "../../tact-artifact/types";
import { collectDatasetEvidenceIds, validateDataset } from "../data/dataset";
import type { Dataset, DatasetScalar, DatasetValue, ValidationIssue } from "../types";
import { validateSourceCoverage } from "../validation/sourceCoverage";

export interface TableAdapterOptions {
  order: number;
  title?: string;
}

export type TableAdapterResult =
  | { ok: true; block: TableBlock; warnings: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

function displayValue(value: DatasetValue | undefined): string {
  if (!value) {
    return "";
  }

  const display: DatasetScalar = value.raw;
  return display === null ? "" : String(display);
}

/** Converts a provenance-preserving semantic Dataset into the existing Artifact schema. */
export function datasetToTableBlock(dataset: Dataset, options: TableAdapterOptions): TableAdapterResult {
  const structuralIssues = validateDataset(dataset);

  if (structuralIssues.some((entry) => entry.severity === "error")) {
    return { ok: false, issues: structuralIssues };
  }

  const warnings = validateSourceCoverage(dataset);
  const now = new Date().toISOString();

  return {
    ok: true,
    warnings,
    block: {
      id: crypto.randomUUID(),
      type: "table",
      title: options.title,
      columns: dataset.columns.map((column) => column.label),
      rows: dataset.rows.map((row) => dataset.columns.map((column) => displayValue(row.values[column.id]))),
      sourceEvidenceIds: collectDatasetEvidenceIds(dataset),
      rowSourceEvidenceIds: dataset.rows.map((row) => [...row.sourceEvidenceIds]),
      cellSourceEvidenceIds: dataset.rows.map((row) =>
        dataset.columns.map((column) => row.values[column.id]?.sourceEvidenceIds)
      ),
      tablePurpose: "comparison",
      order: options.order,
      createdAt: now,
      updatedAt: now,
    },
  };
}
