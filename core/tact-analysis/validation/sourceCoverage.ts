import type { Dataset, ValidationIssue } from "../types";
import { collectDatasetEvidenceIds } from "../data/dataset";

/** Validates provenance coverage without attempting semantic claim verification. */
export function validateSourceCoverage(dataset: Dataset): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (dataset.sourceEvidenceIds.length === 0) {
    issues.push({
      code: "SOURCE_COVERAGE_LOW",
      severity: "warning",
      message: "Dataset has no source evidence IDs",
      path: "sourceEvidenceIds",
    });
  }

  for (const [rowIndex, row] of dataset.rows.entries()) {
    if (row.sourceEvidenceIds.length === 0) {
      issues.push({
        code: "SOURCE_COVERAGE_LOW",
        severity: "warning",
        message: `Dataset row ${row.id} has no source evidence IDs`,
        path: `rows.${rowIndex}.sourceEvidenceIds`,
      });
    }

    for (const [columnId, value] of Object.entries(row.values)) {
      if (value.sourceEvidenceIds.length === 0) {
        issues.push({
          code: "SOURCE_COVERAGE_LOW",
          severity: "warning",
          message: `Dataset cell ${row.id}.${columnId} has no source evidence IDs`,
          path: `rows.${rowIndex}.values.${columnId}.sourceEvidenceIds`,
        });
      }
    }
  }

  if (collectDatasetEvidenceIds(dataset).length === 0 && dataset.rows.length > 0) {
    issues.push({
      code: "SOURCE_COVERAGE_LOW",
      severity: "error",
      message: "Dataset contains rows but no provenance at any level",
    });
  }

  return issues;
}
