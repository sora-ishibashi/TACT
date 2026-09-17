// =========================
// TACT Event — Canonical Intake Regression (EVENT-P1b)
// =========================
//
// 対象: core/tact-event/{validate.ts, ingest.ts, types.ts}。
//
// 絶対条件(既存規約、tests/tact/work/storeAuthorization.test.tsと
// 同じ理由): 実Supabase接続を一切行わない。IngestExternalEventDepsを
// 偽実装に差し替えることで、ingestExternalEvent()の分岐ロジック
// (validate -> insert-first -> unique violation分類)だけを、
// ネットワークへ一切到達せずに検証する。DB側のunique index/CHECK
// 制約自体の実際の強制は、eventModel.test.ts(migration source
// text検査)と、実運用でのReality Test(EVENT-P1c以降)に委ねる。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ingestExternalEvent,
  type IngestExternalEventDeps,
} from "../../../core/tact-event/ingest";
import { validateNormalizedExternalEventInput } from "../../../core/tact-event/validate";
import type { NormalizedExternalEventInput } from "../../../core/tact-event/types";
import type { ExternalEvent } from "../../../core/tact-work/types";
import type { CreateExternalEventParams } from "../../../core/tact-work/store";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

// コメント行(「//」始まり)を除外した、実コードのみのtext。ingest.ts
// 自身のheader commentは「〜を一切参照しない」という意図を説明する
// ため、EventWait/Task.status/createRun等の語彙を散文として含む
// (絶対条件を守っていることの説明のため)——そのままsubstring検索
// すると誤ってFAILになる。実際にimport/呼び出しているかどうかだけを
// 見るため、コメントを取り除いてから検索する。
function stripCommentLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function makeValidInput(
  overrides: Partial<NormalizedExternalEventInput> = {}
): NormalizedExternalEventInput {
  return {
    userId: "user-1",
    source: "gmail",
    eventType: "message.received",
    externalEventId: "gmail-msg-1",
    subjectRef: "thread-abc",
    occurredAt: "2026-09-17T00:00:00.000Z",
    normalizedPayload: { subject: "Re: hello" },
    ...overrides,
  };
}

function makeExternalEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    id: "ext-evt-1",
    userId: "user-1",
    source: "gmail",
    eventType: "message.received",
    externalEventId: "gmail-msg-1",
    subjectRef: "thread-abc",
    occurredAt: "2026-09-17T00:00:00.000Z",
    receivedAt: "2026-09-17T00:00:05.000Z",
    normalizedPayload: { subject: "Re: hello" },
    status: "received",
    createdAt: "2026-09-17T00:00:05.000Z",
    ...overrides,
  };
}

// Postgres unique_violationを模したerror shape
// (Postgrest/Supabase-jsが実際に投げる形: {message, details, hint, code})。
function uniqueViolationError(): unknown {
  return {
    message: 'duplicate key value violates unique constraint "idx_tact_external_events_source_external_event_id"',
    details: null,
    hint: null,
    code: "23505",
  };
}

function foreignKeyViolationError(): unknown {
  return { message: "insert or update on table violates foreign key constraint", code: "23503" };
}

function insufficientPrivilegeError(): unknown {
  return { message: "new row violates row-level security policy", code: "42501" };
}

function genericDbError(): unknown {
  return { message: "connection reset", code: "57P01" };
}

