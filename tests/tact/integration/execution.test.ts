// =========================
// TACT Integration — Execution Boundary Regression
// (Architecture Migration Phase C1)
// =========================
//
// 対象: core/tact-integration/execution.tsのexecuteApprovedIntegration
// Action()。実Supabase・実Composio APIには一切接続しない
// (ExecuteApprovedIntegrationActionDeps経由でStore呼び出し・
// Integration Gateway自体を偽実装に差し替える)。
//
// 最重要確認事項(Phase C1 Section17/20/21、絶対条件):
//   - Approvalがapproved以外の間は、Integration Gateway(=Composio)
//     呼び出しが1回も発生しないこと
//   - Workがrunning以外の場合も同様に発生しないこと
//   - Connection ownership/statusが不正な場合も同様に発生しないこと
//   - 承認後は正確に1回だけdispatchされ、Run lifecycleへ反映されること
//   - 同一approvalIdに対し既に成功済みのRunがあれば再dispatchしない
//     (Execution deduplication)
//   - 所有権を偽装したuserId(cross-user)では一切実行に到達しない

import { executeApprovedIntegrationAction, type ExecuteApprovedIntegrationActionDeps } from "../../../core/tact-integration/execution";
import type { Work, Approval, Run, WorkTask } from "../../../core/tact-work/types";
import type { Connection, IntegrationExecutionResult } from "../../../core/tact-integration/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: OWNER_USER_ID,
    createdByActorKind: "user",
    createdByActorId: OWNER_USER_ID,
    status: "running",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "phase-c1-mock",
    requestedFromActorKind: "user",
    requestedFromActorId: OWNER_USER_ID,
    status: "approved",
    reason: "test",
    payload: {
      action: {
        kind: "integration_action",
        summary: "Slackへ投稿します",
        metadata: {
          service: "slack",
          operation: "send_message",
          input: { channel: "#general", text: "hi" },
          connectionId: "conn-1",
        },
      },
    },
    requestedAt: "2026-09-07T00:00:00.000Z",
    createdAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    userId: OWNER_USER_ID,
    service: "slack",
    status: "active",
    provider: "composio",
    providerConnectionRef: "ca_slack_123",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

// Architecture Migration Phase C2.1c-a-fix: 既定はpending(canonical
// lifecycle上、Approval承認直後のTaskが実際に持つ状態)。
function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    workId: "work-1",
    description: "test",
    status: "pending",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    workId: "work-1",
    taskId: "task-1",
    attempt: 1,
    capability: "integration.slack.send_message",
    provider: "composio",
    status: "running",
    startedAt: "2026-09-07T00:00:00.000Z",
    createdAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

