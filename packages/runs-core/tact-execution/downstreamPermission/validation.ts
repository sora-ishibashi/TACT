// =========================
// TACT Canonical Execution — Downstream Permission Evidence Validation (SOR-177 / SEC-8C)
// =========================
//
// ../validation.ts(validateCaptureExecutionInput)・../permission/evaluate.ts
// (validatePermissionDecision)・../governance/validation.tsと同じ精神の
// 純粋関数のみ(DBアクセス無し)。secret検出は既存の
// findSuspiciousExecutionMetadataKeys()をそのまま再利用し、独自実装しない
// (絶対条件、Human Owner section8 — guessed secret contentの検査はしない、
// 既存のkey名ベースのsuspicious-key policyのみを使う)。

import { findSuspiciousExecutionMetadataKeys } from "../validation";
import { EXECUTION_ACTION_CATEGORIES, EXECUTION_ACTOR_KINDS, EXECUTION_PROVIDERS } from "../types";
import {
  DOWNSTREAM_EVIDENCE_AUTHORITY_LEVELS,
  DOWNSTREAM_EVIDENCE_TRUST_LEVELS,
  DOWNSTREAM_PERMISSION_STATES,
  type DownstreamPermissionEvidenceInput,
} from "./types";

const HAS_EXPLICIT_TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;

function isValidTimestamp(value: string): boolean {
  return HAS_EXPLICIT_TIMEZONE_PATTERN.test(value) && !Number.isNaN(new Date(value).getTime());
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

// 4096 byte DB column check(migration参照、octet_length(...::text))に対して
// 余白を持たせる(../permission/evaluate.tsのMETADATA_MAX_SERIALIZED_LENGTH/
// ../governance/validation.tsの同じ4096 checkと同じ余白の取り方)。
//
// 絶対条件(repository既存規約との不一致の修正): DB側はoctet_length、つまり
// UTF-8 byte数で測る。JSON.stringify(...).lengthはUTF-16 code unit数であり、
// 日本語/CJK等のmultibyte文字を含むペイロードはcode unit数とbyte数が一致
// しない(例: 1つのCJK文字はJS .lengthでは1だが、UTF-8では3 byte)。
// この不一致により、application層のcheckをcode unit数で行うと、DB制約には
// 落ちる(=octet_length > 4096)はずのpayloadをapplication層が誤って
// 通してしまう場合がある——application boundaryとDB boundaryを一致させる
// ため、measureは必ずBuffer.byteLength(serialized, "utf8")(UTF-8 byte数)
// で行う。4000という閾値そのものは変更しない(4096 byte DB制約に対する
// 既存の安全margin)。
const EVIDENCE_SNAPSHOT_MAX_SERIALIZED_BYTES = 4_000;

export type ValidateDownstreamPermissionEvidenceInputResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateDownstreamPermissionEvidenceInput(
  input: DownstreamPermissionEvidenceInput
): ValidateDownstreamPermissionEvidenceInputResult {

  const errors: string[] = [];

  // 絶対条件(repository既存規約、../governance/validation.tsと同じ):
  // idのUUID形式そのものはDB側のuuid column typeが権威を持つ
  // (このrepositoryのどのvalidation.tsもUUID正規表現を独自実装していない
  // ——既存precedentに合わせる)。ここでは長さと非空のみを見る。
  if (!isNonEmptyString(input.id, 255)) {
    errors.push("id is required");
  }

  if (!isNonEmptyString(input.userId, 255)) {
    errors.push("userId is required");
  }

  if (!isNonEmptyString(input.executionId, 255)) {
    errors.push("executionId is required");
  }

  if (!EXECUTION_PROVIDERS.includes(input.targetProvider)) {
    errors.push(`targetProvider must be one of ${EXECUTION_PROVIDERS.join(", ")}`);
  }

  if (input.connectionId != null && !isNonEmptyString(input.connectionId, 255)) {
    errors.push("connectionId must be between 1 and 255 characters or null");
  }

  if (!EXECUTION_ACTOR_KINDS.includes(input.subjectKind)) {
    errors.push(`subjectKind must be one of ${EXECUTION_ACTOR_KINDS.join(", ")}`);
  }

  if (input.subjectId != null && !isNonEmptyString(input.subjectId, 255)) {
    errors.push("subjectId must be between 1 and 255 characters or null");
  }

  if (input.agentId != null && !isNonEmptyString(input.agentId, 255)) {
    errors.push("agentId must be between 1 and 255 characters or null");
  }

  if (!EXECUTION_ACTION_CATEGORIES.includes(input.actionCategory)) {
    errors.push(`actionCategory must be one of ${EXECUTION_ACTION_CATEGORIES.join(", ")}`);
  }

  if (!isNonEmptyString(input.operation, 255)) {
    errors.push("operation is required");
  }

  if (input.resourceType != null && !isNonEmptyString(input.resourceType, 255)) {
    errors.push("resourceType must be between 1 and 255 characters or null");
  }

  if (input.resourceIdentifier != null && !isNonEmptyString(input.resourceIdentifier, 500)) {
    errors.push("resourceIdentifier must be between 1 and 500 characters or null");
  }

  if (!DOWNSTREAM_PERMISSION_STATES.includes(input.permissionState)) {
    errors.push(`permissionState must be one of ${DOWNSTREAM_PERMISSION_STATES.join(", ")}`);
  }

  if (!isNonEmptyString(input.sourceType, 100)) {
    errors.push("sourceType is required (at most 100 characters)");
  }

  if (input.sourceIdentifier != null && !isNonEmptyString(input.sourceIdentifier, 500)) {
    errors.push("sourceIdentifier must be between 1 and 500 characters or null");
  }

  if (!DOWNSTREAM_EVIDENCE_AUTHORITY_LEVELS.includes(input.authorityLevel)) {
    errors.push(`authorityLevel must be one of ${DOWNSTREAM_EVIDENCE_AUTHORITY_LEVELS.join(", ")}`);
  }

  if (!DOWNSTREAM_EVIDENCE_TRUST_LEVELS.includes(input.trustLevel)) {
    errors.push(`trustLevel must be one of ${DOWNSTREAM_EVIDENCE_TRUST_LEVELS.join(", ")}`);
  }

  if (!isValidTimestamp(input.observedAt)) {
    errors.push("observedAt must be an ISO timestamp with an explicit timezone offset");
  }

  if (input.evidenceSnapshot !== null && input.evidenceSnapshot !== undefined) {

    const suspiciousKeys = findSuspiciousExecutionMetadataKeys(input.evidenceSnapshot);

    if (suspiciousKeys.length > 0) {
      errors.push(`evidenceSnapshot contains suspicious keys: ${suspiciousKeys.join(", ")}`);
    }

    const serializedBytes = Buffer.byteLength(JSON.stringify(input.evidenceSnapshot), "utf8");

    if (serializedBytes > EVIDENCE_SNAPSHOT_MAX_SERIALIZED_BYTES) {
      errors.push(`evidenceSnapshot must serialize to at most ${EVIDENCE_SNAPSHOT_MAX_SERIALIZED_BYTES} UTF-8 bytes`);
    }

  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };

}