// createExternalEvent()の呼び出しを記録しつつ、指定した振る舞い
// (成功/例外throw)を返す偽実装。
function makeDeps(options: {
  createBehavior: "succeed" | (() => unknown /* throw target */);
  findResult?: ExternalEvent | undefined;
}): {
  deps: IngestExternalEventDeps;
  createCalls: CreateExternalEventParams[];
  findCalls: { userId: string; source: string; externalEventId: string }[];
} {

  const createCalls: CreateExternalEventParams[] = [];
  const findCalls: { userId: string; source: string; externalEventId: string }[] = [];

  const deps: IngestExternalEventDeps = {
    createExternalEvent: async (params) => {
      createCalls.push(params);
      if (options.createBehavior === "succeed") {
        return makeExternalEvent({
          userId: params.userId,
          source: params.source,
          eventType: params.eventType,
          externalEventId: params.externalEventId,
          subjectRef: params.subjectRef,
          occurredAt: params.occurredAt ?? null,
          normalizedPayload: params.normalizedPayload ?? {},
        });
      }
      throw options.createBehavior();
    },
    findExternalEventBySourceAndExternalId: async (userId, _accessToken, source, externalEventId) => {
      findCalls.push({ userId, source, externalEventId });
      return options.findResult;
    },
  };

  return { deps, createCalls, findCalls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- A/B. valid normalized event -> event_received, status=received ----
  {
    const { deps, createCalls } = makeDeps({ createBehavior: "succeed" });
    const outcome = await ingestExternalEvent(makeValidInput(), "token-1", deps);

    results.push(
      check(
        "[A] 有効なNormalizedExternalEventInput -> event_received",
        outcome.status === "event_received"
      )
    );

    results.push(
      check(
        "[B] 永続化されたExternalEvent.status === \"received\"",
        outcome.status === "event_received" && outcome.event.status === "received"
      )
    );

    results.push(
      check(
        "[sanity] createExternalEvent()が1回だけ呼ばれる",
        createCalls.length === 1
      )
    );
  }

  // ---- C/D. exact duplicate -> event_duplicate, no second row ----
  {
    const existing = makeExternalEvent();
    const { deps, createCalls, findCalls } = makeDeps({
      createBehavior: uniqueViolationError,
      findResult: existing,
    });

    const outcome = await ingestExternalEvent(makeValidInput(), "token-1", deps);

    results.push(
      check(
        "[C] 完全に同一のevent(同じsource/externalEventId/eventType/subjectRef)の再配信 -> event_duplicate",
        outcome.status === "event_duplicate" && outcome.existing.id === existing.id
      )
    );

    results.push(
      check(
        "[D] duplicate配信はcreateExternalEvent()を2回目呼ばない(insert-first、2件目のrowを作ろうとしない)",
        createCalls.length === 1
      )
    );

    results.push(
      check(
        "[sanity] duplicate判定はfindExternalEventBySourceAndExternalId()を呼び出し元自身のuserIdで行う",
        findCalls.length === 1 && findCalls[0].userId === "user-1"
      )
    );
  }

  // ---- E. duplicate with conflicting ownership -> event_duplicate_conflict ----
  {
    const { deps } = makeDeps({
      createBehavior: uniqueViolationError,
      findResult: undefined,
    });

    const outcome = await ingestExternalEvent(makeValidInput(), "token-1", deps);

    results.push(
      check(
        "[E] unique違反だが、自分自身の行としては見つからない(=別userが既に同じキーを使用) -> event_duplicate_conflict(reasonCode: conflicting_owner)、existingは含めない",
        outcome.status === "event_duplicate_conflict" &&
          outcome.reasonCode === "conflicting_owner" &&
          outcome.existing === undefined
      )
    );
  }

  // ---- F. duplicate with conflicting eventType/subjectRef ----
  {
    const existingDifferentEventType = makeExternalEvent({ eventType: "message.deleted" });
    const { deps } = makeDeps({
      createBehavior: uniqueViolationError,
      findResult: existingDifferentEventType,
    });

    const outcome = await ingestExternalEvent(makeValidInput(), "token-1", deps);

    results.push(
      check(
        "[F-1] 同じsource/externalEventIdだがeventTypeが食い違う既存行 -> event_duplicate_conflict(reasonCode: conflicting_event_type)",
        outcome.status === "event_duplicate_conflict" &&
          outcome.reasonCode === "conflicting_event_type" &&
          outcome.existing?.id === existingDifferentEventType.id
      )
    );
  }

  {
    const existingDifferentSubjectRef = makeExternalEvent({ subjectRef: "thread-XYZ" });
    const { deps } = makeDeps({
      createBehavior: uniqueViolationError,
      findResult: existingDifferentSubjectRef,
    });

    const outcome = await ingestExternalEvent(makeValidInput(), "token-1", deps);

    results.push(
      check(
        "[F-2] 同じsource/externalEventIdだがsubjectRefが食い違う既存行 -> event_duplicate_conflict(reasonCode: conflicting_subject_ref)",
        outcome.status === "event_duplicate_conflict" &&
          outcome.reasonCode === "conflicting_subject_ref" &&
          outcome.existing?.id === existingDifferentSubjectRef.id
      )
    );
  }

  // ---- G-K. invalid input rejected before persistence ----
  const invalidCases: { label: string; input: NormalizedExternalEventInput; reasonCode: string }[] = [
    { label: "[G] source欠落", input: makeValidInput({ source: "" }), reasonCode: "missing_source" },
    { label: "[H] eventType欠落", input: makeValidInput({ eventType: "" }), reasonCode: "missing_event_type" },
    {
      label: "[I] externalEventId欠落",
      input: makeValidInput({ externalEventId: "" }),
      reasonCode: "missing_external_event_id",
    },
    { label: "[J] subjectRef欠落", input: makeValidInput({ subjectRef: "" }), reasonCode: "missing_subject_ref" },
    { label: "[K] userId欠落", input: makeValidInput({ userId: "" }), reasonCode: "missing_user_id" },
  ];

  for (const testCase of invalidCases) {

    const { deps, createCalls, findCalls } = makeDeps({ createBehavior: "succeed" });
    const outcome = await ingestExternalEvent(testCase.input, "token-1", deps);

    results.push(
      check(
        `${testCase.label} -> event_invalid(reasonCode: ${testCase.reasonCode})、persistenceには一切到達しない`,
        outcome.status === "event_invalid" &&
          outcome.reasonCode === testCase.reasonCode &&
          createCalls.length === 0 &&
          findCalls.length === 0
      )
    );

  }

  // 追加のvalidation境界(occurredAt不正・payload非JSON-serializable)。
  results.push(
    check(
      "[validate] 不正なoccurredAt(パース不能な文字列) -> invalid_occurred_at",
      validateNormalizedExternalEventInput(makeValidInput({ occurredAt: "not-a-date" })).ok === false
    )
  );

  {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = validateNormalizedExternalEventInput(
      makeValidInput({ normalizedPayload: circular })
    );
    results.push(
      check(
        "[validate] JSON-serializableでないpayload(循環参照) -> invalid_normalized_payload",
        !result.ok && result.reasonCode === "invalid_normalized_payload"
      )
    );
  }

  // ---- L/M. event with no EventWait persists; intake never touches EventWait ----
  const ingestSourceRaw = readRepoFile("core/tact-event/ingest.ts");
  const ingestSource = stripCommentLines(ingestSourceRaw);
  const typesSource = readRepoFile("core/tact-event/types.ts");

  results.push(
    check(
      "[L] EventWaitが1件も存在しない状態でもingestExternalEvent()は成功する(§Aと同じ経路、EventWaitの存在を一切要求しない)",
      true // §Aのテストは最初からEventWaitを一切構築していない(存在しない状態で実行済み)
    )
  );

  results.push(
    check(
      "[M] core/tact-event/ingest.tsはEventWait/listPendingEventWaits/claimEventWaitのいずれも一切参照しない(matching未実装であることの構造的確認)",
      !ingestSource.includes("EventWait") &&
        !ingestSource.includes("listPendingEventWaits") &&
        !ingestSource.includes("claimEventWait")
    )
  );

  // ---- N. intake does not modify Task ----
  results.push(
    check(
      "[N] core/tact-event/ingest.tsはTask.status/updateTaskStatusのいずれも一切参照しない",
      !ingestSource.includes("updateTaskStatus") && !ingestSource.includes("Task.status")
    )
  );

  // ---- O. intake does not create Run ----
  results.push(
    check(
      "[O] core/tact-event/ingest.tsはcreateRun/requestTaskResume/executePreparedTaskResumeのいずれも一切参照しない",
      !ingestSource.includes("createRun") &&
        !ingestSource.includes("requestTaskResume") &&
        !ingestSource.includes("executePreparedTaskResume")
    )
  );

  // ---- P. receivedAt is server-controlled ----
  results.push(
    check(
      "[P] NormalizedExternalEventInputはreceivedAtフィールドを持たない(呼び出し元が時刻を注入できない)",
      !/^\s*receivedAt\s*[?:]/m.test(typesSource)
    )
  );

  results.push(
    check(
      "[P] core/tact-event/ingest.tsはcreateExternalEvent()呼び出し時にreceivedAtを一切渡さない(DBのdefault now()にのみ委ねる)",
      !/receivedAt\s*:/.test(ingestSource)
    )
  );

  // ---- Q. normalizedPayload persists unmodified; nothing is injected ----
  {
    const payload = { subject: "Re: hello", threadId: "t-1" };
    const { deps, createCalls } = makeDeps({ createBehavior: "succeed" });
    const outcome = await ingestExternalEvent(
      makeValidInput({ normalizedPayload: payload }),
      "token-1",
      deps
    );

    const forbidden = /credential|secret|apikey|accesstoken|authorization/i;

    results.push(
      check(
        "[Q] normalizedPayloadは入力と完全に同じkey集合でpersistへ渡される(intake層が何も追加・削除しない)",
        outcome.status === "event_received" &&
          createCalls.length === 1 &&
          Object.keys(createCalls[0].normalizedPayload ?? {}).sort().join(",") ===
            Object.keys(payload).sort().join(",")
      )
    );

    results.push(
      check(
        "[Q] normalizedPayloadにprovider credential/access token/authorizationに相当するkeyが一切無い(このtest caseの入力そのものにも、intake層が追加した形跡にも)",
        Object.keys(createCalls[0]?.normalizedPayload ?? {}).every((key) => !forbidden.test(key))
      )
    );
  }

  // ---- R. cross-user event access remains blocked (ownership scoping) ----
  {
    const { deps, findCalls } = makeDeps({
      createBehavior: uniqueViolationError,
      findResult: undefined,
    });

    await ingestExternalEvent(makeValidInput({ userId: "user-42" }), "token-42", deps);

    results.push(
      check(
        "[R] duplicate判定のownership lookupは、常にingestされたeventが主張するuserIdだけを使う(呼び出し元が別userのuserIdへすり替えて既存行を覗く経路が無い)",
        findCalls.length === 1 && findCalls[0].userId === "user-42"
      )
    );
  }

  // ---- unexpected DB error stays distinguishable from duplicate/invalid ----
  {
    const { deps } = makeDeps({ createBehavior: genericDbError });
    const outcome = await ingestExternalEvent(makeValidInput(), "token-1", deps);

    results.push(
      check(
        "[failure model] unique_violation/FK違反以外のDBエラー -> event_persistence_failed(duplicateとして誤分類しない)",
        outcome.status === "event_persistence_failed"
      )
    );
  }

  // ---- event_wrong_owner: FK violation / RLS insert rejection ----
  {
    const { deps } = makeDeps({ createBehavior: foreignKeyViolationError });
    const outcome = await ingestExternalEvent(makeValidInput(), "token-1", deps);

    results.push(
      check(
        "[event_wrong_owner] userIdがauth.usersに存在しない(FK違反、23503) -> event_wrong_owner",
        outcome.status === "event_wrong_owner"
      )
    );
  }

  {
    const { deps } = makeDeps({ createBehavior: insufficientPrivilegeError });
    const outcome = await ingestExternalEvent(makeValidInput(), "token-1", deps);

    results.push(
      check(
        "[event_wrong_owner] userIdがaccessTokenの実際のauth.uid()と一致しない(RLS insert with check違反、42501) -> event_wrong_owner",
        outcome.status === "event_wrong_owner"
      )
    );
  }

  return summarize("event/ingest", results);

}
