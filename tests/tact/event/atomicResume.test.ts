// =========================
// TACT Event — Atomic Match + Durable Resume Orchestration Regression
// (EVENT-P1c)
// =========================
//
// 対象: core/tact-event/{resume.ts, wait.ts, flow.ts}。
//
// 絶対条件(既存規約、tests/tact/event/ingest.test.tsと同じ理由):
// 実Supabase接続を一切行わない。全DepsをDIで偽実装に差し替え、
// resumeClaimedEventWait()/reconcileClaimedEventWait()/beginEventWait()/
// processExternalEventArrival()の分岐ロジックだけを検証する。
// core/tact-work/resume.ts自身のeligibility/correlation判定ロジックの
// 詳細はtests/tact/work/resume.test.tsで、EVENT-P1bのingest判定は
// tests/tact/event/ingest.test.tsで、SQL functionの構造的性質は
// tests/tact/work/eventWaitClaim.test.tsで既に検証済みのため、ここでは
// 「正しい入力で正確に、既存の各piece(requestTaskResume/
// executePreparedTaskResume/ingestExternalEvent/matchAndClaimExternalEvent)
// へ委譲されるか」だけを確認する(二重テストを避ける)。

import {
  resumeClaimedEventWait,
  reconcileClaimedEventWait,
  type EventResumeOutcome,
  type ResumeClaimedEventWaitDeps,
  type ReconcileClaimedEventWaitDeps,
} from "../../../core/tact-event/resume";
import { beginEventWait, type BeginEventWaitDeps } from "../../../core/tact-event/wait";
import { processExternalEventArrival, type ProcessExternalEventArrivalDeps } from "../../../core/tact-event/flow";
import type { TaskResumeRequestOutcome } from "../../../core/tact-work/resume";
import type { TaskResumeExecutionOutcome } from "../../../core/tact-conversation/orchestration";
import type { EventWait, ExternalEvent, CreateEventWaitOutcome, EventWaitClaimOutcome } from "../../../core/tact-work/types";
import type { EventIngestOutcome, NormalizedExternalEventInput } from "../../../core/tact-event/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";

function makeEventWait(overrides: Partial<EventWait> = {}): EventWait {
  return {
    id: "wait-1",
    userId: OWNER_USER_ID,
    workId: "work-1",
    taskId: "task-1",
    expectedSource: "gmail",
    expectedEventType: "message.received",
    subjectRef: "thread-abc",
    status: "claimed",
    createdAt: "2026-09-17T00:00:00.000Z",
    claimedByEventId: "ext-evt-1",
    ...overrides,
  };
}

function makeExternalEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    id: "ext-evt-1",
    userId: OWNER_USER_ID,
    source: "gmail",
    eventType: "message.received",
    externalEventId: "gmail-msg-1",
    subjectRef: "thread-abc",
    receivedAt: "2026-09-17T00:00:00.000Z",
    normalizedPayload: {},
    status: "received",
    createdAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

// ---- resumeClaimedEventWait() ----

interface MakeResumeSeamDepsOptions {
  requestOutcome?: TaskResumeRequestOutcome;
  executionOutcome?: TaskResumeExecutionOutcome;
  requestThrows?: unknown;
  executionThrows?: unknown;
}

