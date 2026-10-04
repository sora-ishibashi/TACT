// =========================
// TACT Canonical Execution — Security Finding Validation (SOR-178 / SEC-8D)
// =========================
//
// Pure functions only (no DB access) — same convention as
// ../downstreamPermission/validation.ts / ../governance/validation.ts. This
// is a fail-fast guard before the store layer's INSERT; the DB CHECK
// constraints in migration 20270101000015 remain the authoritative schema
// enforcement.

import { EXECUTION_ACTION_CATEGORIES, EXECUTION_PROVIDERS } from "../types";
import {
  SECURITY_FINDING_ELIGIBILITY_BASES,
  SECURITY_FINDING_TYPES,
  type SecurityFindingInput,
} from "./types";

const HAS_EXPLICIT_TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;

function isValidTimestamp(value: string): boolean {
  return HAS_EXPLICIT_TIMEZONE_PATTERN.test(value) && !Number.isNaN(new Date(value).getTime());
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

export type ValidateSecurityFindingInputResult =
  | { ok: true }
  | { ok: false; errors: string[] };

// 絶対条件(section3): executionId/permissionDecisionId非null、
// downstreamPermissionEvidenceId/configuredUnknownRuleIdの各null制約は
// migration側のCHECK制約と同じ組み合わせをここでも先に検査する
// (application層とDB層の判定を一致させる、既存規約)。
export function validateSecurityFindingInput(
  input: SecurityFindingInput
): ValidateSecurityFindingInputResult {

  const errors: string[] = [];

  if (!isNonEmptyString(input.id, 255)) {
    errors.push("id is required");
  }

  if (!isNonEmptyString(input.userId, 255)) {
    errors.push("userId is required");
  }

  if (!isNonEmptyString(input.executionId, 255)) {
    errors.push("executionId is required");
  }

  if (!SECURITY_FINDING_TYPES.includes(input.findingType)) {
    errors.push(`findingType must be one of ${SECURITY_FINDING_TYPES.join(", ")}`);
  }

  if (!isNonEmptyString(input.reasonCode, 255)) {
    errors.push("reasonCode is required");
  }

  if (!SECURITY_FINDING_ELIGIBILITY_BASES.includes(input.eligibilityBasis)) {
    errors.push(`eligibilityBasis must be one of ${SECURITY_FINDING_ELIGIBILITY_BASES.join(", ")}`);
  }

  if (!isNonEmptyString(input.evaluatorVersion, 100)) {
    errors.push("evaluatorVersion is required");
  }

  if (!isValidTimestamp(input.detectedAt)) {
    errors.push("detectedAt must be an ISO timestamp with an explicit timezone offset");
  }

  if (!isNonEmptyString(input.permissionDecisionId, 255)) {
    errors.push("permissionDecisionId is required (section3: non-null for all current finding types)");
  }

  // section3/section8 absolute conditions: downstreamPermissionEvidenceId is
  // null for MISMATCH/UNKNOWN and required (non-null) for
  // DOWNSTREAM_PERMISSION_CONFLICT.
  if (input.findingType === "DOWNSTREAM_PERMISSION_CONFLICT") {

    if (!isNonEmptyString(input.downstreamPermissionEvidenceId, 255)) {
      errors.push("downstreamPermissionEvidenceId is required for DOWNSTREAM_PERMISSION_CONFLICT");
    }

  } else if (input.downstreamPermissionEvidenceId !== null) {

    errors.push(`downstreamPermissionEvidenceId must be null for ${input.findingType}`);

  }

  // section4/section8 absolute conditions: configuredUnknownRuleId is
  // required only for CONFIGURED_UNKNOWN and null for every other basis.
  if (input.eligibilityBasis === "CONFIGURED_UNKNOWN") {

    if (!isNonEmptyString(input.configuredUnknownRuleId, 255)) {
      errors.push("configuredUnknownRuleId is required when eligibilityBasis is CONFIGURED_UNKNOWN");
    }

  } else if (input.configuredUnknownRuleId !== null) {

    errors.push(`configuredUnknownRuleId must be null when eligibilityBasis is ${input.eligibilityBasis}`);

  }

  // Cross-field sanity (DOWNSTREAM_CONFLICT basis must accompany the
  // DOWNSTREAM_PERMISSION_CONFLICT finding type and vice versa — never
  // guess a basis/type combination that the DB CHECK would reject anyway).
  if (input.findingType === "DOWNSTREAM_PERMISSION_CONFLICT" && input.eligibilityBasis !== "DOWNSTREAM_CONFLICT") {
    errors.push("DOWNSTREAM_PERMISSION_CONFLICT must use eligibilityBasis=DOWNSTREAM_CONFLICT");
  }

  if (input.findingType === "RUNS_REGISTERED_PERMISSION_MISMATCH" && input.eligibilityBasis !== "DEFINITE_MISMATCH") {
    errors.push("RUNS_REGISTERED_PERMISSION_MISMATCH must use eligibilityBasis=DEFINITE_MISMATCH");
  }

  if (
    input.findingType === "RUNS_REGISTERED_PERMISSION_UNKNOWN" &&
    input.eligibilityBasis !== "HIGH_IMPACT_UNKNOWN" &&
    input.eligibilityBasis !== "CONFIGURED_UNKNOWN"
  ) {
    errors.push("RUNS_REGISTERED_PERMISSION_UNKNOWN must use eligibilityBasis=HIGH_IMPACT_UNKNOWN or CONFIGURED_UNKNOWN");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };

}

// re-exported so callers validating a CanonicalExecution-adjacent
// actionCategory/provider against this module's own enums do not need a
// second import path.
export { EXECUTION_ACTION_CATEGORIES, EXECUTION_PROVIDERS };
