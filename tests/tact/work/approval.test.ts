// =========================
// TACT Work — Approval Execution Boundary Regression
// (Architecture Migration Phase B3)
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
// 挙動を再現する。

import {
  requestApproval,
  approveApproval,
  rejectApproval,
  type ApprovalExecutionDeps,
  type ApprovalRequest,
} from "../../../core/tact-work/approval";
import type { Approval, ApprovalStatus, Work } from "../../../core/tact-work/types";
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
}

// worksはworkId -> ownerUserIdの単純なmap(複数user/複数Workのシナリオ
// をテストできるようにする)。
function makeFakeBackend(works: Record<string, string>): FakeBackend {

  const workStatusUpdates: string[] = [];
  const taskStatusUpdates: { taskId: string; status: string }[] = [];
  const approvals = new Map<string, Approval>();
  let nextApprovalId = 1;

  const getWork: ApprovalExecutionDeps["getWork"] = async (workId, userId) => {
    if (works[workId] !== userId) {
      return undefined;
    }
    return makeWork({ id: workId, userId });
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

    updateWorkStatus: async (_workId, _userId, _accessToken, status) => {
      workStatusUpdates.push(status);
    },

    updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
      taskStatusUpdates.push({ taskId, status });
    },

  };

  return { deps, workStatusUpdates, taskStatusUpdates, approvals };

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
  }

  // =========================
  // Multiple approvals
  // =========================

  // ---- 5. Work配下にpending A/B -> Aをapprove -> Bはpendingのまま
  // -> Workはwaiting_for_approval維持(誤って早期resumeしない) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });

    const approvalA = await requestApproval(makeRequest({ taskId: "task-a" }), "user-1", "fake-token", backend.deps);
    const approvalB = await requestApproval(makeRequest({ taskId: "task-b" }), "user-1", "fake-token", backend.deps);

    backend.workStatusUpdates.length = 0; // requestApproval分のログをリセットして、approve後の遷移だけを見る

    const outcomeA = await approveApproval("work-1", "user-1", "fake-token", approvalA!.id, undefined, backend.deps);

    results.push(
      check(
        "[5] 複数pending中の1件だけapprove -> workResumed=false、Workをrunningへ戻さない",
        outcomeA.status === "approved" &&
          outcomeA.workResumed === false &&
          !backend.workStatusUpdates.includes("running")
      )
    );

    // ---- 6. 最後のpending(B)もapprove -> Work resume可能 ----
    const outcomeB = await approveApproval("work-1", "user-1", "fake-token", approvalB!.id, undefined, backend.deps);

    results.push(
      check(
        "[6] 最後のpendingをapprove -> workResumed=true、Workがrunningへ戻る",
        outcomeB.status === "approved" &&
          outcomeB.workResumed === true &&
          backend.workStatusUpdates[backend.workStatusUpdates.length - 1] === "running"
      )
    );
  }

  // =========================
  // Authorization
  // =========================

  // ---- 7/8. 他userのApprovalは取得・approve/reject不可 ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);

    const foreignGet = await backend.deps.getApproval("work-1", "attacker", "fake-token", approval!.id);

    results.push(
      check(
        "[7] 他userはApprovalを取得できない(Work ownership経由のdefense)",
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

    // 実際には状態が変化していないことも確認する。
    const stillPending = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[8] 他userのapprove/reject試行後もApproval自体はpendingのまま変化しない",
        stillPending?.status === "pending"
      )
    );
  }

  // =========================
  // Idempotency
  // =========================

  // ---- 10. approved Approvalの再approve -> 二重resumeなし(already_resolved) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);
    await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const runningCountBefore = backend.workStatusUpdates.filter((s) => s === "running").length;

    const secondOutcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const runningCountAfter = backend.workStatusUpdates.filter((s) => s === "running").length;

    results.push(
      check(
        "[10] approved済みの再approveはalready_resolvedを返し、Work statusを再度更新しない(二重resumeなし)",
        secondOutcome.status === "already_resolved" && runningCountAfter === runningCountBefore
      )
    );
  }

  // ---- 11. rejected Approvalをapproveへ変更不可 ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);
    await rejectApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const flipAttempt = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const stored = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[11] rejected -> approveを試みてもinvalid_transition、実データもrejectedのまま",
        flipAttempt.status === "invalid_transition" && stored?.status === "rejected"
      )
    );
  }

  // ---- 12. terminal(rejected)状態からのreject再送も不正遷移として扱われない(idempotent) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);
    await rejectApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const secondReject = await rejectApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[12] rejected済みの再rejectはalready_resolvedを返す(terminal stateからの不正遷移を拒否しつつ、正常なdouble-click再送は安全)",
        secondReject.status === "already_resolved"
      )
    );
  }

  return summarize("work/approval", results);

}
