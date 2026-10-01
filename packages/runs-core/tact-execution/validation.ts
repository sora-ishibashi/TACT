// =========================
// TACT Canonical Execution — Validation (SOR-50)
// =========================
//
// captureExecution()に渡される前のCaptureExecutionInputを検証する、
// 純粋関数のみのfile(DBアクセス無し)。core/tact-work/store.tsの
// isValidTimestampOrNull()と同じ「明示的timezone必須」判定、および
// core/tact-work/audit.tsのfindSuspiciousKeys()と同じkey名ベースの
// secret guardを、この新domain専用に(cross-module importで密結合を
// 作らないよう)独立して実装する——既存repositoryの規約通り、
// 各moduleが自分のstore/validation層を独立して持つ(createRequestScopedClient()
// が各store.tsへ個別に複製されているのと同じ設計判断)。

import type { JsonValue } from "@tact/execution-contract";
import {
  EXECUTION_ACTOR_KINDS,
  EXECUTION_ACTION_CATEGORIES,
  EXECUTION_OBSERVATION_MODES,
  EXECUTION_PERMISSION_STATUSES,
  EXECUTION_PROVIDERS,
  EXECUTION_SOURCE_TYPES,
  EXECUTION_STATUSES,
  type CaptureExecutionInput,
} from "./types";

const HAS_EXPLICIT_TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;

function isValidTimestamp(value: string): boolean {
  return HAS_EXPLICIT_TIMEZONE_PATTERN.test(value) && !Number.isNaN(new Date(value).getTime());
}

function isValidTimestampOrNull(value: string | null | undefined): boolean {

  if (value === null || value === undefined) {
    return true;
  }

  return isValidTimestamp(value);

}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

// core/tact-work/audit.tsのfindSuspiciousKeys()と同じ最小限guard
// (値の内容は見ず、key名だけを見る)。SOR-50のsource_metadataは
// Adapter層が構築する安全なmetadataのみを想定するが、呼び出し元の
// 作文ミスを検出する最後の防御層として、このvalidationでも同じ
// checkを行う。
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

export function findSuspiciousExecutionMetadataKeys(
  value: JsonValue | null | undefined,
  path = "$"
): string[] {

  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSuspiciousExecutionMetadataKeys(item, `${path}[${index}]`));
  }

  if (typeof value === "object") {

    const found: string[] = [];

    for (const key of Object.keys(value)) {

      const childPath = `${path}.${key}`;

      if (isSuspiciousKeyName(key)) {
        found.push(childPath);
      }

      found.push(
        ...findSuspiciousExecutionMetadataKeys((value as Record<string, JsonValue>)[key], childPath)
      );

    }

    return found;

  }

  return [];

}

export type ValidateCaptureExecutionInputResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateCaptureExecutionInput(
  input: CaptureExecutionInput
): ValidateCaptureExecutionInputResult {

  const errors: string[] = [];

  if (!isNonEmptyString(input.userId, 255)) {
    errors.push("userId is required");
  }

  if (!EXECUTION_ACTOR_KINDS.includes(input.actorKind)) {
    errors.push(`actorKind must be one of ${EXECUTION_ACTOR_KINDS.join(", ")}`);
  }

  if (input.onBehalfOfActorKind != null && !EXECUTION_ACTOR_KINDS.includes(input.onBehalfOfActorKind)) {
    errors.push(`onBehalfOfActorKind must be one of ${EXECUTION_ACTOR_KINDS.join(", ")}`);
  }

  if (!EXECUTION_PROVIDERS.includes(input.provider)) {
    errors.push(`provider must be one of ${EXECUTION_PROVIDERS.join(", ")}`);
  }

  if (input.targetProvider != null && !EXECUTION_PROVIDERS.includes(input.targetProvider)) {
    errors.push(`targetProvider must be one of ${EXECUTION_PROVIDERS.join(", ")}`);
  }

  if (!EXECUTION_SOURCE_TYPES.includes(input.sourceType)) {
    errors.push(`sourceType must be one of ${EXECUTION_SOURCE_TYPES.join(", ")}`);
  }

  if (!isNonEmptyString(input.externalEventId, 500)) {
    errors.push("externalEventId is required (adapter must synthesize a deterministic id when the provider does not supply one)");
  }

  if (!isNonEmptyString(input.adapterVersion, 100)) {
    errors.push("adapterVersion is required");
  }

  if (!EXECUTION_ACTION_CATEGORIES.includes(input.actionCategory)) {
    errors.push(`actionCategory must be one of ${EXECUTION_ACTION_CATEGORIES.join(", ")}`);
  }

  if (!isNonEmptyString(input.operation, 255)) {
    errors.push("operation is required");
  }

  if (input.status != null && !EXECUTION_STATUSES.includes(input.status)) {
    errors.push(`status must be one of ${EXECUTION_STATUSES.join(", ")}`);
  }

  if (input.permissionStatus != null && !EXECUTION_PERMISSION_STATUSES.includes(input.permissionStatus)) {
    errors.push(`permissionStatus must be one of ${EXECUTION_PERMISSION_STATUSES.join(", ")}`);
  }

  if (input.observationMode != null && !EXECUTION_OBSERVATION_MODES.includes(input.observationMode)) {
    errors.push(`observationMode must be one of ${EXECUTION_OBSERVATION_MODES.join(", ")}`);
  }

  if (!isValidTimestampOrNull(input.providerOccurredAt)) {
    errors.push("providerOccurredAt must be an ISO timestamp with an explicit timezone offset");
  }

  if (input.observedAt != null && !isValidTimestamp(input.observedAt)) {
    errors.push("observedAt must be an ISO timestamp with an explicit timezone offset");
  }

  if (input.errorMessage != null && input.errorMessage.length > 2000) {
    errors.push("errorMessage must be at most 2000 characters");
  }

  if (input.sourceMetadata !== null && input.sourceMetadata !== undefined) {

    const suspiciousKeys = findSuspiciousExecutionMetadataKeys(input.sourceMetadata);

    if (suspiciousKeys.length > 0) {
      errors.push(`sourceMetadata contains suspicious keys: ${suspiciousKeys.join(", ")}`);
    }

  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };

}
