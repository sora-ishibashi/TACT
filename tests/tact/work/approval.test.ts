// =========================
// TACT Work — Approval Execution Boundary Regression
// (Architecture Migration Phase B3 + Final Fix: Terminal Work
// Approval Safety)
// =========================
//
// 対象: core/tact-work/approval.tsのrequestApproval()/approveApproval()/
// rejectApproval()。実Supabaseには一切接続しない
// (ApprovalExecutionDeps経由でStore呼び出しを偽実装に差し替える、
// core/tact-work/{intake,execution}.test.tsと同じDIテスト手法)。
//
// 偽実装は、テストごとに独立したin-memoryのWork/Approval状態を持ち、
// 「userIdが一致しない場合は常に見つからない扱いにする」という
// 実store.ts(core/tact-work/store.ts)のownership defenseと同じ
// 挙動を再現する。Work.statusも実際にtrackする(Final Fixの
// work_not_resumableガードは、getWork()が返す"今のWork.status"を
// 見て判定するため、偽実装が常に固定値を返すと検証にならない)。

import {
  requestApproval,
  approveApproval,
  rejectApproval,
  type ApprovalExecutionDeps,
  type ApprovalRequest,
} from "../../../core/tact-work/approval";
import type { Approval, ApprovalStatus, Work, WorkStatus } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

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

interface FakeBackend {
  deps: ApprovalExecutionDeps;
  workStatusUpdates: string[];
  taskStatusUpdates: { taskId: string; status: string }[];
  approvals: Map<string, Approval>;
  setWorkStatus: (workId: string, status: WorkStatus) => void;
  getWorkStatus: (workId: string) => WorkStatus | undefined;
}

