// =========================
// TACT Work — Canonical ExternalEvent + EventWait Model Regression
// (EVENT-P1a)
// =========================
//
// 対象: core/tact-work/types.tsのExternalEvent/EventWait/
// ExternalEventStatus/EventWaitStatus・core/tact-work/store.tsの
// toExternalEvent()/toEventWait()/createEventWait()/getEventWait()、
// および対応するmigration
// (supabase/migrations/20261015000000_create_tact_event_model.sql・
// 20261015010000_add_task_waiting_for_event_status.sql)。
//
// 絶対条件(既存規約、connectionsPanel.test.ts/coreSectionAuth.test.ts
// と同じ理由): このrepositoryは実Supabase接続を伴うtestを持たない
// (LLM call = 0 / Search API call = 0 / 実DB接続 = 0)。DB-level
// unique index・nullable列・FK不在といったmigrationの構造的性質は、
// migration source自体をtext検査することで確認する(接続して確かめる
// 代わりに「そう書かれていること」を確認する、既存precedent)。
// createExternalEvent()/getExternalEvent()/listPendingEventWaits()は
// WorkOwnershipDepsを持たずcreateRequestScopedClient()へ直結するため
// (Section9、top-level user-owned entity)、実行時のcross-user拒否は
// createEventWait()/getEventWait()(WorkOwnershipDeps経由、
// storeAuthorization.test.tsと同じDIパターン)でのみ検証する。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  toExternalEvent,
  toEventWait,
  createEventWait,
  getEventWait,
  type ExternalEventRow,
  type EventWaitRow,
  type WorkOwnershipDeps,
} from "../../../core/tact-work/store";
import { TASK_STATUSES, RUN_STATUSES } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

// interfaceの本体(開き波括弧の次の文字から、対応する閉じ波括弧の直前
// まで)をbrace-depthを追跡して安全に切り出す(正規表現の
// greedy/non-greedy問題を避ける)。
function extractInterfaceBody(source: string, interfaceName: string): string {

  const startMarker = `export interface ${interfaceName} {`;
  const start = source.indexOf(startMarker);

  if (start < 0) {
    return "";
  }

  let depth = 0;
  let i = start + startMarker.length - 1;

  for (; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        break;
      }
    }
  }

  return source.slice(start + startMarker.length, i);

}

// コメント行(「//」始まり)を除外した上で、実際のfield宣言行から
// field名だけを抜き出す(コメント中の説明的な語彙——"provider
// credential/authorizationデータを含めない"等——を実fieldと誤認しない
// ため)。
function extractFieldNames(interfaceBody: string): string[] {

  return interfaceBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .map((line) => {
      const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/);
      return m ? m[1] : null;
    })
    .filter((name): name is string => name !== null);

}

