import type { ValidationIssue } from "../types";

export interface EvidenceSupportInput {
  claim: string;
  requiredEvidenceIds: string[];
  availableEvidenceIds?: string[];
  path?: string;
}

/**
 * Foundation v1 verifies evidence identity and presence only. It deliberately
 * does not claim to determine semantic entailment from text.
 */
export function validateEvidenceSupport(input: EvidenceSupportInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const requiredIds = [...new Set(input.requiredEvidenceIds.filter(Boolean))];

  if (!input.claim.trim()) {
    issues.push({
      code: "UNSUPPORTED_CLAIM",
      severity: "error",
      message: "A supported claim must not be empty",
      path: input.path,
    });
  }

  if (requiredIds.length === 0) {
    issues.push({
      code: "UNSUPPORTED_CLAIM",
      severity: "error",
      message: "A claim requires at least one evidence ID",
      path: input.path,
    });
    return issues;
  }

  if (input.availableEvidenceIds) {
    const available = new Set(input.availableEvidenceIds);
    const missing = requiredIds.filter((id) => !available.has(id));

    if (missing.length > 0) {
      issues.push({
        code: "UNSUPPORTED_CLAIM",
        severity: "error",
        message: `Claim references evidence IDs not present in the available evidence: ${missing.join(", ")}`,
        evidenceIds: missing,
        path: input.path,
      });
    }
  }

  return issues;
}