// worksはworkId -> ownerUserIdの単純なmap(複数user/複数Workのシナリオ
// をテストできるようにする)。Work.statusは"running"を初期値として
// 実際にtrackする。
function makeFakeBackend(works: Record<string, string>): FakeBackend {

  const workStatusUpdates: string[] = [];
  const taskStatusUpdates: { taskId: string; status: string }[] = [];
  const approvals = new Map<string, Approval>();
  const workStatuses = new Map<string, WorkStatus>(
    Object.keys(works).map((id) => [id, "running" as WorkStatus])
  );
  let nextApprovalId = 1;

  const getWork: ApprovalExecutionDeps["getWork"] = async (workId, userId) => {
    if (works[workId] !== userId) {
      return undefined;
    }
    return makeWork({ id: workId, userId, status: workStatuses.get(workId) ?? "running" });
  };

  const deps: ApprovalExecutionDeps = {

    getWork,

    createApproval: async (workId, userId, _accessToken, params) => {

      const work = await getWork(workId, userId, "fake-token");

      if (!work) {
        return undefined;
      }

      const id = `approval-${nextApprovalId++}`;

      const approval: Approval = {
        id,
        workId,
        taskId: params.taskId ?? null,
        requestedByActorKind: params.requestedByActorKind,
        requestedByActorId: params.requestedByActorId,
        requestedFromActorKind: params.requestedFromActorKind,
        requestedFromActorId: params.requestedFromActorId,
        status: "pending",
        reason: params.reason,
        payload: params.payload,
        requestedAt: "2026-09-06T00:00:00.000Z",
        createdAt: "2026-09-06T00:00:00.000Z",
      };

      approvals.set(id, approval);

      return approval;

    },

    getApproval: async (workId, userId, _accessToken, approvalId) => {

      const work = await getWork(workId, userId, "fake-token");

      if (!work) {
        return undefined;
      }

      const approval = approvals.get(approvalId);

      return approval && approval.workId === workId ? approval : undefined;

    },

    updateApprovalStatus: async (workId, userId, _accessToken, approvalId, status: ApprovalStatus, response) => {

      const work = await getWork(workId, userId, "fake-token");

      if (!work) {
        return;
      }

      const approval = approvals.get(approvalId);

      if (approval && approval.workId === workId) {
        approvals.set(approvalId, {
          ...approval,
          status,
          respondedAt: "2026-09-06T00:01:00.000Z",
          response: response ?? null,
        });
      }

    },

    listApprovalsForWork: async (workId, userId) => {

      const work = await getWork(workId, userId, "fake-token");

      if (!work) {
        return [];
      }

      return [...approvals.values()].filter((approval) => approval.workId === workId);

    },

    updateWorkStatus: async (workId, _userId, _accessToken, status) => {
      workStatusUpdates.push(status);
      workStatuses.set(workId, status);
    },

    updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
      taskStatusUpdates.push({ taskId, status });
    },

  };

  return {
    deps,
    workStatusUpdates,
    taskStatusUpdates,
    approvals,
    setWorkStatus: (workId, status) => workStatuses.set(workId, status),
    getWorkStatus: (workId) => workStatuses.get(workId),
  };

}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    workId: "work-1",
    scope: "task",
    requestedByActor: { kind: "ai", id: "phase-b3-mock-write" },
    requestedFromActor: { kind: "user", id: "user-1" },
    reason: "外部SaaSへの投稿には承認が必要です",
    action: { kind: "external_write_test", summary: "Slackへ投稿する" },
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // Core lifecycle
  // =========================

  // ---- 1. running WorkでApproval request -> pending、Work waiting_for_approval ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });

    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);

    results.push(
      check(
        "[1] requestApproval() -> Approval pending、payloadにscope/actionが保持される",
        approval?.status === "pending" &&
          (approval?.payload as { scope?: string })?.scope === "task"
      )
    );

    results.push(
      check(
        "[1] requestApproval() -> Workがwaiting_for_approvalへ遷移する",
        backend.workStatusUpdates[0] === "waiting_for_approval"
      )
    );
  }

  // ---- 2. pending Approval approve -> approved、他にpendingが無ければWork running ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, "OK", backend.deps);

    results.push(
      check(
        "[2] approveApproval() -> approved、Work resume可能(waiting無し)",
        outcome.status === "approved" &&
          outcome.workResumed === true &&
          backend.workStatusUpdates[backend.workStatusUpdates.length - 1] === "running"
      )
    );
  }

  // ---- 3. pending Approval reject -> rejected、protected action未実行、Work/Task失敗 ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest({ taskId: "task-1" }), "user-1", "fake-token", backend.deps);

    const outcome = await rejectApproval("work-1", "user-1", "fake-token", approval!.id, "却下します", backend.deps);

    results.push(
      check(
        "[3] rejectApproval() -> rejected、Task/Workともfailedへ遷移する",
        outcome.status === "rejected" &&
          backend.taskStatusUpdates.some((u) => u.taskId === "task-1" && u.status === "failed") &&
          backend.workStatusUpdates[backend.workStatusUpdates.length - 1] === "failed"
      )
    );

    // Architecture Migration Phase C2.1c-a: rejectApproval()は
    // ApprovalExecutionDeps経由でもTaskの事前state(getTask相当)を
    // 一切読まない(型構造上、ApprovalExecutionDepsにTask取得APIが
    // 存在しない)。そのため、Canonical Work modelの新lifecycle
    // (Integration write proposal中はTaskがpendingのまま)の下では、
    // このtask-1へのTask status update呼び出しは実質的に
    // "pending -> failed"という1回だけの単調な遷移になる
    // (rejectApproval()自身が複数回のTask status更新を行わないことを
    // 直接証明する)。
    results.push(
      check(
        "[Phase C2.1c-a] Task status update historyがtask-1について厳密に1回・'failed'のみ(pending -> failedという単調な遷移、completed経由の巻き戻しが無いことの直接証拠)",
        backend.taskStatusUpdates.filter((u) => u.taskId === "task-1").length === 1 &&
          backend.taskStatusUpdates.filter((u) => u.taskId === "task-1")[0]?.status === "failed"
      )
    );
  }

  // =========================
  // Terminal Work Approval Safety (Final Fix)
  // =========================

  // ---- Required test 1: Approval A/B pending -> A reject -> Work failed -> B remains pending ----
  let scenarioBackend!: ReturnType<typeof makeFakeBackend>;
  let scenarioApprovalB!: Approval;
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });

    const approvalA = await requestApproval(makeRequest({ taskId: "task-a" }), "user-1", "fake-token", backend.deps);
    const approvalB = await requestApproval(makeRequest({ taskId: "task-b" }), "user-1", "fake-token", backend.deps);

    await rejectApproval("work-1", "user-1", "fake-token", approvalA!.id, undefined, backend.deps);

    const bAfterReject = await backend.deps.getApproval("work-1", "user-1", "fake-token", approvalB!.id);

    results.push(
      check(
        "[Required1] A reject -> Work failed、Bはpendingのまま残る",
        backend.getWorkStatus("work-1") === "failed" && bAfterReject?.status === "pending"
      )
    );

    scenarioBackend = backend;
    scenarioApprovalB = approvalB!;
  }

  // ---- Required test 2: 上記状態でB approve -> Work failed維持(runningへ戻らない) ----
  {
    const beforeStatus = scenarioBackend.getWorkStatus("work-1");

    const outcome = await approveApproval(
      "work-1", "user-1", "fake-token", scenarioApprovalB.id, undefined, scenarioBackend.deps
    );

    results.push(
      check(
        "[Required2] failed WorkでのB approve -> work_not_resumableで安全に拒否され、Workはfailed維持のまま",
        outcome.status === "work_not_resumable" &&
          outcome.workStatus === "failed" &&
          beforeStatus === "failed" &&
          scenarioBackend.getWorkStatus("work-1") === "failed"
      )
    );

    const bStillPending = await scenarioBackend.deps.getApproval("work-1", "user-1", "fake-token", scenarioApprovalB.id);

    results.push(
      check(
        "[Required2] work_not_resumable時、ApprovalのDB状態自体もpendingのまま変更されない(通常のapproveとして解決しない)",
        bStillPending?.status === "pending"
      )
    );
  }

  // ---- Required test 3: failed Work + pending Approval -> approve attempt -> safe domain result ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);
    backend.setWorkStatus("work-1", "failed"); // 他の経路でWorkがfailedへ確定したことを模す

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[Required3] failed Work -> approve attemptはwork_not_resumableで拒否される",
        outcome.status === "work_not_resumable" && backend.getWorkStatus("work-1") === "failed"
      )
    );
  }

  // ---- Required test 4: cancelled Work + pending Approval -> approve attempt -> Work remains cancelled ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);
    backend.setWorkStatus("work-1", "cancelled");

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[Required4] cancelled Work -> approve attemptはwork_not_resumableで拒否され、Workはcancelledのまま",
        outcome.status === "work_not_resumable" && backend.getWorkStatus("work-1") === "cancelled"
      )
    );
  }

  // ---- Required test 5: completed Work + pending Approval -> approve attempt -> Work remains completed ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);
    backend.setWorkStatus("work-1", "completed");

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[Required5] completed Work -> approve attemptはwork_not_resumableで拒否され、Workはcompletedのまま",
        outcome.status === "work_not_resumable" && backend.getWorkStatus("work-1") === "completed"
      )
    );
  }

  // =========================
  // Reject Terminal Work Guard (Final Final Fix)
  // =========================
  //
  // Approval resolution must never mutate a terminal Work——この
  // 不変条件はreject側にも同様に適用される(approve側と対称)。

  // ---- Final-Final Required 1: failed Work + pending Approval -> reject
  // -> Work failed維持、Approval pending維持、Task変更なし ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest({ taskId: "task-1" }), "user-1", "fake-token", backend.deps);
    backend.setWorkStatus("work-1", "failed"); // 他の経路でWorkがfailedへ確定したことを模す

    const outcome = await rejectApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const stored = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[FinalFinal1] failed Work -> reject attemptはwork_not_resumableで拒否され、Work/Approval/Taskいずれも変更されない",
        outcome.status === "work_not_resumable" &&
          backend.getWorkStatus("work-1") === "failed" &&
          stored?.status === "pending" &&
          backend.taskStatusUpdates.length === 0
      )
    );
  }

  // ---- Final-Final Required 2: completed Work + pending Approval -> reject
  // -> Work completed維持、Approval pending維持、Task変更なし ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest({ taskId: "task-1" }), "user-1", "fake-token", backend.deps);
    backend.setWorkStatus("work-1", "completed");

    const outcome = await rejectApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const stored = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[FinalFinal2] completed Work -> reject attemptはwork_not_resumableで拒否され、Work/Approval/Taskいずれも変更されない",
        outcome.status === "work_not_resumable" &&
          backend.getWorkStatus("work-1") === "completed" &&
          stored?.status === "pending" &&
          backend.taskStatusUpdates.length === 0
      )
    );
  }

  // ---- Final-Final Required 3: cancelled Work + pending Approval -> reject
  // -> Work cancelled維持、Approval pending維持、Task変更なし ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest({ taskId: "task-1" }), "user-1", "fake-token", backend.deps);
    backend.setWorkStatus("work-1", "cancelled");

    const outcome = await rejectApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const stored = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[FinalFinal3] cancelled Work -> reject attemptはwork_not_resumableで拒否され、Work/Approval/Taskいずれも変更されない",
        outcome.status === "work_not_resumable" &&
          backend.getWorkStatus("work-1") === "cancelled" &&
          stored?.status === "pending" &&
          backend.taskStatusUpdates.length === 0
      )
    );
  }

  // ---- Final-Final Required 4: waiting_for_approval + pending Approval -> reject
  // -> 既存の正常reject挙動を維持(Approval rejected, Task failed, Work failed) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest({ taskId: "task-1" }), "user-1", "fake-token", backend.deps);

    const outcome = await rejectApproval("work-1", "user-1", "fake-token", approval!.id, "却下", backend.deps);

    results.push(
      check(
        "[FinalFinal4] waiting_for_approvalでのreject -> 既存正常挙動を維持(rejected/Task failed/Work failed、regressionなし)",
        outcome.status === "rejected" &&
          backend.taskStatusUpdates.some((u) => u.taskId === "task-1" && u.status === "failed") &&
          backend.getWorkStatus("work-1") === "failed"
      )
    );
  }

  // ---- Final-Final Required 5: cross-user reject protectionのregression確認 ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);

    const foreignReject = await rejectApproval("work-1", "attacker", "fake-token", approval!.id, undefined, backend.deps);

    const stored = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[FinalFinal5] 他userのreject試行はnot_foundで安全に拒否され、Approvalはpendingのまま(regressionなし)",
        foreignReject.status === "not_found" && stored?.status === "pending"
      )
    );
  }

  // ---- Required test 6: waiting_for_approval + 最後の1件 -> approve -> running(正常resumeが壊れていない) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[Required6] waiting_for_approval + 最後の1件 -> approveでrunningへ正しく戻る(regressionなし)",
        outcome.status === "approved" &&
          outcome.workResumed === true &&
          backend.getWorkStatus("work-1") === "running"
      )
    );
  }

  // ---- Required test 7: waiting_for_approval + multiple pending -> 1件approve -> waiting_for_approval維持 ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approvalA = await requestApproval(makeRequest({ taskId: "task-a" }), "user-1", "fake-token", backend.deps);
    await requestApproval(makeRequest({ taskId: "task-b" }), "user-1", "fake-token", backend.deps);

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approvalA!.id, undefined, backend.deps);

    results.push(
      check(
        "[Required7] 複数pending中の1件approve -> workResumed=false、Workはwaiting_for_approval維持(regressionなし)",
        outcome.status === "approved" &&
          outcome.workResumed === false &&
          backend.getWorkStatus("work-1") === "waiting_for_approval"
      )
    );
  }

  // =========================
  // Authorization (既存、維持確認)
  // =========================

  // ---- 8. 他userのApprovalは取得・approve/reject不可 ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);

    const foreignGet = await backend.deps.getApproval("work-1", "attacker", "fake-token", approval!.id);

    results.push(
      check(
        "[8] 他userはApprovalを取得できない(Work ownership経由のdefense)",
        foreignGet === undefined
      )
    );

    const foreignApprove = await approveApproval("work-1", "attacker", "fake-token", approval!.id, undefined, backend.deps);
    const foreignReject = await rejectApproval("work-1", "attacker", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[8] 他userはapprove/rejectできない(not_found扱いで安全に拒否)",
        foreignApprove.status === "not_found" && foreignReject.status === "not_found"
      )
    );

    const stillPending = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[8] 他userのapprove/reject試行後もApproval自体はpendingのまま変化しない",
        stillPending?.status === "pending"
      )
    );
  }

  // =========================
  // Idempotency (既存、維持確認)
  // =========================

  // ---- 9. approved Approvalの再approve -> 二重resumeなし(already_resolved) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);
    await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const runningCountBefore = backend.workStatusUpdates.filter((s) => s === "running").length;

    const secondOutcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const runningCountAfter = backend.workStatusUpdates.filter((s) => s === "running").length;

    results.push(
      check(
        "[9] approved済みの再approveはalready_resolvedを返し、Work statusを再度更新しない(二重resumeなし)",
        secondOutcome.status === "already_resolved" && runningCountAfter === runningCountBefore
      )
    );
  }

  // ---- rejected Approvalをapproveへ変更不可 ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);
    await rejectApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const flipAttempt = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const stored = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[9] rejected -> approveを試みてもinvalid_transition、実データもrejectedのまま",
        flipAttempt.status === "invalid_transition" && stored?.status === "rejected"
      )
    );
  }

  // ---- terminal(rejected)状態からのreject再送も安全にidempotent ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);
    await rejectApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const secondReject = await rejectApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[9] rejected済みの再rejectはalready_resolvedを返す(terminal stateからの不正遷移を拒否しつつ、正常なdouble-click再送は安全)",
        secondReject.status === "already_resolved"
      )
    );
  }

  return summarize("work/approval", results);

}
