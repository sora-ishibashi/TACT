// =========================
// TACT Event — Canonical Intake (EVENT-P1b)
// =========================
//
// ingestExternalEvent()が、このmoduleの唯一の書き込みentry pointである。
// 責務(EVENT-P1b指示Section2、絶対条件):
//   validate -> persist(insert-first) -> unique violationをdedup
//   outcomeへ正規化する。
//
// 「しない」こと(絶対条件、Section14):
//   - listPendingEventWaits()によるmatching
//   - subjectRef比較によるEventWait claim
//   - Task.status遷移
//   - requestTaskResume()/executePreparedTaskResume()呼び出し
//   - Run作成
// このfileはcore/tact-work/resume.ts・core/tact-work/taskRunReconciliation.ts
// のいずれもimportしない(実際にimportしていないことがEVENT-P1cへの
// 引き継ぎ時に一目でわかるようにする)。
//
// Dedup戦略(Section7「Insert-first + unique constraint is preferred」):
// read-before-insertでraceを防ごうとしない(TOCTOU)。常にまず
// createExternalEvent()を試み、DBのunique index
// (source, external_event_id)がunique_violationを返した場合にのみ、
// 何が起きたかを判定するための追加読み取りを行う——「同時に2つの
// リクエストが同じeventを届けても、DBが必ず片方だけを成功させる」
// という保証を、application層のロックではなくDB制約に委ねる
// (core/tact-work/store.tsのcreateRun()と同じ設計哲学、EVENT-P1a
// 監査Section7で確認済みの既存precedent)。

import type { ExternalEvent } from "../tact-work/types";
import {
  createExternalEvent,
  findExternalEventBySourceAndExternalId,
  type CreateExternalEventParams,
} from "../tact-work/store";
import { validateNormalizedExternalEventInput } from "./validate";
import type {
  EventIngestOutcome,
  NormalizedExternalEventInput,
} from "./types";

export interface IngestExternalEventDeps {

  createExternalEvent: (
    params: CreateExternalEventParams,
    accessToken: string
  ) => Promise<ExternalEvent>;

  findExternalEventBySourceAndExternalId: (
    userId: string,
    accessToken: string,
    source: string,
    externalEventId: string
  ) => Promise<ExternalEvent | undefined>;

}

const defaultDeps: IngestExternalEventDeps = {
  createExternalEvent,
  findExternalEventBySourceAndExternalId,
};

// Postgrest/Supabase-jsのerror shape({message, details, hint, code})から
// Postgres error codeだけを、型を一切信用せず安全に取り出す
// (throwされた値がPostgrestErrorであるとは限らない——ネットワーク
// エラー等、codeを持たない値である可能性を常に考慮する、fail closed)。
function extractPostgresErrorCode(error: unknown): string | undefined {

  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const code = (error as Record<string, unknown>).code;

  return typeof code === "string" ? code : undefined;

}

function describeError(error: unknown): string {

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null) {

    const message = (error as Record<string, unknown>).message;

    if (typeof message === "string") {
      return message;
    }

  }

  return String(error);

}

const POSTGRES_UNIQUE_VIOLATION = "23505";

// foreign_key_violation(userIdがauth.usersに存在しない)・
// insufficient_privilege(RLS insert with check違反、= userIdが
// このaccessTokenの実際のauth.uid()と一致しない)のいずれも、
// 「主張されたownerが正当ではない」という同じ意味の失敗として
// event_wrong_ownerへ正規化する(Section12絶対条件「No cross-user
// event rewrite」の、DB制約による最終防衛線)。
const POSTGRES_FOREIGN_KEY_VIOLATION = "23503";
const POSTGRES_INSUFFICIENT_PRIVILEGE = "42501";

async function classifyDuplicateInsertError(
  error: unknown,
  value: NormalizedExternalEventInput,
  accessToken: string,
  deps: IngestExternalEventDeps
): Promise<EventIngestOutcome> {

  // Section8: DBのunique indexはsource + external_event_idのみで
  // user_idを含まないため、衝突相手が「自分自身の既存行」なのか
  // 「別userが既に使っているキー」なのかを、RLS scopedな追加読み取り
  // でしか区別できない。
  const ownExisting = await deps.findExternalEventBySourceAndExternalId(
    value.userId,
    accessToken,
    value.source,
    value.externalEventId
  );

  if (!ownExisting) {
    // RLS(auth.uid() = user_id)により、この関数はこのuser自身の行
    // しか返せない——見つからない = 衝突相手は別userの行である
    // ことが構造的に保証される。他userの行を読み取ろうとせず、
    // 何が衝突したかを一切推測・合成しない(絶対条件: silently
    // reinterpret ownershipしない)。
    return { status: "event_duplicate_conflict", reasonCode: "conflicting_owner" };
  }

  if (ownExisting.eventType !== value.eventType) {
    return {
      status: "event_duplicate_conflict",
      reasonCode: "conflicting_event_type",
      existing: ownExisting,
    };
  }

  if (ownExisting.subjectRef !== value.subjectRef) {
    return {
      status: "event_duplicate_conflict",
      reasonCode: "conflicting_subject_ref",
      existing: ownExisting,
    };
  }

  // Section9絶対条件: duplicateはfatalではない。既存行をそのまま返す
  // だけで、mutateは一切行わない。
  return { status: "event_duplicate", existing: ownExisting };

}

export async function ingestExternalEvent(
  input: NormalizedExternalEventInput,
  accessToken: string,
  deps: IngestExternalEventDeps = defaultDeps
): Promise<EventIngestOutcome> {

  const validation = validateNormalizedExternalEventInput(input);

  if (!validation.ok) {
    return { status: "event_invalid", reasonCode: validation.reasonCode };
  }

  const value = validation.value;

  try {

    // Section9絶対条件: ここでstatusを明示的に渡さない
    // ——core/tact-work/store.tsのcreateExternalEvent()自体が
    // status列のDB defaultである'received'に委ねる(EVENT-P1aの
    // migration参照)。matched/unmatched/expiredをこのfileが
    // 一切書き込まないことを、「そもそも値を渡さない」という形で
    // 構造的に保証する。
    const event = await deps.createExternalEvent(
      {
        userId: value.userId,
        source: value.source,
        eventType: value.eventType,
        externalEventId: value.externalEventId,
        subjectRef: value.subjectRef,
        occurredAt: value.occurredAt ?? null,
        normalizedPayload: value.normalizedPayload ?? {},
      },
      accessToken
    );

    return { status: "event_received", event };

  } catch (error) {

    const code = extractPostgresErrorCode(error);

    if (code === POSTGRES_UNIQUE_VIOLATION) {
      return classifyDuplicateInsertError(error, value, accessToken, deps);
    }

    if (
      code === POSTGRES_FOREIGN_KEY_VIOLATION ||
      code === POSTGRES_INSUFFICIENT_PRIVILEGE
    ) {
      return { status: "event_wrong_owner" };
    }

    return { status: "event_persistence_failed", error: describeError(error) };

  }

}
