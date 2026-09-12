// =========================
// TACT Work — Work Completion Reconciliation Regression
// (Architecture Migration Phase C2.1a)
// =========================
//
// 対象: core/tact-work/completion.tsのreconcileWorkCompletionStatus()。
// 実Supabaseには一切接続しない(ReconcileWorkCompletionStatusDeps経由で
// listTasksForWork()/listApprovalsForWork()/updateWorkStatus()を
// 偽実装に差し替える)。
//
// 絶対条件(Phase C2.1a指示): 単純な「Task 1件 completed → Work
// completed」ではなく、Workが所有する全Taskを見て、全Taskがterminalに
// 達した場合のみWork全体を確定させること。pending Approvalが残る場合も
// 確定させないこと。

import { reconcileWorkCompletionStatus, type ReconcileWorkCompletionStatusDeps } from "../../../core/tact-work/completion";
import type { Approval, Work, WorkTask } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    workId: "work-1",
    description: "テスト",
    status: "pending",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

// Architecture audit finding F-02 fix regression coverage: a "classic"
// (non-semantic) Work by default — requestType/resultDeliveredAt both
// unset, matching every Work created before WORK-P1. All pre-existing
// Cases in this file exercise exactly this shape and must keep behaving
// identically.
function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "running",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "phase-c2-mock",
    requestedFromActorKind: "user",
    requestedFromActorId: "user-1",
    status: "approved",
    reason: "test",
    payload: {},
    requestedAt: "2026-09-06T00:00:00.000Z",
    createdAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(tasks: WorkTask[], approvals: Approval[] = [], work: Work = makeWork()) {

  const calls = { updateWorkStatusCalls: [] as string[], getWorkCalls: 0 };

  const deps: ReconcileWorkCompletionStatusDeps = {

    listTasksForWork: async () => tasks,

    listApprovalsForWork: async () => approvals,

    updateWorkStatus: async (_workId, _userId, _accessToken, status) => {
      calls.updateWorkStatusCalls.push(status);
    },

    getWork: async () => {
      calls.getWorkCalls += 1;
      return work;
    },

  };

  return { deps, calls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case 1: Task 1件 completed -> Work completed ----
  {
    const { deps, calls } = makeDeps([makeTask({ status: "completed" })]);

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[Case1] Task 1件completed -> Work completed",
        outcome.status === "reconciled" &&
          outcome.workStatus === "completed" &&
          calls.updateWorkStatusCalls.join(",") === "completed"
      )
    );
  }

  // ---- Case 2: Task 1件 failed -> Work failed ----
  {
    const { deps, calls } = makeDeps([makeTask({ status: "failed" })]);

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[Case2] Task 1件failed -> Work failed",
        outcome.status === "reconciled" &&
          outcome.workStatus === "failed" &&
          calls.updateWorkStatusCalls.join(",") === "failed"
      )
    );
  }

  // ---- Case 3: Task 2件(completed + pending) -> Workはterminalへ遷移しない ----
  {
    const { deps, calls } = makeDeps([
      makeTask({ id: "task-1", status: "completed" }),
      makeTask({ id: "task-2", status: "pending" }),
    ]);

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[Case3] Task 2件(completed+pending) -> Workは変更されない(絶対条件: 単一Taskの成功でWork全体を決めない)",
        outcome.status === "no_change" &&
          outcome.reason === "tasks_not_all_terminal" &&
          calls.updateWorkStatusCalls.length === 0
      )
    );
  }

  // ---- Architecture Migration Phase C2.1c-a: Integration write
  // proposalの実際のシナリオ(Task 1件がpending、同一Taskに紐づく
  // Approvalがpending) -> Workはterminalへ遷移しない(Case2の直接
  // 再現) ----
  {
    const { deps, calls } = makeDeps(
      [makeTask({ status: "pending" })],
      [makeApproval({ status: "pending" })]
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[C2.1c-a Case2] Task pending + Approval pending(Integration write proposal中)-> Workはcompletedへ確定しない",
        outcome.status === "no_change" &&
          outcome.reason === "tasks_not_all_terminal" &&
          calls.updateWorkStatusCalls.length === 0
      )
    );
  }

  // ---- Case 4: Task 2件(failed + pending) -> Workはterminalへ遷移しない ----
  {
    const { deps, calls } = makeDeps([
      makeTask({ id: "task-1", status: "failed" }),
      makeTask({ id: "task-2", status: "pending" }),
    ]);

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[Case4] Task 2件(failed+pending) -> Workは変更されない(残りのTaskがpendingのため未確定のまま)",
        outcome.status === "no_change" &&
          outcome.reason === "tasks_not_all_terminal" &&
          calls.updateWorkStatusCalls.length === 0
      )
    );
  }

  // ---- Case 5: Task 2件(completed + completed) -> Work completed ----
  {
    const { deps, calls } = makeDeps([
      makeTask({ id: "task-1", status: "completed" }),
      makeTask({ id: "task-2", status: "completed" }),
    ]);

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[Case5] Task 2件(completed+completed) -> Work completed",
        outcome.status === "reconciled" &&
          outcome.workStatus === "completed" &&
          calls.updateWorkStatusCalls.join(",") === "completed"
      )
    );
  }

  // ---- Case 6: Task 2件(completed + failed) -> Work failed ----
  {
    const { deps, calls } = makeDeps([
      makeTask({ id: "task-1", status: "completed" }),
      makeTask({ id: "task-2", status: "failed" }),
    ]);

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[Case6] Task 2件(completed+failed) -> Work failed(1件でもfailedがあれば全体failed)",
        outcome.status === "reconciled" &&
          outcome.workStatus === "failed" &&
          calls.updateWorkStatusCalls.join(",") === "failed"
      )
    );
  }

  // ---- Task 0件 -> no_change ----
  {
    const { deps, calls } = makeDeps([]);

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[Edge] Taskが1件も無い場合、Workを変更せずno_changeを返す",
        outcome.status === "no_change" && outcome.reason === "no_tasks" && calls.updateWorkStatusCalls.length === 0
      )
    );
  }

  // ---- 絶対条件4: 全Taskがterminalでも、pending Approvalが残る場合は
  // Workを確定させない(Phase B3のapprovalRequirement pattern対応、
  // Task一覧だけでは検出できないケース) ----
  {
    const { deps, calls } = makeDeps(
      [makeTask({ status: "completed" })],
      [makeApproval({ status: "pending" })]
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[絶対条件] 全Task terminalでもpending Approvalが残る場合、Workを確定させない",
        outcome.status === "no_change" &&
          outcome.reason === "pending_approval_exists" &&
          calls.updateWorkStatusCalls.length === 0
      )
    );
  }

  // ---- 全Taskがterminalかつ、承認済み(非pending)Approvalのみが残る
  // 場合は通常通り確定してよい ----
  {
    const { deps } = makeDeps(
      [makeTask({ status: "completed" })],
      [makeApproval({ status: "approved" })]
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[Approval非pending] 承認済み(approved)Approvalのみが残る場合はWorkを確定できる",
        outcome.status === "reconciled" && outcome.workStatus === "completed"
      )
    );
  }

  // ---- 絶対条件3: 全Taskがcancelledのみ(completed/failedが1件も無い)の
  // 場合、既存canonical semanticsに前例が無いため独自ルールを作らず
  // undeterminedとしWorkを変更しない ----
  {
    const { deps, calls } = makeDeps([
      makeTask({ id: "task-1", status: "cancelled" }),
      makeTask({ id: "task-2", status: "cancelled" }),
    ]);

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[絶対条件] 全Taskがcancelledのみの場合、独自ルールを作らずundeterminedを返しWorkを変更しない",
        outcome.status === "undetermined" &&
          outcome.reason === "all_tasks_cancelled_no_existing_precedent" &&
          calls.updateWorkStatusCalls.length === 0
      )
    );
  }

  // =========================
  // Architecture audit finding F-02 fix: durable semantic delegated Work
  // must not complete purely from Task-count, until Work.resultDeliveredAt
  // is set (core/tact-work/completion.ts、"awaiting_semantic_delivery")。
  // =========================

  // ---- semantic Work(requestType != null)、全Task completed、
  // resultDeliveredAtが未設定 -> Workをcompletedへ確定しない ----
  {
    const semanticWork = makeWork({ requestType: "inspect", resultDeliveredAt: null });

    const { deps, calls } = makeDeps(
      [makeTask({ status: "completed" })],
      [],
      semanticWork
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[F-02] semantic Work(requestType=inspect)+全Task completed+resultDeliveredAt未設定 -> Workはcompletedへ確定しない(awaiting_semantic_delivery)",
        outcome.status === "no_change" &&
          outcome.reason === "awaiting_semantic_delivery" &&
          calls.updateWorkStatusCalls.length === 0
      )
    );
  }

  // ---- semantic Work、全Task completed、resultDeliveredAtが設定済み
  // -> 通常通りcompletedへ確定できる ----
  {
    const semanticWork = makeWork({
      requestType: "inspect",
      resultDeliveredAt: "2026-09-12T00:00:00.000Z",
    });

    const { deps, calls } = makeDeps(
      [makeTask({ status: "completed" })],
      [],
      semanticWork
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[F-02] semantic Work+全Task completed+resultDeliveredAt設定済み -> 通常通りcompletedへ確定する",
        outcome.status === "reconciled" &&
          outcome.workStatus === "completed" &&
          calls.updateWorkStatusCalls.join(",") === "completed"
      )
    );
  }

  // ---- semantic act Work、send Task failed -> resultDeliveredAtを
  // 待たず即座にfailedへ確定する(false successより安全側、既存
  // failure semanticsのまま変更しない) ----
  {
    const semanticWork = makeWork({ requestType: "act", resultDeliveredAt: null });

    const { deps, calls } = makeDeps(
      [
        makeTask({ id: "task-1", status: "completed" }),
        makeTask({ id: "task-2", status: "failed" }),
      ],
      [],
      semanticWork
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[F-02] semantic act Work+send Task failed -> resultDeliveredAt未設定でも即座にfailedへ確定する(false successにしない)",
        outcome.status === "reconciled" &&
          outcome.workStatus === "failed" &&
          calls.updateWorkStatusCalls.join(",") === "failed"
      )
    );
  }

  // ---- classic Work(requestType未設定)は、getWork()が呼ばれても
  // (実装の都合)従来通り即座にcompletedへ確定する(回帰確認) ----
  {
    const { deps, calls } = makeDeps([makeTask({ status: "completed" })], [], makeWork());

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", deps);

    results.push(
      check(
        "[F-02回帰確認] classic Work(requestType未設定)は従来通り即座にcompletedへ確定する(挙動変更なし)",
        outcome.status === "reconciled" &&
          outcome.workStatus === "completed" &&
          calls.updateWorkStatusCalls.join(",") === "completed"
      )
    );
  }

  return summarize("work/completion", results);

}
