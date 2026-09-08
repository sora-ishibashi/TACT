import {
  getWork,
  createAuditEvent as storeCreateAuditEvent,
} from "./store";
import type { JsonValue } from "./approvalIntegrity";
import type {
  AuditEvent,
  AuditEventCategory,
  AuditEventType,
  ActorReference,
} from "./types";

// =========================
// TACT Work — Audit Event Execution Boundary (Fast Port P4a:
// Append-Only Audit Event Foundation)
// =========================
//
// docs/architecture/p2-p5-final-architecture.md Section15-20で確定した
// 設計をそのまま実装する。core/tact-work/approval.ts・
// core/tact-work/clarification.tsと同じ二層構造(store.tsの生CRUD +
// このExecution Boundary)を持つが、Audit自体には「Work statusを
// 進める」ようなsside effectが無い(絶対条件13、Step14: Audit write
// 自体がWork/Task statusを変更しない・side effectを起こさない)ため、
// このfileの責務はstore.tsへの薄い委譲と、Step10の安全contractの
// 実施(containsSuspiciousKey())にとどまる。
//
// 重要な区別(Approval/Clarificationと同じ規律): AuditEventは
// Canonical Entity(core/tact-work/store.tsのtact_audit_events)で
// あり、このfileが公開するrecordAuditEvent()/listAuditEventsForWork()
// だけを呼ぶ。production APIはcreate/listのみ——update/delete関数は
// 一切存在しない(append-only、絶対条件4/Step16)。
//
// Prior Art(ADAPT_AND_BORROW、source codeはコピーしない): BoundFlow
// のaudit_events table・AXMEのmonotonic sequence。

// =========================
// containsSuspiciousKey (Fast Port P4a Step10: safe details contract)
// =========================
//
// 設計判断(brief Step10、overengineering禁止の指示への回答):
// generic redaction engine(値の内容を解析してsecretらしきものを
// マスクする等)は今回作らない——それは値の意味を理解しようとする
// 複雑なheuristicを必要とし、TACTの他の安全境界(例: ARCH-P1の
// canonicalizeJsonValue()も値の意味は一切解釈しない)とも設計思想が
// 異なる。代わりに、絶対条件7/8(raw secret/token/provider
// credentialを保存しない)を実際のAPI境界で機械的に強制する、最小限の
// key名ベースのguardだけを実装する: JsonValue内の全objectキーを
// 再帰的に走査し、小さな固定blocklist(大文字小文字を区別しない
// 部分一致)に該当するキー名が1つでもあれば、書き込みを拒否する
// (呼び出し元の作文ミスを検出するための最後の防御層であり、
// 呼び出し元がsafe metadataだけを渡す責務そのものを代替するもの
// ではない——ARCH-P1のApproval Subjectが「provider固有識別子/secret
// を最初から含めない」という構築規律で安全性を担保しているのと
// 同じ精神)。
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

// details全体(JsonValue、object/arrayを再帰する)を走査し、疑わしい
// キー名を全て集めて返す(1つ見つかった時点で打ち切らない——呼び出し
// 元が診断しやすいよう、全件報告する)。値の中身(文字列の内容等)は
// 一切見ない——キー名だけを見る、絶対条件通りの最小限guard。
export function findSuspiciousKeys(value: JsonValue | null | undefined, path = "$"): string[] {

  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSuspiciousKeys(item, `${path}[${index}]`));
  }

  if (typeof value === "object") {

    const found: string[] = [];

    for (const key of Object.keys(value)) {

      const childPath = `${path}.${key}`;

      if (isSuspiciousKeyName(key)) {
        found.push(childPath);
      }

      found.push(...findSuspiciousKeys((value as Record<string, JsonValue>)[key], childPath));

    }

    return found;

  }

  return [];

}

// =========================
// recordAuditEvent
// =========================

export interface RecordAuditEventRequest {

  workId: string;

  taskId?: string | null;

  runId?: string | null;

  approvalId?: string | null;

  clarificationId?: string | null;

  category: AuditEventCategory;

  eventType: AuditEventType;

  // 呼び出し元にとって自然なActorReference形(既存のApprovalRequest.
  // requestedByActor/ClarificationRequest.requestedByActorと同じ
  // 公開APIの形)。store.ts層で既存のflat columns
  // (actorKind/actorId)へ変換する(絶対条件Step7と同じ変換パターン)。
  actor?: ActorReference | null;

  reasonCode?: string | null;

  details?: JsonValue | null;

  occurredAt?: string | null;

}

export interface AuditEventExecutionDeps {

  getWork: typeof getWork;

  createAuditEvent: typeof storeCreateAuditEvent;

}

const defaultDeps: AuditEventExecutionDeps = {
  getWork,
  createAuditEvent: storeCreateAuditEvent,
};

export type RecordAuditEventOutcome =
  | { status: "recorded"; event: AuditEvent }
  | { status: "not_found" }
  // Fast Port P4a Step10: detailsに疑わしいkey名が含まれる場合、
  // 書き込みを拒否する(fail closed——silent dropや自動maskingは
  // しない、呼び出し元に明示的に知らせる)。
  | { status: "unsafe_details"; suspiciousKeys: string[] };

