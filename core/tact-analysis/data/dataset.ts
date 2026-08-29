import type { Dataset, DatasetScalar, DatasetValue, ValidationIssue } from "../types";

const DATASET_COLUMN_TYPES = new Set(["string", "number", "date", "percentage", "currency", "boolean"]);

function isScalar(value: unknown): value is DatasetScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function hasStringIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim().length > 0);
}

export function isDatasetValue(value: unknown): value is DatasetValue {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<DatasetValue>;
  return isScalar(candidate.raw) &&
    (candidate.normalized === undefined || isScalar(candidate.normalized)) &&
    hasStringIds(candidate.sourceEvidenceIds);
}

export function isDataset(value: unknown): value is Dataset {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Dataset>;

  return typeof candidate.id === "string" &&
    Array.isArray(candidate.columns) &&
    candidate.columns.every((column) =>
      column && typeof column.id === "string" && typeof column.label === "string" && DATASET_COLUMN_TYPES.has(column.type)
    ) &&
    Array.isArray(candidate.rows) &&
    candidate.rows.every((row) =>
      row && typeof row.id === "string" &&
      row.values && typeof row.values === "object" &&
      hasStringIds(row.sourceEvidenceIds) &&
      Object.values(row.values).every(isDatasetValue)
    ) &&
    hasStringIds(candidate.sourceEvidenceIds);
}

export function validateDataset(dataset: Dataset): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const columnIds = new Set<string>();
  const rowIds = new Set<string>();

  for (const column of dataset.columns) {
    if (!column.id.trim() || !column.label.trim()) {
      issues.push({ code: "INVALID_DATASET_COLUMN", severity: "error", message: "Dataset columns require id and label" });
    }
    if (columnIds.has(column.id)) {
      issues.push({ code: "DUPLICATE_DATASET_COLUMN", severity: "error", message: `Duplicate dataset column: ${column.id}` });
    }
    columnIds.add(column.id);
  }

  for (const row of dataset.rows) {
    if (!row.id.trim() || rowIds.has(row.id)) {
      issues.push({ code: "INVALID_DATASET_ROW", severity: "error", message: `Invalid or duplicate dataset row: ${row.id}` });
    }
    rowIds.add(row.id);

    for (const valueColumnId of Object.keys(row.values)) {
      if (!columnIds.has(valueColumnId)) {
        issues.push({
          code: "UNKNOWN_DATASET_COLUMN",
          severity: "error",
          message: `Row ${row.id} has a value for unknown column ${valueColumnId}`,
          path: `rows.${row.id}.values.${valueColumnId}`,
        });
      }
    }
  }

  return issues;
}

/** Collects whole-dataset, row, and cell provenance without changing it. */
export function collectDatasetEvidenceIds(dataset: Dataset): string[] {
  const evidenceIds = new Set(dataset.sourceEvidenceIds);

  for (const row of dataset.rows) {
    for (const evidenceId of row.sourceEvidenceIds) {
      evidenceIds.add(evidenceId);
    }
    for (const value of Object.values(row.values)) {
      for (const evidenceId of value.sourceEvidenceIds) {
        evidenceIds.add(evidenceId);
      }
    }
  }

  return [...evidenceIds];
}