// テストごとの呼び出し記録付きdepsを作る。overridesで任意の関数を
// 差し替えられる(所有権ガード・失敗経路・dedup等、テストごとに
// 異なる振る舞いが必要なため)。
function makeDeps(overrides: Partial<ExecuteApprovedIntegrationActionDeps> = {}) {

  const calls = {
    getWorkCalls: 0,
    getApprovalCalls: 0,
    getConnectionCalls: 0,
    listTasksForWorkCalls: 0,
    listRunsForTaskCalls: 0,
    createRunCalls: 0,
    completeRunCalls: 0,
    failRunCalls: 0,
    updateTaskStatusCalls: [] as { taskId: string; status: string }[],
    executeIntegrationActionCalls: 0,
    reconcileWorkCompletionStatusCalls: 0,
  };

  const deps: ExecuteApprovedIntegrationActionDeps = {

    getWork: async (workId, userId) => {
      calls.getWorkCalls += 1;
      if (userId !== OWNER_USER_ID) return undefined;
      return makeWork({ id: workId });
    },

    getApproval: async (workId, userId, accessToken, approvalId) => {
      calls.getApprovalCalls += 1;
      if (userId !== OWNER_USER_ID) return undefined;
      return makeApproval({ id: approvalId, workId });
    },

    getConnection: async (connectionId, userId) => {
      calls.getConnectionCalls += 1;
      if (userId !== OWNER_USER_ID) return undefined;
      return makeConnection({ id: connectionId });
    },

    listTasksForWork: async () => {
      calls.listTasksForWorkCalls += 1;
      return [makeTask()];
    },

    listRunsForTask: async () => {
      calls.listRunsForTaskCalls += 1;
      return [];
    },

    createRun: async (workId, userId, accessToken, taskId, params) => {
      calls.createRunCalls += 1;
      return makeRun({ workId, taskId, attempt: params.attempt, capability: params.capability, provider: params.provider ?? null });
    },

    completeRun: async () => {
      calls.completeRunCalls += 1;
    },

    failRun: async () => {
      calls.failRunCalls += 1;
    },

    updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
      calls.updateTaskStatusCalls.push({ taskId, status });
    },

    executeIntegrationAction: async (): Promise<IntegrationExecutionResult> => {
      calls.executeIntegrationActionCalls += 1;
      return { status: "completed", providerExecutionRef: "log-1", output: { ok: true } };
    },

    reconcileWorkCompletionStatus: async () => {
      calls.reconcileWorkCompletionStatusCalls += 1;
      return { status: "no_change", reason: "tasks_not_all_terminal" };
    },

    ...overrides,

  };

  return { deps, calls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Work/Approvalが見つからない ----
  {
    const { deps, calls } = makeDeps({ getWork: async () => undefined });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Not found] Workが見つからない場合、status=not_foundを返しComposio呼び出しは0回",
        outcome.status === "not_found" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  {
    const { deps, calls } = makeDeps({ getApproval: async () => undefined });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Not found] Approvalが見つからない場合、status=not_foundを返しComposio呼び出しは0回",
        outcome.status === "not_found" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) =>
        makeApproval({ id: approvalId, workId, taskId: null }),
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Not found] Approval.taskIdが無い場合もstatus=not_foundを返す(Task無しにRunを作れない)",
        outcome.status === "not_found" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Approval状態ガード(絶対条件Section15: Approvalより先に実行しない) ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) =>
        makeApproval({ id: approvalId, workId, status: "pending" }),
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Approval gate] Approval.statusがpendingの場合、approval_not_approvedを返しComposio呼び出しは0回",
        outcome.status === "approval_not_approved" &&
          (outcome as { approvalStatus: string }).approvalStatus === "pending" &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.createRunCalls === 0
      )
    );
  }

  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) =>
        makeApproval({ id: approvalId, workId, status: "rejected" }),
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Approval gate] reject済みApprovalではComposio呼び出しが0回のまま(絶対条件: reject時Provider call 0)",
        outcome.status === "approval_not_approved" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Work状態ガード ----
  {
    const { deps, calls } = makeDeps({
      getWork: async (workId, userId) =>
        userId === OWNER_USER_ID ? makeWork({ id: workId, status: "waiting_for_approval" }) : undefined,
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Work gate] Work.statusがrunning以外(他のApprovalが未解決)の場合、work_not_runnableを返し実行しない",
        outcome.status === "work_not_runnable" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Connection ownership/state ----
  {
    const { deps, calls } = makeDeps({ getConnection: async () => undefined });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Connection] Connectionが見つからない場合、connection_unavailableを返す",
        outcome.status === "connection_unavailable" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  {
    const { deps, calls } = makeDeps({
      getConnection: async (connectionId, userId) =>
        userId === OWNER_USER_ID ? makeConnection({ id: connectionId, status: "revoked" }) : undefined,
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Connection] Connection.statusがactive以外(revoked)の場合、connection_unavailableを返す",
        outcome.status === "connection_unavailable" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Invalid action(Approval.payloadから復元できない) ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) =>
        makeApproval({ id: approvalId, workId, payload: {} }),
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Invalid action] Approval.payloadから有効なactionを復元できない場合、invalid_actionを返し実行しない",
        outcome.status === "invalid_action" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- 正常系: 承認後、正確に1回だけdispatchされCompleteRun/Task完了へ反映される ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[承認後] executeIntegrationAction()が正確に1回だけ呼ばれる(絶対条件Section20: 自動retryしない)",
        calls.executeIntegrationActionCalls === 1
      )
    );

    results.push(
      check(
        "[承認後] 成功時はcompleteRun()が呼ばれ、failRun()は呼ばれない、status=completedを返す",
        outcome.status === "completed" && calls.completeRunCalls === 1 && calls.failRunCalls === 0
      )
    );

    results.push(
      check(
        "[承認後] Taskはrunning->completedへ更新される",
        calls.updateTaskStatusCalls[0]?.status === "running" &&
          calls.updateTaskStatusCalls[calls.updateTaskStatusCalls.length - 1]?.status === "completed"
      )
    );

    results.push(
      check(
        "[Phase C2.1c-a] Task status update historyが厳密に['running','completed']の順序のみ(completed→runningという巻き戻しが存在しないことの直接証拠)",
        JSON.stringify(calls.updateTaskStatusCalls.map((c) => c.status)) === JSON.stringify(["running", "completed"])
      )
    );

    results.push(
      check(
        "[Phase C2.1a] 成功後、reconcileWorkCompletionStatus()が呼ばれる(architecture debt A解消)",
        calls.reconcileWorkCompletionStatusCalls === 1
      )
    );
  }

  // ---- 失敗系: Providerがfailedを返した場合 ----
  {
    const { deps, calls } = makeDeps({
      executeIntegrationAction: async (): Promise<IntegrationExecutionResult> => {
        calls.executeIntegrationActionCalls += 1;
        return { status: "failed", error: { code: "provider_execution_failed", message: "boom", retryable: false } };
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[失敗系] Provider失敗時はfailRun()が呼ばれ、既存のfailed stateへ落とす(新しいunknown statusを追加しない)",
        outcome.status === "failed" && calls.failRunCalls === 1 && calls.completeRunCalls === 0
      )
    );

    results.push(
      check(
        "[失敗系] Taskもfailedへ更新される",
        calls.updateTaskStatusCalls[calls.updateTaskStatusCalls.length - 1]?.status === "failed"
      )
    );

    results.push(
      check(
        "[Phase C2.1c-a] Task status update historyが厳密に['running','failed']の順序のみ(completedを一度も挟まない)",
        JSON.stringify(calls.updateTaskStatusCalls.map((c) => c.status)) === JSON.stringify(["running", "failed"])
      )
    );

    results.push(
      check(
        "[失敗系] 失敗時もexecuteIntegrationAction()は1回のみ(自動retryしない)",
        calls.executeIntegrationActionCalls === 1
      )
    );

    results.push(
      check(
        "[Phase C2.1a] 失敗後も、reconcileWorkCompletionStatus()が呼ばれる(architecture debt A解消)",
        calls.reconcileWorkCompletionStatusCalls === 1
      )
    );
  }

  // ---- Phase C2.1a絶対条件(Case9): reconciliation自体が失敗しても、
  // 既に確定した外部side effect(successful)をfailedへ巻き戻したり
  // retry可能な失敗として扱ってはいけない ----
  {
    const { deps, calls } = makeDeps({
      reconcileWorkCompletionStatus: async () => {
        calls.reconcileWorkCompletionStatusCalls += 1;
        throw new Error("simulated reconciliation failure (e.g. transient DB error)");
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Phase C2.1a絶対条件] reconciliation失敗時も、外部executionがsuccessfulだった結果はcompletedのまま変わらない(failedへ巻き戻さない)",
        outcome.status === "completed" &&
          calls.completeRunCalls === 1 &&
          calls.failRunCalls === 0 &&
          calls.reconcileWorkCompletionStatusCalls === 1
      )
    );

    results.push(
      check(
        "[Phase C2.1a絶対条件] reconciliation失敗時も、executeIntegrationAction()(=Composio/Slack呼び出し)は再実行されない(1回のまま)",
        calls.executeIntegrationActionCalls === 1
      )
    );
  }

  // ---- Execution deduplication(絶対条件Section21) ----
  // ---- Case6(C2.1c-a-fix): Taskがcompleted(=実際に成功済みの状態)
  // であっても、既存completed Run/externalRefがあればalready_executed
  // semanticsが維持される(Phase C2.1c-a-fixで追加したTask state
  // preconditionが、このC1.5 dedupより"後"に置かれているため、
  // completed Taskをtask_not_executableとして誤って弾かないこと
  // を確認する、最重要regression) ----
  {
    const existingRun = makeRun({
      id: "run-existing",
      status: "completed",
      externalRef: { approvalId: "approval-1", providerExecutionRef: "log-existing" },
    });

    const { deps, calls } = makeDeps({
      listTasksForWork: async () => {
        calls.listTasksForWorkCalls += 1;
        return [makeTask({ status: "completed" })];
      },
      listRunsForTask: async () => {
        calls.listRunsForTaskCalls += 1;
        return [existingRun];
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Dedup/Case6] 同一approvalIdで既に成功済みのRunがある場合、Taskがcompletedでもalready_executedを返しComposioを再実行しない(task_not_executableへ誤って倒れない)",
        outcome.status === "already_executed" &&
          (outcome as { run: Run }).run.id === "run-existing" &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.createRunCalls === 0 &&
          calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // ---- Case1(C2.1c-a-fix): Task pending -> execution開始可能 ----
  // (既存の「正常系: 承認後...」ブロック(makeDeps()の既定Task=pending
  // を使用)と、そこに追加済みの['running','completed']厳密一致
  // assertionが、このCase1の内容をそのまま検証済みのため、重複した
  // testは追加しない。)

  // ---- Case2(C2.1c-a-fix): Task completed(既存completed Run無し) ->
  // 新規executionを開始せず安全に停止する ----
  {
    const { deps, calls } = makeDeps({
      listTasksForWork: async () => {
        calls.listTasksForWorkCalls += 1;
        return [makeTask({ status: "completed" })];
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Case2] completed Task(既存completed Run無し) -> task_not_executable、provider call 0・Run新規作成0・Task update 0",
        outcome.status === "task_not_executable" &&
          (outcome as { taskStatus: string }).taskStatus === "completed" &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.createRunCalls === 0 &&
          calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // ---- Case3(C2.1c-a-fix): Task failed(既存completed Run無し) ----
  {
    const { deps, calls } = makeDeps({
      listTasksForWork: async () => {
        calls.listTasksForWorkCalls += 1;
        return [makeTask({ status: "failed" })];
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Case3] failed Task(既存completed Run無し) -> task_not_executable、provider call 0・Run新規作成0・Task update 0",
        outcome.status === "task_not_executable" &&
          (outcome as { taskStatus: string }).taskStatus === "failed" &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.createRunCalls === 0 &&
          calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // ---- Case4(C2.1c-a-fix): Task cancelled(既存completed Run無し) ----
  {
    const { deps, calls } = makeDeps({
      listTasksForWork: async () => {
        calls.listTasksForWorkCalls += 1;
        return [makeTask({ status: "cancelled" })];
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Case4] cancelled Task(既存completed Run無し) -> task_not_executable、provider call 0・Run新規作成0・Task update 0",
        outcome.status === "task_not_executable" &&
          (outcome as { taskStatus: string }).taskStatus === "cancelled" &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.createRunCalls === 0 &&
          calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // ---- Case5(C2.1c-a-fix): Task running(既存completed dedup Run無し)
  // -> 新規provider callを勝手に開始しない(既存Run dedupとは別の
  // 防御層——dedupはcompletedのRunだけを見るため、completedに至らず
  // runningのまま取り残されたケースをここで捕捉する) ----
  {
    const { deps, calls } = makeDeps({
      listTasksForWork: async () => {
        calls.listTasksForWorkCalls += 1;
        return [makeTask({ status: "running" })];
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Case5] running Task(既存completed dedup Run無し) -> 新規provider callを開始しない(task_not_executable)",
        outcome.status === "task_not_executable" &&
          (outcome as { taskStatus: string }).taskStatus === "running" &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.createRunCalls === 0 &&
          calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // ---- Case7(C2.1c-a-fix): Approval.taskIdに対応するTaskが存在しない
  // (missing/invalid Task、Work/Task/Approvalの対応が壊れている場合を
  // 含む) ----
  {
    const { deps, calls } = makeDeps({
      listTasksForWork: async () => {
        calls.listTasksForWorkCalls += 1;
        return []; // 対応するTaskが見つからない
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Case7] Approval.taskIdに対応するTaskが存在しない -> not_found、provider call 0・Run新規作成0・Task update 0",
        outcome.status === "not_found" &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.createRunCalls === 0 &&
          calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // ---- Cross-user: 所有していないWork/Approval/Connectionには到達できない ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await executeApprovedIntegrationAction("work-1", "attacker", "token", "approval-1", deps);

    results.push(
      check(
        "[Cross-user] 所有権が無いuserIdではnot_foundとなり、Composio呼び出しは一切発生しない",
        outcome.status === "not_found" && calls.executeIntegrationActionCalls === 0 && calls.createRunCalls === 0
      )
    );
  }

  return summarize("integration/execution", results);

}
