// =========================
// TACT Canonical Execution — Permission Evaluator (SOR-51)
// =========================
//
// Canonical Execution → Permission Context Resolver → Permission Policy
// Resolver → Permission Evaluator → Permission Decision、というpipeline
// の最後のpure段階。DBアクセス・Provider呼び出しのいずれも行わない
// (../store.tsのcaptureExecution()と同じ「pure evaluation → 呼び出し元が
// 永続化する」という責務分離)。

import { findSuspiciousExecutionMetadataKeys } from "../validation";
import type { CanonicalExecution } from "../types";
import { resolvePermissionSubject } from "./resolveSubject";
import { resolvePermissionPolicy } from "./policy";
import { NO_MATCHING_POLICY_ID, type PermissionDecision } from "./types";

export const PERMISSION_EVALUATOR_VERSION = "permission-evaluator-v1";

const NO_POLICY_REASON_CODE = "no_matching_policy";

export function evaluatePermission(execution: CanonicalExecution): PermissionDecision {

  const subject = resolvePermissionSubject(execution);

  const rule = resolvePermissionPolicy(subject, execution);

  const evaluatedAt = new Date().toISOString();

  if (!rule) {

    // 絶対条件(Unknownの扱い、最重要): policy未検出はallowedへの
    // fallbackでもdeniedへの断定でもない。「観測価値のある不確実状態」
    // として残す。
    return {
      executionId: execution.id,
      status: "unknown",
      reasonCode: NO_POLICY_REASON_CODE,
      policyId: null,
      evaluatorVersion: PERMISSION_EVALUATOR_VERSION,
      evaluatedAt,
    };

  }

  return {
    executionId: execution.id,
    status: rule.decision,
    reasonCode: rule.reasonCode,
    policyId: rule.id,
    evaluatorVersion: PERMISSION_EVALUATOR_VERSION,
    evaluatedAt,
  };

}

export type ValidatePermissionDecisionResult = { ok: true } | { ok: false; errors: string[] };

const METADATA_MAX_SERIALIZED_LENGTH = 4_000;

// captureExecution()のvalidateCaptureExecutionInput()と同じ精神
// (巨大JSON dump禁止・suspicious key guard)を、永続化前に適用する。
export function validatePermissionDecision(decision: PermissionDecision): ValidatePermissionDecisionResult {

  const errors: string[] = [];

  if (decision.reasonCode.length < 1 || decision.reasonCode.length > 255) {
    errors.push("reasonCode must be between 1 and 255 characters");
  }

  const policyId = decision.policyId ?? NO_MATCHING_POLICY_ID;

  if (policyId.length < 1 || policyId.length > 255) {
    errors.push("policyId must be between 1 and 255 characters");
  }

  if (decision.evaluatorVersion.length < 1 || decision.evaluatorVersion.length > 100) {
    errors.push("evaluatorVersion must be between 1 and 100 characters");
  }

  if (decision.metadata !== null && decision.metadata !== undefined) {

    const suspiciousKeys = findSuspiciousExecutionMetadataKeys(decision.metadata);

    if (suspiciousKeys.length > 0) {
      errors.push(`metadata contains suspicious keys: ${suspiciousKeys.join(", ")}`);
    }

    if (JSON.stringify(decision.metadata).length > METADATA_MAX_SERIALIZED_LENGTH) {
      errors.push(`metadata must serialize to at most ${METADATA_MAX_SERIALIZED_LENGTH} characters`);
    }

  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };

}
