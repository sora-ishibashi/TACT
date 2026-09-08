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
  checkApproverAllowed,
  type ApprovalExecutionDeps,
  type ApprovalRequest,
} from "../../../core/tact-work/approval";
import type { Approval, ApprovalStatus, Work, WorkStatus } from "../../../core/tact-work/types";
import type { CreateApprovalParams } from "../../../core/tact-work/store";
import {
  buildApprovalSubject,
  verifyApprovalIntegrity,
  APPROVAL_SUBJECT_VERSION,
  type ApprovalSubject,
} from "../../../core/tact-work/approvalIntegrity";
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
        // Fast Port P3b。
        allowedApproverIds: params.allowedApproverIds ?? null,
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

  // =========================
  // Architecture Migration ARCH-P1b: Approval Subject capture
  // =========================
  //
  // requestApproval()にrequest.subjectを渡した場合、
  // core/tact-work/store.tsのcreateApproval()へ渡るparamsに
  // subject_version/subject_json/subject_hash/subject_captured_at
  // 相当の値(CreateApprovalParams.subjectVersion等)が正しく設定
  // されることを、実createApproval()を呼ばず、paramsをcaptureする
  // 薄いwrapper depsで確認する(makeFakeBackend()の既存deps自体は
  // 変更せず、createApprovalだけを透過的にwrapする)。

  function makeSubjectFixture(overrides: Partial<ApprovalSubject> = {}): ApprovalSubject {
    const result = buildApprovalSubject({
      workId: "work-1",
      taskId: "task-1",
      service: "slack",
      operation: "send_message",
      input: { channel: "tact", text: "明日の会議は10時です" },
      connectionId: "conn-1",
      riskClassSnapshot: "write",
    });
    if (!result.ok) {
      throw new Error("test fixture itself must be buildable");
    }
    return { ...result.subject, ...overrides };
  }

  // ---- ARCH-P1b-1: subjectを渡すとcreateApproval()へsubject_*が正しく渡る ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const capturedParams: CreateApprovalParams[] = [];
    const originalCreateApproval = backend.deps.createApproval;

    const deps: ApprovalExecutionDeps = {
      ...backend.deps,
      createApproval: async (workId, userId, accessToken, params) => {
        capturedParams.push(params);
        return originalCreateApproval(workId, userId, accessToken, params);
      },
    };

    const subject = makeSubjectFixture();

    await requestApproval(makeRequest({ subject }), "user-1", "fake-token", deps);

    const params = capturedParams[0];

    results.push(
      check(
        "[ARCH-P1b-1] subjectVersion(DB列)がAPPROVAL_SUBJECT_VERSIONと一致する",
        params?.subjectVersion === APPROVAL_SUBJECT_VERSION
      )
    );

    results.push(
      check(
        "[ARCH-P1b-1] subjectJsonがsubject本体をそのまま保持する(canonical serialization文字列そのものではなくstructured JSON)",
        typeof params?.subjectJson === "object" &&
          params?.subjectJson !== null &&
          !Array.isArray(params.subjectJson) &&
          (params.subjectJson as Record<string, unknown>).service === "slack"
      )
    );

    results.push(
      check(
        "[ARCH-P1b-1] subjectHashは64文字の小文字16進文字列(SHA-256 hex digest)",
        typeof params?.subjectHash === "string" && /^[0-9a-f]{64}$/.test(params.subjectHash)
      )
    );

    results.push(
      check(
        "[ARCH-P1b-1] subjectCapturedAtはISO 8601形式のtimestampとして設定される(capture時点のserver timestamp)",
        typeof params?.subjectCapturedAt === "string" && !Number.isNaN(Date.parse(params.subjectCapturedAt))
      )
    );

    results.push(
      check(
        "[ARCH-P1b-1] DBのsubject_version列は、subject_json内部のsubjectVersionと一致する(single source of truthの一致確認)",
        params?.subjectVersion === (params?.subjectJson as { subjectVersion?: number } | undefined)?.subjectVersion
      )
    );
  }

  // ---- ARCH-P1b-2: hash決定論性(同じsubjectを2回渡すと同じhashになる) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const capturedParams: CreateApprovalParams[] = [];
    const originalCreateApproval = backend.deps.createApproval;

    const deps: ApprovalExecutionDeps = {
      ...backend.deps,
      createApproval: async (workId, userId, accessToken, params) => {
        capturedParams.push(params);
        return originalCreateApproval(workId, userId, accessToken, params);
      },
    };

    await requestApproval(makeRequest({ subject: makeSubjectFixture() }), "user-1", "fake-token", deps);
    await requestApproval(makeRequest({ subject: makeSubjectFixture() }), "user-1", "fake-token", deps);

    results.push(
      check(
        "[ARCH-P1b-2] 同一内容のsubjectを2回渡しても、同じsubjectHashが生成される(deterministic)",
        capturedParams.length === 2 && capturedParams[0].subjectHash === capturedParams[1].subjectHash
      )
    );
  }

  // ---- ARCH-P1b-3: 往復確認 — capture済みのsubject_json/hash/versionを
  // 「stored」として渡すと、元のsubjectに対してverifyApprovalIntegrity()
  // がmatchを返す(capture pipeline全体の正しさをend-to-endで確認) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const capturedParams: CreateApprovalParams[] = [];
    const originalCreateApproval = backend.deps.createApproval;

    const deps: ApprovalExecutionDeps = {
      ...backend.deps,
      createApproval: async (workId, userId, accessToken, params) => {
        capturedParams.push(params);
        return originalCreateApproval(workId, userId, accessToken, params);
      },
    };

    const originalSubject = makeSubjectFixture();

    await requestApproval(makeRequest({ subject: originalSubject }), "user-1", "fake-token", deps);

    const params = capturedParams[0];

    const verifyResult = verifyApprovalIntegrity(
      {
        version: params.subjectVersion ?? null,
        json: params.subjectJson ?? null,
        hash: params.subjectHash ?? null,
      },
      originalSubject
    );

    results.push(
      check(
        "[ARCH-P1b-3] capture済みのsubject_version/subject_json/subject_hashを再度渡すと、元のsubjectとmatchする(capture pipeline全体のround-trip正しさ)",
        verifyResult.result === "match"
      )
    );
  }

  // ---- ARCH-P1b-4: subjectを渡さない場合、既存の後方互換動作を維持する ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const capturedParams: CreateApprovalParams[] = [];
    const originalCreateApproval = backend.deps.createApproval;

    const deps: ApprovalExecutionDeps = {
      ...backend.deps,
      createApproval: async (workId, userId, accessToken, params) => {
        capturedParams.push(params);
        return originalCreateApproval(workId, userId, accessToken, params);
      },
    };

    // 既存の呼び出し方(subjectフィールドを一切指定しない、既存の
    // 全requestApproval()呼び出し元と同じ形)。
    await requestApproval(makeRequest(), "user-1", "fake-token", deps);

    const params = capturedParams[0];

    results.push(
      check(
        "[ARCH-P1b-4] subjectを渡さない場合、subject_version/subject_json/subject_hash/subject_captured_atはいずれも設定されない(undefinedのまま、既存呼び出し元の動作を一切変えない)",
        params?.subjectVersion === undefined &&
          params?.subjectJson === undefined &&
          params?.subjectHash === undefined &&
          params?.subjectCapturedAt === undefined
      )
    );
  }

  // =========================
  // Fast Port P3b — AllowedResponder / Anti-Self-Approval Enforcement
  // =========================
  //
  // 対象: core/tact-work/approval.tsのcheckApproverAllowed()と、
  // approveApproval()/rejectApproval()への配線。既存のmakeRequest()の
  // 既定値(requestedByActor: {kind:"ai", id:"phase-b3-mock-write"})は
  // 現在の唯一のlive producer(core/tact-work/execution.ts)と同じ
  // kind="ai"であるため、既存テストは全てself-approval判定の対象外
  // のまま(regressionなし)——新しいtestでは明示的にkind="user"の
  // requestedByActorを渡し、self-approval判定を意図的に発火させる。

  // ---- [P3b-1] 既存Capability producer(kind="ai")のrequestは、承認者
  // (人間)と絶対に一致しないため、self-approval判定に一切影響されない
  // (Production Compatibility Reviewの直接証拠) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[P3b-1] requestedByActorKind='ai'(現在の唯一のlive producer)は、承認者が誰であってもself_approval_forbiddenにならない(既存本番Slack E2Eへの無影響の直接証拠)",
        outcome.status === "approved"
      )
    );
  }

  // ---- [P3b-2] requester metadata captured(既存field、Phase B1から変更なし。P3bで壊れていないことの確認) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "user", id: "user-a" } }),
      "user-1", "fake-token", backend.deps
    );

    results.push(
      check(
        "[P3b-2] requestedByActorKind/Idがそのまま保存される(既存field)",
        approval?.requestedByActorKind === "user" && approval?.requestedByActorId === "user-a"
      )
    );
  }

  // ---- [P3b-3] allowed approver stored ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ allowedApproverIds: ["user-1", "user-2"] }),
      "user-1", "fake-token", backend.deps
    );

    results.push(
      check(
        "[P3b-3] allowedApproverIdsが保存される",
        Array.isArray(approval?.allowedApproverIds) &&
          approval?.allowedApproverIds?.length === 2 &&
          approval?.allowedApproverIds?.includes("user-2")
      )
    );
  }

  // ---- [P3b-4] human A request -> human A approve denied(self-approval) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "user", id: "user-1" } }),
      "user-1", "fake-token", backend.deps
    );

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const stored = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[P3b-4] requester(kind='user')===approverの場合、self_approval_forbiddenで拒否され、Approvalはpendingのまま(絶対条件10/11、Lindyの反面教師patternへの直接対策)",
        outcome.status === "self_approval_forbidden" && stored?.status === "pending"
      )
    );
  }

  // ---- [P3b-5] human A request -> human B approve allowed(allowlistで明示許可) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "user", id: "user-a" }, allowedApproverIds: ["user-1"] }),
      "user-1", "fake-token", backend.deps
    );

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[P3b-5] requester(user-a) !== approver(user-1、allowlistに含まれる) -> approved",
        outcome.status === "approved"
      )
    );
  }

  // ---- [P3b-6] human A request -> human C approve denied(allowlistに含まれない) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "user", id: "user-a" }, allowedApproverIds: ["user-only-allowed"] }),
      "user-1", "fake-token", backend.deps
    );

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    const stored = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[P3b-6] allowedApproverIdsに含まれないapprover(user-1)はapprover_not_allowedで拒否され、Approvalはpendingのまま",
        outcome.status === "approver_not_allowed" && stored?.status === "pending"
      )
    );
  }

  // ---- [P3b-7] system request -> human owner approve allowed ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "system", id: "work-router" } }),
      "user-1", "fake-token", backend.deps
    );

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[P3b-7] requestedByActorKind='system' -> 人間owner(user-1)のapproveは常に許可される(kindが異なれば同一actorたり得ない、Step4)",
        outcome.status === "approved"
      )
    );
  }

  // ---- [P3b-8] agent(ai) request -> allowed human approve ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "ai", id: "integration.slack.send_message" } }),
      "user-1", "fake-token", backend.deps
    );

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[P3b-8] requestedByActorKind='ai'(既存の唯一のlive producerと同じ形) -> 人間owner(user-1)のapproveは許可される",
        outcome.status === "approved"
      )
    );
  }

  // ---- [P3b-9] requester self reject denied ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "user", id: "user-1" }, taskId: "task-1" }),
      "user-1", "fake-token", backend.deps
    );

    const outcome = await rejectApproval("work-1", "user-1", "fake-token", approval!.id, "自分の依頼を却下", backend.deps);

    const stored = await backend.deps.getApproval("work-1", "user-1", "fake-token", approval!.id);

    results.push(
      check(
        "[P3b-9] requester(kind='user')===approverのreject試行もself_approval_forbiddenで拒否され、Task/Workは変更されない(Step7: self-rejectもwithdrawalとして扱わず拒否する)",
        outcome.status === "self_approval_forbidden" &&
          stored?.status === "pending" &&
          backend.taskStatusUpdates.length === 0
      )
    );
  }

  // ---- [P3b-10] explicit approver reject allowed ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "user", id: "user-a" }, allowedApproverIds: ["user-1"], taskId: "task-1" }),
      "user-1", "fake-token", backend.deps
    );

    const outcome = await rejectApproval("work-1", "user-1", "fake-token", approval!.id, "却下", backend.deps);

    results.push(
      check(
        "[P3b-10] allowlistで明示許可されたapprover(user-1、requester(user-a)とは別人)のrejectは正常に成立する",
        outcome.status === "rejected" &&
          backend.taskStatusUpdates.some((u) => u.taskId === "task-1" && u.status === "failed")
      )
    );
  }

  // ---- [P3b-11] already answered(approved)状態からのself-approval相当の再approveも、既存のalready_resolvedが優先される(fail closedの多重確認) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "user", id: "user-1" }, allowedApproverIds: ["user-1"] }),
      "user-1", "fake-token", backend.deps
    );

    // allowlistでself-approvalが許可されていても、self_approval_forbidden
    // (requester===approver)が優先して働くことを確認する
    // (allowedApproverIdsはself-approval ruleを上書きしない、絶対条件10)。
    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[P3b-11] allowedApproverIdsに自分自身が含まれていても、requester===approverであればself_approval_forbiddenが優先される(allowlistでself-approval ruleを上書きできない)",
        outcome.status === "self_approval_forbidden"
      )
    );
  }

  // ---- [P3b-12] 空配列のallowedApproverIds -> canonical owner-onlyと同じ既定挙動(空配列は「誰も許可しない」ではない) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "ai", id: "cap" }, allowedApproverIds: [] }),
      "user-1", "fake-token", backend.deps
    );

    const outcome = await approveApproval("work-1", "user-1", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[Step9] 空配列のallowedApproverIds -> 空配列はallowlist制限として扱わない(canonical owner-onlyの既定挙動と同じ、Work所有者のapproveは成功する)",
        outcome.status === "approved"
      )
    );
  }

  // ---- [P3b-13] nullのallowedApproverIds(既存の全呼び出し元と同じ形) -> 既定owner-only挙動、regressionなし ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    // makeRequest()はallowedApproverIdsを指定しない(既存の全呼び出し元と同じ形)。
    const approval = await requestApproval(makeRequest(), "user-1", "fake-token", backend.deps);

    results.push(
      check(
        "[Step9] allowedApproverIds未指定 -> undefined/nullのまま保存される(既存呼び出し元の動作を一切変えない)",
        approval?.allowedApproverIds === null || approval?.allowedApproverIds === undefined
      )
    );
  }

  // ---- [P3b-14] 他Work所有者はself-approval判定に到達する前にnot_foundで拒否される(既存ownership defenseが先に働く、優先順位確認) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "user", id: "attacker" } }),
      "user-1", "fake-token", backend.deps
    );

    // "attacker"はWork所有者でもrequesterでもある特殊ケース: Work所有権
    // チェックがself-approval判定より先に働くため、not_foundで止まる
    // (Work自体にownershipが無いため、そもそもgetApproval()が
    // undefinedを返す)。
    const outcome = await approveApproval("work-1", "attacker", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[P3b-14] Work非所有者のapprove試行は、self-approval判定に到達する前にnot_foundで拒否される(既存ownership defenseが最優先、絶対条件11: identity/ownership checksはtrusted canonical boundary)",
        outcome.status === "not_found"
      )
    );
  }

  // ---- [P3b-15] 外部Provider ID(例: Slack user id)をcanonical actorとして直接信用しない(型レベルの確認、Clarificationのtest[16]と対称) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const approval = await requestApproval(
      makeRequest({ requestedByActor: { kind: "user", id: "user-1" }, allowedApproverIds: ["user-1"] }),
      "user-1", "fake-token", backend.deps
    );

    // 生のSlack ID形式("U012ABCDEF")をuserIdとしてそのまま渡しても、
    // 通常のuserIdと全く同じ扱い(Work所有権が無ければnot_found)になる
    // ——外部Provider ID形式を特別に信用する分岐が無いことの直接証拠。
    // (本番では、core/tact-bot/identity/がSlack IDをtactUserIdへ
    // 解決してからこの関数を呼ぶため、生のSlack IDがuserIdとして直接
    // 渡ることは無い——ここではcore層自体にそのような特別扱いの分岐が
    // 存在しないことを確認する。)
    const outcome = await approveApproval("work-1", "U012ABCDEF", "fake-token", approval!.id, undefined, backend.deps);

    results.push(
      check(
        "[P3b-15] 外部Provider形式のraw actor id('U012ABCDEF')はcanonical userIdとして特別扱いされず、Work所有権が無いため通常通りnot_foundになる",
        outcome.status === "not_found"
      )
    );
  }

  // =========================
  // checkApproverAllowed() — pure function unit tests
  // =========================

  {
    const requesterUser: Pick<Approval, "requestedByActorKind" | "requestedByActorId" | "allowedApproverIds"> = {
      requestedByActorKind: "user",
      requestedByActorId: "user-1",
      allowedApproverIds: null,
    };

    results.push(
      check(
        "[checkApproverAllowed] requester(user-1)===decidingUserId(user-1) -> self_approval_forbidden",
        checkApproverAllowed(requesterUser, "user-1").ok === false &&
          (checkApproverAllowed(requesterUser, "user-1") as { ok: false; reason: string }).reason === "self_approval_forbidden"
      )
    );

    results.push(
      check(
        "[checkApproverAllowed] requester(user-1)!==decidingUserId(user-2)、allowlist無し -> ok",
        checkApproverAllowed(requesterUser, "user-2").ok === true
      )
    );

    const requesterAi: Pick<Approval, "requestedByActorKind" | "requestedByActorId" | "allowedApproverIds"> = {
      requestedByActorKind: "ai",
      requestedByActorId: "user-1",
      allowedApproverIds: null,
    };

    results.push(
      check(
        "[checkApproverAllowed] requestedByActorId(文字列として同じ)でも、kind='ai'であればself-approval判定は発火しない(kind差による分離、Step4)",
        checkApproverAllowed(requesterAi, "user-1").ok === true
      )
    );
  }

  return summarize("work/approval", results);

}