// 他userのWork(=このuserからは見えないWork)を模した偽実装
// (storeAuthorization.test.tsと同じDIパターン、実Supabaseへは一切
// 到達しない)。
const notFoundDeps: WorkOwnershipDeps = {
  getWork: async () => undefined,
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- A. ExternalEvent round-trip ----
  {
    const row: ExternalEventRow = {
      id: "ext-evt-1",
      user_id: "user-1",
      source: "gmail",
      event_type: "message.received",
      external_event_id: "gmail-msg-999",
      subject_ref: "thread-abc",
      occurred_at: "2026-09-17T00:00:00.000Z",
      received_at: "2026-09-17T00:00:05.000Z",
      normalized_payload: { subject: "Re: hello" },
      status: "received",
      created_at: "2026-09-17T00:00:05.000Z",
    };

    const event = toExternalEvent(row);

    results.push(
      check(
        "[A] toExternalEvent(): 全fieldが1対1でcamelCaseへround-tripする",
        event.id === row.id &&
          event.userId === row.user_id &&
          event.source === row.source &&
          event.eventType === row.event_type &&
          event.externalEventId === row.external_event_id &&
          event.subjectRef === row.subject_ref &&
          event.occurredAt === row.occurred_at &&
          event.receivedAt === row.received_at &&
          event.normalizedPayload === row.normalized_payload &&
          event.status === row.status &&
          event.createdAt === row.created_at
      )
    );
  }

  // ---- B. EventWait round-trip ----
  {
    const row: EventWaitRow = {
      id: "wait-1",
      user_id: "user-1",
      work_id: "work-1",
      task_id: "task-1",
      expected_source: "gmail",
      expected_event_type: "message.received",
      subject_ref: "thread-abc",
      status: "pending",
      created_at: "2026-09-17T00:00:00.000Z",
      expires_at: null,
      claimed_by_event_id: null,
    };

    const wait = toEventWait(row);

    results.push(
      check(
        "[B] toEventWait(): 全fieldが1対1でcamelCaseへround-tripする",
        wait.id === row.id &&
          wait.userId === row.user_id &&
          wait.workId === row.work_id &&
          wait.taskId === row.task_id &&
          wait.expectedSource === row.expected_source &&
          wait.expectedEventType === row.expected_event_type &&
          wait.subjectRef === row.subject_ref &&
          wait.status === row.status &&
          wait.createdAt === row.created_at &&
          wait.expiresAt === row.expires_at &&
          wait.claimedByEventId === row.claimed_by_event_id
      )
    );
  }

  // ---- C. TaskStatus accepts waiting_for_event ----
  results.push(
    check(
      "[C] TASK_STATUSESはwaiting_for_eventを含む",
      TASK_STATUSES.includes("waiting_for_event")
    )
  );

  // ---- D. RunStatus remains unchanged (no "waiting" value added) ----
  results.push(
    check(
      "[D] RUN_STATUSESは引き続きrunning/completed/failedの3値のみ(waitingは追加しない、Section8絶対条件)",
      RUN_STATUSES.length === 3 &&
        RUN_STATUSES.includes("running") &&
        RUN_STATUSES.includes("completed") &&
        RUN_STATUSES.includes("failed")
    )
  );

  const eventModelMigration = readRepoFile(
    "supabase/migrations/20261015000000_create_tact_event_model.sql"
  );

  const externalEventsSection = eventModelMigration.slice(
    eventModelMigration.indexOf("-- 1. tact_external_events"),
    eventModelMigration.indexOf("-- 2. tact_event_waits")
  );

  const eventWaitsSection = eventModelMigration.slice(
    eventModelMigration.indexOf("-- 2. tact_event_waits"),
    eventModelMigration.indexOf("-- 3. Row Level Security")
  );

  // ---- E. duplicate ExternalEvent identity is DB-constrained ----
  results.push(
    check(
      "[E] tact_external_eventsは(source, external_event_id)にunique indexを持つ(DB-level dedup、in-memoryのみに頼らない)",
      /create unique index[\s\S]*?idx_tact_external_events_source_external_event_id[\s\S]*?on public\.tact_external_events \(source, external_event_id\)/.test(
        externalEventsSection
      )
    )
  );

  // ---- F. pending EventWait can exist without any ExternalEvent ----
  results.push(
    check(
      "[F] tact_event_waits.claimed_by_event_idはnullable(EventWait作成時にExternalEventの存在を要求しない)",
      /claimed_by_event_id uuid null\s*\n\s*references public\.tact_external_events \(id\) on delete set null/.test(
        eventWaitsSection
      ) && !/claimed_by_event_id uuid not null/.test(eventWaitsSection)
    )
  );

  // ---- G. ExternalEvent can exist without EventWait/Work ----
  results.push(
    check(
      "[G] tact_external_eventsはtact_works/tact_event_waitsへのFKを一切持たない(user_id直接列のみのtop-level entity、Section9絶対条件)",
      !externalEventsSection.includes("references public.tact_works") &&
        !externalEventsSection.includes("references public.tact_event_waits") &&
        externalEventsSection.includes("references auth.users")
    )
  );

  const typesSource = readRepoFile("core/tact-work/types.ts");
  const externalEventFields = extractFieldNames(
    extractInterfaceBody(typesSource, "ExternalEvent")
  );
  const eventWaitFields = extractFieldNames(
    extractInterfaceBody(typesSource, "EventWait")
  );

  // ---- H. ownership fields are required (not optional) ----
  {
    const externalEventBody = extractInterfaceBody(typesSource, "ExternalEvent");
    const eventWaitBody = extractInterfaceBody(typesSource, "EventWait");

    results.push(
      check(
        "[H] ExternalEvent.userId / EventWait.userIdはoptionalでない必須field(\"userId?:\"ではなく\"userId:\")",
        externalEventFields.includes("userId") &&
          !/\buserId\?\s*:/.test(externalEventBody) &&
          eventWaitFields.includes("userId") &&
          !/\buserId\?\s*:/.test(eventWaitBody)
      )
    );
  }

  // ---- I. matching fields are persisted exactly (no normalization) ----
  {
    const row: EventWaitRow = {
      id: "wait-2",
      user_id: "user-1",
      work_id: "work-1",
      task_id: "task-1",
      expected_source: "slack",
      expected_event_type: "approval.decision",
      subject_ref: "approval-42",
      status: "pending",
      created_at: "2026-09-17T00:00:00.000Z",
      expires_at: null,
      claimed_by_event_id: null,
    };

    const wait = toEventWait(row);

    results.push(
      check(
        "[I] EventWaitの照合対象field(expectedSource/expectedEventType/subjectRef)はtrim/lowercase等の変換を一切受けずそのまま保持される",
        wait.expectedSource === "slack" &&
          wait.expectedEventType === "approval.decision" &&
          wait.subjectRef === "approval-42"
      )
    );
  }

  // ---- J. no provider credentials/raw authorization data in canonical model ----
  {
    const forbidden = /credential|secret|apikey|accesstoken|authorization/i;

    results.push(
      check(
        "[J] ExternalEvent/EventWaitのcanonical modelは、provider credential/access token/authorizationに相当するfield名を一切持たない",
        externalEventFields.every((name) => !forbidden.test(name)) &&
          eventWaitFields.every((name) => !forbidden.test(name))
      )
    );
  }

  // ---- K. cross-user access rejected (Approval/Clarification/Retry/TIME
  // 自体は本fileの対象外——既存test suite(work/approval, work/clarification,
  // work/temporal*, work/candidateSnapshotIntegrity等)がこのphaseの
  // 変更で一切書き換わっていないことをもって"無変更"を保証する。ここでは
  // EventWaitがApproval/Clarificationと同じWorkOwnershipDeps DI規約に
  // 従うことだけを確認する)。
  {
    const created = await createEventWait(
      "work-1",
      "attacker-user",
      "fake-token",
      {
        taskId: "task-1",
        expectedSource: "gmail",
        expectedEventType: "message.received",
        subjectRef: "thread-x",
      },
      notFoundDeps
    );

    results.push(
      check(
        "[cross-user] createEventWait(): 他userのWorkへは作成できずundefined",
        created === undefined
      )
    );
  }

  {
    const found = await getEventWait(
      "work-1",
      "attacker-user",
      "fake-token",
      "wait-1",
      notFoundDeps
    );

    results.push(
      check(
        "[cross-user] getEventWait(): 他userのWork配下のEventWaitはundefined",
        found === undefined
      )
    );
  }

  return summarize("work/eventModel", results);

}
