// =========================
// TACT Event — Canonical Intake Types (EVENT-P1b)
// =========================
//
// core/tact-event/はEVENT-P1a Architecture Auditで確立した設計
// (Section M「provider webhook/subscription registrationはIntegration
// 層の責務、resulting inbound deliveryはEvent層を通す」)に沿った、
// provider-neutralなEvent層である。責務(EVENT-P1b指示Section2):
//   - inbound event validation contract
//   - normalization into canonical ExternalEvent input
//   - dedup-aware persistence orchestration
//   - typed intake outcomes
//
// 「しない」こと(絶対条件、Section2/14/15):
//   - provider固有のparsing/署名検証(adapter/route edgeの責務、
//     core/tact-eventは一切のHTTP/webhook/署名検証コードを持たない)
//   - Work resume logic(core/tact-work/へ一切書き込まない、
//     EventWait matching/claim/Task.status遷移/Run作成のいずれも
//     このmoduleには存在しない——EVENT-P1c以降のscope)
//
// 依存方向: core/tact-event → core/tact-work(型のみ、ExternalEvent/
// CreateExternalEventParams)。逆方向のimportは無い(EVENT-P1a
// Architecture Auditの「Work層はEventWaitを持つが、signature検証や
// provider固有payload parsingを持たない」という責務分離をそのまま
// 型の依存方向にも反映する)。

import type { ExternalEvent } from "../tact-work/types";

// =========================
// NormalizedExternalEventInput
// =========================
//
// Section3絶対条件: 「Input should already be provider-authenticated /
// provider-verified. The intake layer itself should receive a
// normalized provider event candidate, not raw unauthenticated HTTP
// bytes.」——この型はadapter/route edgeが既に署名検証・provider固有
// parsingを終えた後にしか構築できない、という契約を型の命名
// ("Normalized"、"Input"であって"RawPayload"ではない)で表現する。
//
// receivedAtを含めない(Section3「receivedAt should be server-generated」
// ——core/tact-work/store.tsのcreateExternalEvent()が呼び出し元から
// received_atを受け取らず、DBのdefault now()にのみ委ねる既存契約
// (EVENT-P1a)をそのまま踏襲する。この型に含めてしまうと、呼び出し元が
// 誤って任意の時刻を注入できる余地を作ってしまう)。
export interface NormalizedExternalEventInput {

  // Section12絶対条件: このuserIdは「検証済みのprovider connection /
  // authenticated actor resolution」から来ていなければならない
  // ——raw inbound provider payload由来の値をそのまま渡さない。
  // この型・ingestExternalEvent()自体はinternal functionとして
  // userIdを信頼するが、実際のadapter実装(EVENT-P1d以降)は、
  // このuserIdをprovider connectionの所有者から解決した値で埋める
  // 責務を負う——ドキュメント上の契約であり、この型システムだけでは
  // 強制できない(Section12「P1b core API may accept userId because
  // it is an internal function」)。
  userId: string;

  source: string;

  eventType: string;

  externalEventId: string;

  subjectRef: string;

  occurredAt?: string | null;

  // 省略時は空object({})として扱う(core/tact-work/types.ts
  // ExternalEvent.normalizedPayloadと同じ既定値、Approval.payloadと
  // 同じ設計)。
  normalizedPayload?: Record<string, unknown>;

}

// =========================
// Validation
// =========================
//
// Section6絶対条件: 「Reject invalid input before persistence. Do not
// add fuzzy/default values silently.」

export type EventInvalidReasonCode =
  | "missing_user_id"
  | "missing_source"
  | "source_too_long"
  | "missing_event_type"
  | "event_type_too_long"
  | "missing_external_event_id"
  | "external_event_id_too_long"
  | "missing_subject_ref"
  | "subject_ref_too_long"
  | "invalid_occurred_at"
  | "invalid_normalized_payload";

export const EVENT_INVALID_REASON_CODES: readonly EventInvalidReasonCode[] = [
  "missing_user_id",
  "missing_source",
  "source_too_long",
  "missing_event_type",
  "event_type_too_long",
  "missing_external_event_id",
  "external_event_id_too_long",
  "missing_subject_ref",
  "subject_ref_too_long",
  "invalid_occurred_at",
  "invalid_normalized_payload",
];

export type ValidateNormalizedExternalEventInputResult =
  | { ok: true; value: NormalizedExternalEventInput }
  | { ok: false; reasonCode: EventInvalidReasonCode };

// =========================
// Duplicate conflict classification (Section8)
// =========================
//
// 「同じ(source, external_event_id)だが、userId/eventType/subjectRefの
// いずれかが食い違う」edge caseを、単一のbooleanではなく、何が
// 食い違ったかを明示するreasonCodeとして表現する(絶対条件: silently
// reinterpret ownershipしない、fail closedに何が起きたかを記録する)。
//
// "conflicting_owner"はexisting eventを一切含まない
// (core/tact-work/store.tsのfindExternalEventBySourceAndExternalId()が
// RLSにより他userの行を返せない構造そのものが、この情報を漏らさない
// ことを保証する——このcodeはその「見えないが確かに衝突した」ことを
// 表す)。
export type EventDuplicateConflictReasonCode =
  | "conflicting_owner"
  | "conflicting_event_type"
  | "conflicting_subject_ref";

export const EVENT_DUPLICATE_CONFLICT_REASON_CODES: readonly EventDuplicateConflictReasonCode[] = [
  "conflicting_owner",
  "conflicting_event_type",
  "conflicting_subject_ref",
];

// =========================
// EventIngestOutcome (Section11)
// =========================
//
// Section11の最小集合(event_received/event_duplicate/
// event_duplicate_conflict/event_invalid/event_wrong_owner/
// event_persistence_failed)をそのまま採用する。他のcore/tact-work/*の
// 既存慣習(TaskResumeEligibility等)と同じ、discriminated unionによる
// 型安全なoutcome表現。
export type EventIngestOutcome =
  | { status: "event_received"; event: ExternalEvent }
  | { status: "event_duplicate"; existing: ExternalEvent }
  | {
      status: "event_duplicate_conflict";
      reasonCode: EventDuplicateConflictReasonCode;
      // "conflicting_owner"の場合のみundefined(Section8、他userの行を
      // 漏らさないため)。"conflicting_event_type"/"conflicting_subject_ref"
      // の場合は、衝突した既存行(呼び出し元自身が所有する行)を返す。
      existing?: ExternalEvent;
    }
  | { status: "event_invalid"; reasonCode: EventInvalidReasonCode }
  | { status: "event_wrong_owner" }
  | { status: "event_persistence_failed"; error: string };
