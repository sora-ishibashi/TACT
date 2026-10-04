// =========================
// TACT Canonical Execution — Outcome Validation (SOR-119)
// =========================
//
// AssertExecutionOutcomeInputを検証する、純粋関数のみのfile(DBアクセス
// 無し)。core/tact-execution/validation.tsと同じ規律(各moduleが自分の
// validation層を独立して持つ、cross-module importで密結合を作らない)。

import type { JsonValue } from "@tact/execution-contract";
import {
  EXECUTION_ACTOR_KINDS,
  type ExecutionActorKind,
} from "../types";
import {
  EXECUTION_OUTCOME_METHODS,
  EXECUTION_OUTCOME_STATUSES,
  type AssertExecutionOutcomeInput,
} from "./types";

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

// core/tact-execution/validation.tsのSUSPICIOUS_KEY_SUBSTRINGSと同じ
// 最小限guard(値の内容は見ず、key名だけを見る)。metadataは小さな
// 補足情報のみを想定するが、呼び出し元の作文ミスを検出する最後の防御層
// として同じcheckを行う。
const SUSPICIOUS_KEY_SUBSTRINGS: readonly string[] = [
  "token",
  "secret",
  "password",
  "credential",
  "apikey",
  "api_key",
  "authorization",
];

function isSuspiciousKeyName(key: string): boolean {
  const normalized = key.toLowerCase();
  return SUSPICIOUS_KEY_SUBSTRINGS.some((substring) => normalized.includes(substring));
}

function findSuspiciousMetadataKeys(value: JsonValue | null | undefined, path = "$"): string[] {

  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSuspiciousMetadataKeys(item, `${path}[${index}]`));
  }

  if (typeof value === "object") {

    const found: string[] = [];

    for (const key of Object.keys(value)) {

      const childPath = `${path}.${key}`;

      if (isSuspiciousKeyName(key)) {
        found.push(childPath);
      }

      found.push(...findSuspiciousMetadataKeys((value as Record<string, JsonValue>)[key], childPath));

    }

    return found;

  }

  return [];

}

export type ValidateAssertExecutionOutcomeInputResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateAssertExecutionOutcomeInput(
  input: AssertExecutionOutcomeInput
): ValidateAssertExecutionOutcomeInputResult {

  const errors: string[] = [];

  if (!isNonEmptyString(input.executionId, 255)) {
    errors.push("executionId is required");
  }

  if (!EXECUTION_OUTCOME_STATUSES.includes(input.status)) {
    errors.push(`status must be one of ${EXECUTION_OUTCOME_STATUSES.join(", ")}`);
  }

  // 絶対条件(Never Guess Rule): asserted状態には必ずoutcomeKindが
  // 伴い、unknown状態には決して伴わない。DB CHECK制約と同じ規律を
  // 呼び出し前に強制する。
  if (input.status === "asserted" && !isNonEmptyString(input.outcomeKind, 255)) {
    errors.push("outcomeKind is required when status is 'asserted'");
  }

  if (input.status === "unknown" && input.outcomeKind != null) {
    errors.push("outcomeKind must not be set when status is 'unknown' (never guess an outcome that could not be determined)");
  }

  if (!EXECUTION_OUTCOME_METHODS.includes(input.method)) {
    errors.push(`method must be one of ${EXECUTION_OUTCOME_METHODS.join(", ")}`);
  }

  if (input.summary != null && input.summary.length > 500) {
    errors.push("summary must be at most 500 characters");
  }

  if (input.reasonCode != null && !isNonEmptyString(input.reasonCode, 255)) {
    errors.push("reasonCode must be between 1 and 255 characters when provided");
  }

  if (
    input.assertedByActorKind != null &&
    !EXECUTION_ACTOR_KINDS.includes(input.assertedByActorKind as ExecutionActorKind)
  ) {
    errors.push(`assertedByActorKind must be one of ${EXECUTION_ACTOR_KINDS.join(", ")}`);
  }

  if (input.metadata !== null && input.metadata !== undefined) {

    const suspiciousKeys = findSuspiciousMetadataKeys(input.metadata);

    if (suspiciousKeys.length > 0) {
      errors.push(`metadata contains suspicious keys: ${suspiciousKeys.join(", ")}`);
    }

  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };

}
