// =========================
// TACT Event — Begin Event Wait (EVENT-P1c)
// =========================
//
// Section8「Event Before Wait」の入口。core/tact-work/store.tsの
// createEventWaitAndReconcile()(tact_create_event_waitのRPC wrapper、
// Task pending→waiting_for_eventの遷移とEventWait作成・既に"received"
// なExternalEventとの照合を単一transactionで行う)を呼び、その
// reconciliationが偶然その場でwait_claimedを返した場合は、通常の
// event到着経路(core/tact-event/resume.tsのresumeClaimedEventWait())
// と全く同じcanonical resume seamへそのまま接続する——「wait作成の
// タイミングで既に届いていたeventによるresume」と「wait作成後に届いた
// eventによるresume」が、Task/Runから見て区別のつかない、常に同じ
// 1つの経路を通ることを保証する(新しい第2のresume経路を作らない)。

import {
  createEventWaitAndReconcile,
  type CreateEventWaitAndReconcileParams,
} from "../tact-work/store";
import {
  resumeClaimedEventWait,
  type EventResumeOutcome,
  type ResumeClaimedEventWaitDeps,
} from "./resume";

export type BeginEventWaitOutcome =
  | {
      status: "wait_created";
      waitId: string;
      taskId: string;
      workId: string;
      // wait作成と同一transaction内での照合結果がwait_claimed以外
      // だった場合(候補0件/複数件、またはそもそも該当なし)、resumeは
      // 一切試みられない(undefinedのまま)——通常のevent到着を待つ。
      resume?: EventResumeOutcome;
    }
  | { status: "task_not_found" }
  | { status: "wait_task_not_resumable"; reason: string; taskStatus?: string }
  | { status: "wait_work_terminal"; workStatus?: string };

export interface BeginEventWaitDeps {

  createEventWaitAndReconcile: typeof createEventWaitAndReconcile;

  resumeClaimedEventWait: (
    workId: string,
    taskId: string,
    userId: string,
    accessToken: string,
    eventWaitId: string,
    externalEventId: string,
    deps?: ResumeClaimedEventWaitDeps
  ) => ReturnType<typeof resumeClaimedEventWait>;

}

const defaultBeginEventWaitDeps: BeginEventWaitDeps = {
  createEventWaitAndReconcile,
  resumeClaimedEventWait,
};

export async function beginEventWait(
  workId: string,
  userId: string,
  accessToken: string,
  params: CreateEventWaitAndReconcileParams,
  deps: BeginEventWaitDeps = defaultBeginEventWaitDeps
): Promise<BeginEventWaitOutcome> {

  const outcome = await deps.createEventWaitAndReconcile(accessToken, params);

  if (outcome.status === "task_not_found") {
    return { status: "task_not_found" };
  }

  if (outcome.status === "wait_task_not_resumable") {
    return { status: "wait_task_not_resumable", reason: outcome.reason, taskStatus: outcome.taskStatus };
  }

  if (outcome.status === "wait_work_terminal") {
    return { status: "wait_work_terminal", workStatus: outcome.workStatus };
  }

  // outcome.status === "wait_created"。
  if (outcome.reconciliation.status !== "wait_claimed") {
    return { status: "wait_created", waitId: outcome.waitId, taskId: outcome.taskId, workId: outcome.workId };
  }

  // wait作成と同一transaction内で、既に"received"だったExternalEventが
  // 即座にclaimされた(Section8)。既存のcanonical resume seamへ
  // そのまま接続する——通常のevent到着経路と全く同じ関数呼び出し。
  const resume = await deps.resumeClaimedEventWait(
    workId,
    outcome.taskId,
    userId,
    accessToken,
    outcome.reconciliation.waitId,
    outcome.reconciliation.eventId
  );

  return { status: "wait_created", waitId: outcome.waitId, taskId: outcome.taskId, workId: outcome.workId, resume };

}
