// =========================
// TACT Event — Normalized Input Validation (EVENT-P1b)
// =========================
//
// 純粋関数のみ(DBアクセス・ネットワーク呼び出し無し)。
// supabase/migrations/20261015000000_create_tact_event_model.sqlの
// CHECK制約(char_length各列)と同じ上限値をここでも検証する——
// DB側のCHECK制約違反という不親切なerrorとしてではなく、意味の分かる
// EventInvalidReasonCodeとして呼び出し元に早期に返すため(fail closed、
// Section6絶対条件「Reject invalid input before persistence」)。

import type {
  NormalizedExternalEventInput,
  ValidateNormalizedExternalEventInputResult,
} from "./types";

// migration側のcheck (char_length(...) between 1 and N) と同じ上限。
const SOURCE_MAX_LENGTH = 100;
const EVENT_TYPE_MAX_LENGTH = 200;
const EXTERNAL_EVENT_ID_MAX_LENGTH = 500;
const SUBJECT_REF_MAX_LENGTH = 1000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

// Section6「payload is JSON-serializable」。plain object(array/null/
// primitiveではない)であることと、JSON.stringify()が例外を投げない
// こと(循環参照・BigInt等を排除する)の両方を確認する——
// 「JSON-serializable」を型だけでなく実際にシリアライズを試みて
// 確認する(型がRecord<string, unknown>であっても、実行時には循環
// 参照オブジェクト等が渡され得るため)。
function isJsonSerializablePlainObject(value: unknown): value is Record<string, unknown> {

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }

}

export function validateNormalizedExternalEventInput(
  input: NormalizedExternalEventInput
): ValidateNormalizedExternalEventInputResult {

  if (!isNonEmptyString(input.userId)) {
    return { ok: false, reasonCode: "missing_user_id" };
  }

  if (!isNonEmptyString(input.source)) {
    return { ok: false, reasonCode: "missing_source" };
  }

  if (input.source.trim().length > SOURCE_MAX_LENGTH) {
    return { ok: false, reasonCode: "source_too_long" };
  }

  if (!isNonEmptyString(input.eventType)) {
    return { ok: false, reasonCode: "missing_event_type" };
  }

  if (input.eventType.trim().length > EVENT_TYPE_MAX_LENGTH) {
    return { ok: false, reasonCode: "event_type_too_long" };
  }

  if (!isNonEmptyString(input.externalEventId)) {
    return { ok: false, reasonCode: "missing_external_event_id" };
  }

  if (input.externalEventId.trim().length > EXTERNAL_EVENT_ID_MAX_LENGTH) {
    return { ok: false, reasonCode: "external_event_id_too_long" };
  }

  if (!isNonEmptyString(input.subjectRef)) {
    return { ok: false, reasonCode: "missing_subject_ref" };
  }

  if (input.subjectRef.trim().length > SUBJECT_REF_MAX_LENGTH) {
    return { ok: false, reasonCode: "subject_ref_too_long" };
  }

  if (
    input.occurredAt !== undefined &&
    input.occurredAt !== null &&
    !isValidTimestamp(input.occurredAt)
  ) {
    return { ok: false, reasonCode: "invalid_occurred_at" };
  }

  if (
    input.normalizedPayload !== undefined &&
    !isJsonSerializablePlainObject(input.normalizedPayload)
  ) {
    return { ok: false, reasonCode: "invalid_normalized_payload" };
  }

  // 絶対条件(Section6「Do not add fuzzy/default values silently」):
  // ここではtrim()した値をそのまま保存用のvalueとして採用しない
  // ——入力をそのまま透過する(前後空白の除去のような「親切な正規化」
  // も行わない、provider側が意味を持たせた文字列をそのまま保持する)。
  return {
    ok: true,
    value: {
      userId: input.userId,
      source: input.source,
      eventType: input.eventType,
      externalEventId: input.externalEventId,
      subjectRef: input.subjectRef,
      occurredAt: input.occurredAt ?? null,
      normalizedPayload: input.normalizedPayload ?? {},
    },
  };

}