// 絶対条件(Step14、最重要): この関数はWork/Task statusのいずれも
// 変更しない。Provider/LLM/Search呼び出しも一切行わない
// (import一覧がそれを構造的に保証する——core/tact-integration・
// core/llm・core/tact-research のいずれもこのfileはimportしない)。
export async function recordAuditEvent(
  request: RecordAuditEventRequest,
  userId: string,
  accessToken: string,
  deps: AuditEventExecutionDeps = defaultDeps
): Promise<RecordAuditEventOutcome> {

  if (request.details !== null && request.details !== undefined) {

    const suspiciousKeys = findSuspiciousKeys(request.details);

    if (suspiciousKeys.length > 0) {
      return { status: "unsafe_details", suspiciousKeys };
    }

  }

  const event = await deps.createAuditEvent(
    request.workId,
    userId,
    accessToken,
    {
      taskId: request.taskId ?? null,
      runId: request.runId ?? null,
      approvalId: request.approvalId ?? null,
      clarificationId: request.clarificationId ?? null,
      category: request.category,
      eventType: request.eventType,
      actorKind: request.actor?.kind ?? null,
      actorId: request.actor?.id ?? null,
      reasonCode: request.reasonCode ?? null,
      details: request.details ?? null,
      occurredAt: request.occurredAt ?? null,
    }
  );

  if (!event) {
    return { status: "not_found" };
  }

  return { status: "recorded", event };

}

// =========================
// emitAuditSafely (Fast Port P4b Step2: Audit-safe emission helper)
// =========================
//
// 設計判断(brief Step2、generic event bus化禁止への回答): Kafka/
// EventEmitter/message broker等は一切導入しない。この関数は
// recordAuditEvent()を呼ぶだけの薄いsafe wrapperであり、責務は
// 以下の2つだけ:
//   1. Audit書き込みのfailure(recordAuditEvent()が非recorded
//      outcomeを返す、またはexceptionを投げる)を、呼び出し元の
//      business outcomeへ絶対に昇格させない(絶対条件3/4、最重要:
//      Approval承認・Clarification応答・Provider実行成功・Run確定
//      等の既存canonical mutationは、Audit insertが失敗しても
//      一切rollback/取り消しされない)。
//   2. ただし完全にsilentに握り潰さない——既存のconsole.warn
//      best-effortログpattern(core/tact-integration/execution.tsの
//      reconcileAfterTaskUpdate()と同じ精神)で、診断可能な形にする。
//      raw secret/token等がこのログへ漏れないよう、recordAuditEvent()
//      自身がunsafe_detailsとして事前に拒否する設計(P4a)にそのまま
//      乗る——ここでは追加のredactionを行わない。
//
// 呼び出し元(approval.ts/clarification.ts/execution.ts×2)は全て
// このrelaxedな戻り値(void)を持つ関数をdeps経由で注入する
// (Step13: 既存DI styleに合わせる、テストがreal Supabaseを
// 誤って呼ばないようdefault実装ではなくfake実装を注入できるように
// する——Fast Port P4a incidentの教訓)。
//
// 絶対条件(Step12、event ordering): この関数は常にawaitされる想定
// (fire-and-forgetにしない)。Audit insert自体のlatencyは許容し、
// event orderingの正確性を優先する(将来のbatch/async化はP4c以降で
// 再評価、今回はDEFER)。
export async function emitAuditSafely(
  request: RecordAuditEventRequest,
  userId: string,
  accessToken: string,
  deps: AuditEventExecutionDeps = defaultDeps
): Promise<void> {

  try {

    const outcome = await recordAuditEvent(request, userId, accessToken, deps);

    if (outcome.status !== "recorded") {

      console.warn(
        "[tact-work/audit] emitAuditSafely(): recordAuditEvent()がrecorded以外を返した" +
        `(status=${outcome.status})。business操作は既に確定済みのため、この境界での` +
        "Audit失敗によって取り消し・再試行は一切行わない。",
        outcome.status === "unsafe_details" ? { suspiciousKeys: outcome.suspiciousKeys } : undefined
      );

    }

  } catch (error) {

    console.warn(
      "[tact-work/audit] emitAuditSafely(): recordAuditEvent()が例外を投げた。" +
      "business操作は既に確定済みのため、この境界でのAudit失敗によって取り消し・" +
      "再試行は一切行わない(絶対条件3/4、Audit failure ≠ business operation failure)。",
      error
    );

  }

}

// =========================
// listAuditEventsForWork
// =========================
//
// Approval/Clarificationのlist関数と異なり、Audit読み取りには
// 追加の責務(Work statusの解釈等)が一切無い——core/tact-work/
// store.tsのlistAuditEventsForWork()をそのままcanonical public API
// として再export する(意味の無い薄いwrapperを重複させない、絶対
// 条件: 二重実装を避ける)。呼び出し元はこのbarrelから
// (core/tact-work/index.ts経由で)そのままimportできる。
export { listAuditEventsForWork } from "./store";
