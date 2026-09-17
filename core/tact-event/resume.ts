// =========================
// TACT Event — Resume Seam Integration (EVENT-P1c)
// =========================
//
// このfileが「する」こと: すでにatomicにclaim済みのEventWait
// (tact_event_waits.status="claimed"、supabase/migrations/
// 20261016010000_create_event_wait_claim_functions.sqlのtransaction
// によってTaskは既にwaiting_for_event→pendingへ遷移済み)を、既存の
// canonical resume seam(core/tact-work/resume.tsのrequestTaskResume()
// → core/tact-conversation/orchestration.tsのexecutePreparedTaskResume()
// → core/tact-integration/execution.tsのprepareRunForExecution() →
// createRun())へそのまま渡すだけ。
//
// このfileが「しない」こと(絶対条件、Section2/5/25):
//   - Task状態のmutation(waiting_for_event→pendingは既にRPC
//     transactionで完了済み——ここでは一切Task/EventWait/ExternalEvent
//     のUPDATEを行わない、read-onlyなgetEventWait()以外のDBアクセスは
//     持たない)
//   - Run作成(既存executePreparedTaskResume()の内部に完全に委ねる、
//     新しい実行境界を作らない)
//   - provider実行の直接呼び出し
//
// 依存方向についての注記: core/tact-event/はcore/tact-work/
// (requestTaskResume()・getEventWait())に加えて、core/tact-conversation/
// (executePreparedTaskResume())にも依存する——これは新しい依存方向
// だが、"existing canonical resume seam"の実体(executePreparedTaskResume())
// がcore/tact-work/ではなくcore/tact-conversation/orchestration.tsに
// 存在するために必要な依存であり(P6bで、Approval/Policy/Runtime
// routingという既存core/tact-integration/依存を持つ実行境界と同じ
// fileに置かれた)、EVENT-P1c自身が新しい実行境界を作る代わりに
// 既存のそれをそのまま再利用していることの、依存グラフ上の反映
// にすぎない。逆方向(core/tact-conversation → core/tact-event)の
// importはこのphaseでは一切追加しない(循環依存無し)。

import { getEventWait } from "../tact-work/store";
import {
  requestTaskResume,
  type TaskResumeEligibilityBlockedReasonCode,
  type TaskResumeTerminalReasonCode,
  type ExternalEventResumeCorrelationBlockedReasonCode,
} from "../tact-work/resume";
import {
  executePreparedTaskResume,
  type TaskResumeExecutionOutcome,
} from "../tact-conversation/orchestration";
import type { EventWaitStatus } from "../tact-work/types";

// =========================
// EventResumeOutcome (Section22)
// =========================

export type EventResumeOutcome =
  | { status: "resumed"; execution: TaskResumeExecutionOutcome }
  | {
      status: "resume_blocked";
      reasonCode: TaskResumeEligibilityBlockedReasonCode | ExternalEventResumeCorrelationBlockedReasonCode;
    }
  | { status: "resume_already_terminal"; reasonCode: TaskResumeTerminalReasonCode }
  | { status: "resume_concurrent" }
  // Section10「Claimed Wait Crash Recovery」がまさに対象とするケース:
  // claim(EventWait claimed済み)は既に成立しているが、resume自体が
  // 予期しない理由で失敗した(ネットワーク断等)。呼び出し元は
  // reconcileClaimedEventWait()を後で再試行できる——resume_failed_
  // after_claimは永続stateではなく、この1回の呼び出しの結果を表す
  // だけの値(絶対条件Section10「Do NOT add: resume_failed persistent
  // state」)。
  | { status: "resume_failed_after_claim"; error: string };

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

export interface ResumeClaimedEventWaitDeps {

  requestTaskResume: typeof requestTaskResume;

  executePreparedTaskResume: typeof executePreparedTaskResume;

}

const defaultResumeClaimedEventWaitDeps: ResumeClaimedEventWaitDeps = {
  requestTaskResume,
  executePreparedTaskResume,
};

