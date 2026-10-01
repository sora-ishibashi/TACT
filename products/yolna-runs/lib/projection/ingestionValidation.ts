// =========================
// Yolna Runs Standalone — Projection Ingestion Payload Validation (SOR-135 Phase 4A)
// =========================
//
// Hand-rolled (no new runtime dependency added to the standalone app's
// already-minimal package.json) shape validation for the two ingestion
// payloads. Deliberately allowlist-extraction, not a spread of the parsed
// body: each function reads only the named fields it returns, so any
// extra/unexpected JSON property in the request body can never reach the
// database regardless of what an attacker (or a buggy caller) includes —
// this is the "credential/body minimization" requirement, enforced by
// construction rather than by a reject-unknown-keys check.
//
// Bounds (MAX_STRING_LENGTH) exist only to reject grossly oversized
// payloads early, not as a business-rule validation — Postgres/column
// constraints remain the real source of truth for valid values.

import type {
  WorkProjectionUpsertInput,
  ConversationLinkProjectionUpsertInput,
} from "@tact/execution-contract";

const MAX_STRING_LENGTH = 2048;

export interface ValidationFailure {
  field: string;
  reason: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors?: ValidationFailure[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING_LENGTH;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

export function validateWorkProjectionUpsertInput(body: unknown): ValidationResult<WorkProjectionUpsertInput> {

  if (typeof body !== "object" || body === null) {
    return { ok: false, errors: [{ field: "(body)", reason: "must be a JSON object" }] };
  }

  const record = body as Record<string, unknown>;
  const errors: ValidationFailure[] = [];

  if (!isNonEmptyString(record.externalWorkId)) {
    errors.push({ field: "externalWorkId", reason: "required non-empty string" });
  }

  if (!isNonEmptyString(record.userId)) {
    errors.push({ field: "userId", reason: "required non-empty string" });
  }

  if (!isNullableString(record.title)) {
    errors.push({ field: "title", reason: "must be a string or null" });
  }

  if (!isNonEmptyString(record.status)) {
    errors.push({ field: "status", reason: "required non-empty string" });
  }

  if (!isNullableString(record.conversationReference)) {
    errors.push({ field: "conversationReference", reason: "must be a string or null" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      externalWorkId: record.externalWorkId as string,
      userId: record.userId as string,
      title: (record.title as string | null) ?? null,
      status: record.status as string,
      conversationReference: (record.conversationReference as string | null) ?? null,
    },
  };

}

const ALLOWED_CHANNELS = new Set(["slack"]);

export function validateConversationLinkProjectionUpsertInput(
  body: unknown
): ValidationResult<ConversationLinkProjectionUpsertInput> {

  if (typeof body !== "object" || body === null) {
    return { ok: false, errors: [{ field: "(body)", reason: "must be a JSON object" }] };
  }

  const record = body as Record<string, unknown>;
  const errors: ValidationFailure[] = [];

  if (!isNonEmptyString(record.userId)) {
    errors.push({ field: "userId", reason: "required non-empty string" });
  }

  if (typeof record.channel !== "string" || !ALLOWED_CHANNELS.has(record.channel)) {
    errors.push({ field: "channel", reason: `must be one of: ${[...ALLOWED_CHANNELS].join(", ")}` });
  }

  if (!isOptionalString(record.externalWorkspaceId)) {
    errors.push({ field: "externalWorkspaceId", reason: "must be a non-empty string if present" });
  }

  if (!isNonEmptyString(record.externalConversationId)) {
    errors.push({ field: "externalConversationId", reason: "required non-empty string" });
  }

  if (!isOptionalString(record.externalThreadId)) {
    errors.push({ field: "externalThreadId", reason: "must be a non-empty string if present" });
  }

  if (!isNonEmptyString(record.conversationReference)) {
    errors.push({ field: "conversationReference", reason: "required non-empty string" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      userId: record.userId as string,
      channel: "slack",
      externalWorkspaceId: record.externalWorkspaceId as string | undefined,
      externalConversationId: record.externalConversationId as string,
      externalThreadId: record.externalThreadId as string | undefined,
      conversationReference: record.conversationReference as string,
    },
  };

}