function makeResumeSeamDeps(options: MakeResumeSeamDepsOptions = {}) {

  const calls = { requestTaskResumeCalls: [] as unknown[], executePreparedTaskResumeCalls: [] as unknown[] };

  const deps: ResumeClaimedEventWaitDeps = {

    requestTaskResume: async (params) => {
      calls.requestTaskResumeCalls.push(params);
      if (options.requestThrows) throw options.requestThrows;
      return options.requestOutcome ?? {
        status: "prepared",
        intent: {
          workId: params.workId,
          taskId: params.taskId,
          reason: params.reason,
          eventWaitId: params.eventWaitId,
          externalEventId: params.externalEventId,
          eligibleAt: "2026-09-17T00:00:00.000Z",
        },
      };
    },

    executePreparedTaskResume: async (params) => {
      calls.executePreparedTaskResumeCalls.push(params);
      if (options.executionThrows) throw options.executionThrows;
      return options.executionOutcome ?? { status: "write_executed", outcome: { status: "completed", run: {} as never } };
    },

  };

  return { deps, calls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- resumeClaimedEventWait() ----

  {
    const { deps, calls } = makeResumeSeamDeps();

    const outcome = await resumeClaimedEventWait("work-1", "task-1", OWNER_USER_ID, "token", "wait-1", "ext-evt-1", deps);

    const call = calls.requestTaskResumeCalls[0] as { reason: string; eventWaitId: string; externalEventId: string };

    results.push(
      check(
        "[resumeClaimedEventWait] 成功経路: requestTaskResume()にreason=external_event_matched・eventWaitId/externalEventIdを渡し、prepared -> executePreparedTaskResume()へ委譲し、resumedを返す",
        outcome.status === "resumed" &&
          call.reason === "external_event_matched" &&
          call.eventWaitId === "wait-1" &&
          call.externalEventId === "ext-evt-1" &&
          calls.executePreparedTaskResumeCalls.length === 1
      )
    );
  }

  {
    const { deps, calls } = makeResumeSeamDeps({
      requestOutcome: { status: "blocked", reasonCode: "pending_approval_exists" },
    });

    const outcome = await resumeClaimedEventWait("work-1", "task-1", OWNER_USER_ID, "token", "wait-1", "ext-evt-1", deps);

    results.push(
      check(
        "[resumeClaimedEventWait] requestTaskResume()がblocked -> resume_blocked(同じreasonCode)、executePreparedTaskResume()へは進まない",
        outcome.status === "resume_blocked" &&
          (outcome as { reasonCode: string }).reasonCode === "pending_approval_exists" &&
          calls.executePreparedTaskResumeCalls.length === 0
      )
    );
  }

  {
    const { deps } = makeResumeSeamDeps({
      requestOutcome: { status: "already_terminal", reasonCode: "task_completed" },
    });

    const outcome = await resumeClaimedEventWait("work-1", "task-1", OWNER_USER_ID, "token", "wait-1", "ext-evt-1", deps);

    results.push(
      check(
        "[resumeClaimedEventWait] requestTaskResume()がalready_terminal -> resume_already_terminal",
        outcome.status === "resume_already_terminal" && (outcome as { reasonCode: string }).reasonCode === "task_completed"
      )
    );
  }

  {
    const { deps } = makeResumeSeamDeps({ executionOutcome: { status: "concurrent_resume_detected" } });

    const outcome = await resumeClaimedEventWait("work-1", "task-1", OWNER_USER_ID, "token", "wait-1", "ext-evt-1", deps);

    results.push(
      check(
        "[resumeClaimedEventWait][Section15] executePreparedTaskResume()がconcurrent_resume_detected -> resume_concurrent(既存exactly-one Run機構をそのまま透過)",
        outcome.status === "resume_concurrent"
      )
    );
  }

  {
    const { deps } = makeResumeSeamDeps({
      executionOutcome: { status: "not_eligible", reasonCode: "external_event_not_matched" },
    });

    const outcome = await resumeClaimedEventWait("work-1", "task-1", OWNER_USER_ID, "token", "wait-1", "ext-evt-1", deps);

    results.push(
      check(
        "[resumeClaimedEventWait] executePreparedTaskResume()自身の独立した再検証がnot_eligibleを返した場合もresume_blockedへ正規化する",
        outcome.status === "resume_blocked" && (outcome as { reasonCode: string }).reasonCode === "external_event_not_matched"
      )
    );
  }

  {
    const { deps } = makeResumeSeamDeps({ requestThrows: new Error("network reset") });

    const outcome = await resumeClaimedEventWait("work-1", "task-1", OWNER_USER_ID, "token", "wait-1", "ext-evt-1", deps);

    results.push(
      check(
        "[resumeClaimedEventWait][Section10] 予期しない例外(claim成立後のresume失敗) -> resume_failed_after_claim(errorを投げっぱなしにしない、永続失敗stateも作らない)",
        outcome.status === "resume_failed_after_claim" && (outcome as { error: string }).error.includes("network reset")
      )
    );
  }

  // ---- reconcileClaimedEventWait() ----

  {
    const { deps: seamDeps } = makeResumeSeamDeps();
    const deps: ReconcileClaimedEventWaitDeps = { ...seamDeps, getEventWait: async () => undefined };

    const outcome = await reconcileClaimedEventWait("work-1", OWNER_USER_ID, "token", "wait-1", deps);

    results.push(check("[reconcileClaimedEventWait] EventWaitが見つからない -> wait_not_found", outcome.status === "wait_not_found"));
  }

  {
    const { deps: seamDeps } = makeResumeSeamDeps();
    const deps: ReconcileClaimedEventWaitDeps = {
      ...seamDeps,
      getEventWait: async () => makeEventWait({ status: "pending" }),
    };

    const outcome = await reconcileClaimedEventWait("work-1", OWNER_USER_ID, "token", "wait-1", deps);

    results.push(
      check(
        "[reconcileClaimedEventWait] EventWait.status!=='claimed'(pending) -> wait_not_claimed(idempotent-safe、errorではない)",
        outcome.status === "wait_not_claimed" && (outcome as { waitStatus: string }).waitStatus === "pending"
      )
    );
  }

  {
    const { deps: seamDeps } = makeResumeSeamDeps();
    const deps: ReconcileClaimedEventWaitDeps = {
      ...seamDeps,
      getEventWait: async () => makeEventWait({ claimedByEventId: null }),
    };

    const outcome = await reconcileClaimedEventWait("work-1", OWNER_USER_ID, "token", "wait-1", deps);

    results.push(
      check(
        "[reconcileClaimedEventWait] claimed済みだがclaimedByEventIdが欠落(構造的には起こらないはずの異常系) -> wait_missing_claim_reference、fail closed",
        outcome.status === "wait_missing_claim_reference"
      )
    );
  }

  {
    const { deps: seamDeps, calls } = makeResumeSeamDeps();
    const deps: ReconcileClaimedEventWaitDeps = {
      ...seamDeps,
      getEventWait: async () => makeEventWait({ taskId: "task-42", claimedByEventId: "ext-evt-99" }),
    };

    const outcome = await reconcileClaimedEventWait("work-1", OWNER_USER_ID, "token", "wait-1", deps);

    const call = calls.requestTaskResumeCalls[0] as { taskId: string; eventWaitId: string; externalEventId: string };

    results.push(
      check(
        "[reconcileClaimedEventWait] claimed済み・claimedByEventIdあり -> resumeClaimedEventWait()と同じ経路へ、wait由来のtaskId/eventWaitId/externalEventIdをそのまま使う",
        outcome.status === "resumed" &&
          call.taskId === "task-42" &&
          call.eventWaitId === "wait-1" &&
          call.externalEventId === "ext-evt-99"
      )
    );
  }

  // ---- beginEventWait() ----

  function makeBeginEventWaitDeps(
    createOutcome: CreateEventWaitOutcome,
    resumeOutcome?: EventResumeOutcome
  ): { deps: BeginEventWaitDeps; resumeCalls: unknown[] } {

    const resumeCalls: unknown[] = [];

    const deps: BeginEventWaitDeps = {
      createEventWaitAndReconcile: async () => createOutcome,
      resumeClaimedEventWait: async (...args) => {
        resumeCalls.push(args);
        return resumeOutcome ?? { status: "resumed", execution: { status: "write_executed", outcome: { status: "completed", run: {} as never } } };
      },
    };

    return { deps, resumeCalls };

  }

  {
    const { deps, resumeCalls } = makeBeginEventWaitDeps({ status: "task_not_found" });

    const outcome = await beginEventWait("work-1", OWNER_USER_ID, "token", {
      taskId: "task-1", expectedSource: "gmail", expectedEventType: "message.received", subjectRef: "thread-abc",
    }, deps);

    results.push(
      check("[beginEventWait] task_not_found -> そのまま透過、resumeは一切試みない", outcome.status === "task_not_found" && resumeCalls.length === 0)
    );
  }

  {
    const { deps, resumeCalls } = makeBeginEventWaitDeps({
      status: "wait_created", waitId: "wait-1", taskId: "task-1", workId: "work-1",
      reconciliation: { status: "event_unmatched" },
    });

    const outcome = await beginEventWait("work-1", OWNER_USER_ID, "token", {
      taskId: "task-1", expectedSource: "gmail", expectedEventType: "message.received", subjectRef: "thread-abc",
    }, deps);

    results.push(
      check(
        "[beginEventWait][Section8] wait作成時点でreconciliationがevent_unmatched -> wait_createdのみ、resumeは試みない(通常のevent到着を待つ)",
        outcome.status === "wait_created" && !("resume" in outcome) && resumeCalls.length === 0
      )
    );
  }

  {
    const { deps, resumeCalls } = makeBeginEventWaitDeps({
      status: "wait_created", waitId: "wait-1", taskId: "task-1", workId: "work-1",
      reconciliation: { status: "wait_claimed", eventId: "ext-evt-1", waitId: "wait-1", taskId: "task-1", workId: "work-1" },
    });

    const outcome = await beginEventWait("work-1", OWNER_USER_ID, "token", {
      taskId: "task-1", expectedSource: "gmail", expectedEventType: "message.received", subjectRef: "thread-abc",
    }, deps);

    results.push(
      check(
        "[beginEventWait][Section8] wait作成と同一transaction内でwait_claimedになった場合、通常のevent到着と同じresumeClaimedEventWait()経路へ接続する(新しい第2のresume経路を作らない)",
        outcome.status === "wait_created" && "resume" in outcome && resumeCalls.length === 1
      )
    );
  }

  // ---- processExternalEventArrival() ----

  function makeFlowDeps(options: {
    ingestOutcome: EventIngestOutcome;
    matchOutcome?: EventWaitClaimOutcome;
    resumeOutcome?: EventResumeOutcome;
  }) {

    const calls = { matchCalls: [] as unknown[], resumeCalls: [] as unknown[] };

    const deps: ProcessExternalEventArrivalDeps = {
      ingestExternalEvent: async () => options.ingestOutcome,
      matchAndClaimExternalEvent: async (accessToken, externalEventId) => {
        calls.matchCalls.push({ accessToken, externalEventId });
        return options.matchOutcome ?? { status: "event_unmatched" };
      },
      resumeClaimedEventWait: async (...args) => {
        calls.resumeCalls.push(args);
        return options.resumeOutcome ?? { status: "resumed", execution: { status: "write_executed", outcome: { status: "completed", run: {} as never } } };
      },
    };

    return { deps, calls };

  }

  const SAMPLE_INPUT: NormalizedExternalEventInput = {
    userId: OWNER_USER_ID,
    source: "gmail",
    eventType: "message.received",
    externalEventId: "gmail-msg-1",
    subjectRef: "thread-abc",
  };

  {
    const { deps, calls } = makeFlowDeps({ ingestOutcome: { status: "event_invalid", reasonCode: "missing_source" } });

    const outcome = await processExternalEventArrival(SAMPLE_INPUT, "token", deps);

    results.push(
      check(
        "[processExternalEventArrival] ingestが失敗(event_invalid) -> not_ingested、matchingを一切試みない",
        outcome.status === "not_ingested" && calls.matchCalls.length === 0
      )
    );
  }

  {
    const event = makeExternalEvent();
    const { deps, calls } = makeFlowDeps({
      ingestOutcome: { status: "event_received", event },
      matchOutcome: { status: "event_unmatched" },
    });

    const outcome = await processExternalEventArrival(SAMPLE_INPUT, "token", deps);

    results.push(
      check(
        "[processExternalEventArrival] event_received + event_unmatched -> processed、resumeは試みない",
        outcome.status === "processed" && !("resume" in outcome) && calls.resumeCalls.length === 0
      )
    );
  }

  {
    const event = makeExternalEvent();
    const { deps, calls } = makeFlowDeps({
      ingestOutcome: { status: "event_received", event },
      matchOutcome: { status: "wait_claimed", eventId: event.id, waitId: "wait-1", taskId: "task-1", workId: "work-1" },
    });

    const outcome = await processExternalEventArrival(SAMPLE_INPUT, "token", deps);

    results.push(
      check(
        "[processExternalEventArrival][Section9] event_received + wait_claimed -> resumeClaimedEventWait()へ接続し、processed + resumeを返す",
        outcome.status === "processed" && "resume" in outcome && calls.resumeCalls.length === 1
      )
    );
  }

  {
    // Section9絶対条件: event_duplicateの場合も、新しいExternalEvent行を
    // 作らず、既存のexisting eventのidでmatchingを再試行する。
    const existing = makeExternalEvent({ id: "existing-evt-1" });
    const { deps, calls } = makeFlowDeps({
      ingestOutcome: { status: "event_duplicate", existing },
      matchOutcome: { status: "event_unmatched" },
    });

    const outcome = await processExternalEventArrival(SAMPLE_INPUT, "token", deps);

    const call = calls.matchCalls[0] as { externalEventId: string };

    results.push(
      check(
        "[processExternalEventArrival][Section9] event_duplicateでも、既存eventのidでmatchAndClaimExternalEvent()を呼ぶ(新しいExternalEvent行を作らず、reconciliationをやり直す)",
        outcome.status === "processed" && call.externalEventId === "existing-evt-1"
      )
    );
  }

  {
    const { deps, calls } = makeFlowDeps({
      ingestOutcome: { status: "event_duplicate_conflict", reasonCode: "conflicting_owner" },
    });

    const outcome = await processExternalEventArrival(SAMPLE_INPUT, "token", deps);

    results.push(
      check(
        "[processExternalEventArrival] event_duplicate_conflictは有効なeventを指さないため、matchingを一切試みない",
        outcome.status === "not_ingested" && calls.matchCalls.length === 0
      )
    );
  }

  return summarize("event/atomicResume", results);

}