// Section2「Existing Resume Pipeline」・Section11「Resume Intent」を
// そのまま実行する。claim(atomic transaction)が既に成立していること
// ——EventWait.status="claimed"・Task.status="pending"——を前提とする
// (このfile自身はその前提を作らない、呼び出し元がmatchAndClaim
// ExternalEvent()の"wait_claimed"結果を受けて呼ぶ、またはcrash
// recoveryとしてreconcileClaimedEventWait()経由で呼ぶ)。
export async function resumeClaimedEventWait(
  workId: string,
  taskId: string,
  userId: string,
  accessToken: string,
  eventWaitId: string,
  externalEventId: string,
  deps: ResumeClaimedEventWaitDeps = defaultResumeClaimedEventWaitDeps
): Promise<EventResumeOutcome> {

  try {

    // 絶対条件(resume.ts自身の設計原則を継承): 「claim済みである」
    // ことをこの呼び出し自身が信用せず、requestTaskResume()に
    // durable correlationの再検証(core/tact-work/resume.tsの
    // validateExternalEventResumeCorrelation())を必ず通させる
    // ——この関数はcorrelationを自分で検証しない、既存の唯一の
    // canonical検証実装へ委ねる。
    const requestOutcome = await deps.requestTaskResume({
      workId,
      userId,
      accessToken,
      taskId,
      reason: "external_event_matched",
      eventWaitId,
      externalEventId,
    });

    if (requestOutcome.status === "blocked") {
      return { status: "resume_blocked", reasonCode: requestOutcome.reasonCode };
    }

    if (requestOutcome.status === "already_terminal") {
      return { status: "resume_already_terminal", reasonCode: requestOutcome.reasonCode };
    }

    // requestOutcome.status === "prepared"。executePreparedTaskResume()
    // 自身も、prepared intentを信用せずeligibility/correlationを
    // 独立に再確認する(Section11「At BOTH」、二重の再検証)。
    const executionOutcome = await deps.executePreparedTaskResume({
      intent: requestOutcome.intent,
      userId,
      accessToken,
    });

    if (executionOutcome.status === "concurrent_resume_detected") {
      return { status: "resume_concurrent" };
    }

    if (executionOutcome.status === "not_eligible") {
      return { status: "resume_blocked", reasonCode: executionOutcome.reasonCode };
    }

    if (executionOutcome.status === "already_terminal") {
      return { status: "resume_already_terminal", reasonCode: executionOutcome.reasonCode };
    }

    return { status: "resumed", execution: executionOutcome };

  } catch (error) {

    return { status: "resume_failed_after_claim", error: describeError(error) };

  }

}

export interface ReconcileClaimedEventWaitDeps extends ResumeClaimedEventWaitDeps {

  getEventWait: typeof getEventWait;

}

const defaultReconcileClaimedEventWaitDeps: ReconcileClaimedEventWaitDeps = {
  ...defaultResumeClaimedEventWaitDeps,
  getEventWait,
};

export type ReconcileClaimedEventWaitOutcome =
  | EventResumeOutcome
  | { status: "wait_not_found" }
  | { status: "wait_not_claimed"; waitStatus: EventWaitStatus }
  | { status: "wait_missing_claim_reference" };

// Section10「Claimed Wait Crash Recovery」: transactionは既にcommit済み
// (ExternalEvent=matched、EventWait=claimed、Task=pending)だが、
// プロセスがRun作成前にcrashした場合に、既存canonical resume seamへ
// 再突入するための narrow function。新しいpersistent失敗state・
// outbox・cron/pollerは一切追加しない(絶対条件)——呼び出し元
// (将来のreconciliation route/バッチ、EVENT-P1d以降のscope)が
// 「まだRunが無いclaimed waitがある」ことを何らかの既存手段
// (現時点では未実装、on-demand呼び出しのみ)で見つけた時に、この
// 関数を呼ぶだけでよい。
export async function reconcileClaimedEventWait(
  workId: string,
  userId: string,
  accessToken: string,
  eventWaitId: string,
  deps: ReconcileClaimedEventWaitDeps = defaultReconcileClaimedEventWaitDeps
): Promise<ReconcileClaimedEventWaitOutcome> {

  const wait = await deps.getEventWait(workId, userId, accessToken, eventWaitId);

  if (!wait) {
    return { status: "wait_not_found" };
  }

  if (wait.status !== "claimed") {
    // pending(まだclaimされていない)・expired/cancelled(claimに
    // 失敗した)のいずれであっても、"claimed"以外はこのfunctionの
    // 対象ではない——idempotent-safeにerrorではなく型で報告する。
    return { status: "wait_not_claimed", waitStatus: wait.status };
  }

  if (!wait.claimedByEventId) {
    // Section21の不変条件(claimed遷移は常にclaimed_by_event_idを
    // 同時に設定する、20261016010000migrationのtact_claim_matched_
    // event_wait())により構造的に起こらないはずだが、fail closedに
    // 扱う(この値が無いままresumeへ進まない)。
    return { status: "wait_missing_claim_reference" };
  }

  return resumeClaimedEventWait(
    workId,
    wait.taskId,
    userId,
    accessToken,
    wait.id,
    wait.claimedByEventId,
    deps
  );

}
