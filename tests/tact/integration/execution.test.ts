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

import {
  executeApprovedIntegrationAction,
  executeReadIntegrationAction,
  type ExecuteApprovedIntegrationActionDeps,
} from "../../../core/tact-integration/execution";
import { mapSlackActionToComposioTool } from "../../../core/tact-integration/providers/composio/mappings/slack";
import { buildExecutionResultFromToolResult } from "../../../core/tact-integration/providers/composio/adapter";
import type { Work, Approval, Run, WorkTask } from "../../../core/tact-work/types";
import type { Connection, IntegrationExecutionResult } from "../../../core/tact-integration/types";
import {
  buildApprovalSubject,
  canonicalizeApprovalSubject,
  hashApprovalSubject,
  type ApprovalSubject,
} from "../../../core/tact-work/approvalIntegrity";
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

// Architecture Migration ARCH-P1c: makeApproval()の既定payload
// (service/operation/input/connectionId)とcanonicalに一致する
// Approval Subject。既定のmakeApproval()呼び出し(payloadを上書き
// しない大半のtest)が、新しく追加されたApproval Integrity検証
// (core/tact-integration/execution.ts)をそのまま通過できるように
// する——これらのtestは元々Task/Run/Connection/Work state分岐を
// 検証するためのものであり、Integrity検証自体を検証する意図では
// ないため、既定では常にmatchする状態を用意する(既存assertionを
// 弱めずに、無関係なintegrity gateで足止めしない)。
function makeMatchingSubject(overrides: Partial<ApprovalSubject> = {}): ApprovalSubject {

  const result = buildApprovalSubject({
    workId: "work-1",
    taskId: "task-1",
    service: "slack",
    operation: "send_message",
    input: { channel: "#general", text: "hi" },
    connectionId: "conn-1",
    riskClassSnapshot: "write",
  });

  if (!result.ok) {
    throw new Error("test fixture itself must be buildable (canonical input is JSON-safe by construction)");
  }

  return { ...result.subject, ...overrides };

}

function subjectStorageFields(subject: ApprovalSubject): Pick<Approval, "subjectVersion" | "subject" | "subjectHash"> {

  return {
    subjectVersion: subject.subjectVersion,
    subject: subject as unknown as Record<string, unknown>,
    subjectHash: hashApprovalSubject(canonicalizeApprovalSubject(subject)),
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
    ...subjectStorageFields(makeMatchingSubject()),
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

  // =========================
  // Architecture Migration Phase C2.2: Policy defense-in-depth
  // (executeApprovedIntegrationAction()側、Section11)
  // =========================

  // ---- 未知operationのApprovalは実行させない(policy allowlist再検証) ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) =>
        makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "test",
              metadata: {
                service: "slack",
                operation: "delete_channel",
                input: {},
                connectionId: "conn-1",
              },
            },
          },
        }),
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Policy defense] policy allowlistに存在しないoperation(slack.delete_channel)はApproval経由でも実行されない(invalid_action、provider call 0)",
        outcome.status === "invalid_action" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- read policyのactionはApproval経由で実行させない ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) =>
        makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "test",
              metadata: {
                service: "slack",
                operation: "list_channels",
                input: {},
                connectionId: "conn-1",
              },
            },
          },
        }),
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Policy defense] riskClass='read'のaction(slack.list_channels)はApproval経由の境界へ渡っても実行されない(invalid_action、provider call 0、絶対条件Section11)",
        outcome.status === "invalid_action" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // =========================
  // Architecture Migration ARCH-P1c: Approval Integrity Verification
  // (docs/architecture/approval-integrity.md)
  // =========================
  //
  // 対象: executeApprovedIntegrationAction()の、dedup直後・Run作成前に
  // 挿入されたIntegrity検証ステップ。makeApproval()の既定subjectは
  // 既定payload(service=slack/operation=send_message/
  // input={channel:"#general",text:"hi"}/connectionId="conn-1")と
  // 常にmatchするよう構築済みのため(このfile冒頭のmakeMatchingSubject()
  // 参照)、ここまでの全既存test(Task/Run/Connection/Work state分岐)は
  // 無関係にIntegrity検証を通過している——このsectionはIntegrity
  // 検証自体を専用に検証する。

  // ---- Case1: exact same subject -> 通常通りprovider実行(1回) ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case1] stored subjectとcurrent subjectが完全一致する場合、通常通りproviderが1回呼ばれ、completedを返す",
        outcome.status === "completed" && calls.executeIntegrationActionCalls === 1 && calls.createRunCalls === 1
      )
    );
  }

  // ---- Case2〜9: 各fieldの変化がintegrity failureを引き起こす ----
  {

    // canonicalInput変化(channelが変わる) -> payload自体(=extractされる
    // current action)を変えることで、stored subjectとの不一致を作る。
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "Slackへ投稿します",
              metadata: {
                service: "slack",
                operation: "send_message",
                input: { channel: "#general-CHANGED", text: "hi" },
                connectionId: "conn-1",
              },
            },
          },
          // subject/subjectHashは意図的に既定(古いchannelのまま)を
          // 維持する(=approved時点で承認された内容)。
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case2] canonicalInput(channel)が承認後に変化した場合、approval_integrity_failedを返し、provider call 0・Run作成0",
        outcome.status === "approval_integrity_failed" &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.createRunCalls === 0
      )
    );

    results.push(
      check(
        "[ARCH-P1c/Case2] mismatch reasonはsubject_mismatch(内部診断用、Bot向けには出さない)",
        outcome.status === "approval_integrity_failed" && outcome.reason === "subject_mismatch"
      )
    );

  }

  // ---- Case3: target(text)変化 -> integrity failure ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "Slackへ投稿します",
              metadata: {
                service: "slack",
                operation: "send_message",
                input: { channel: "#general", text: "hi (CHANGED CONTENT)" },
                connectionId: "conn-1",
              },
            },
          },
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case3] canonicalInput(text)が承認後に変化した場合、approval_integrity_failedを返しprovider call 0",
        outcome.status === "approval_integrity_failed" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case4: service変化 -> policy再検証(5.5)の時点で既にinvalid_actionへ
  // 倒れるため、そもそもIntegrity検証へ到達しない(絶対条件Step6C:
  // Policy DENYがApprovalより優先される)ことを確認する ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "test",
              metadata: {
                service: "gmail",
                operation: "send_message",
                input: { channel: "#general", text: "hi" },
                connectionId: "conn-1",
              },
            },
          },
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case4] serviceが承認後に変化した場合、policy allowlistに存在しないためinvalid_action(Policy側の既存defense-in-depthが先に働く、Integrity検証より手前)、provider call 0",
        outcome.status === "invalid_action" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case5: operation変化(同一service内) -> policy allowlist未登録の
  // operationならinvalid_action、登録済みのoperationならIntegrity
  // mismatchとして拒否される。ここではpolicy未登録のoperationへ
  // 変化させ、Policy defenseが先に働くことを確認する ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "test",
              metadata: {
                service: "slack",
                operation: "delete_channel",
                input: { channel: "#general", text: "hi" },
                connectionId: "conn-1",
              },
            },
          },
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case5] operationが承認後に変化した場合(未登録operationへ)、invalid_action(Policy defenseが先に働く)、provider call 0",
        outcome.status === "invalid_action" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // Architecture Migration ARCH-P1c: Case6〜9は「stored subjectの1
  // fieldだけが承認時から実際にずれていた」状況(将来のバグ等を想定した
  // 防御的シナリオ)を模す。stored subject自身は自己矛盾しない
  // (=そのsubject_jsonに対して正しいhashを持つ)ようにした上で、
  // current subject(=Work/Approval/Connection/Policyという別々の
  // sourceから毎回再構築される値)とだけ食い違わせる——そうしないと
  // 単なるhash_mismatchになってしまい、「fieldの内容自体が違う」という
  // subject_mismatchの検証にならない。
  function makeTamperedApprovalOverrides(
    subjectOverrides: Partial<ApprovalSubject>
  ): Pick<Approval, "subjectVersion" | "subject" | "subjectHash"> {
    const tamperedSubject = makeMatchingSubject(subjectOverrides);
    return subjectStorageFields(tamperedSubject);
  }

  // ---- Case6: workId mismatch ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          ...makeTamperedApprovalOverrides({ workId: "work-DIFFERENT" }),
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case6] stored subject.workIdがcurrent Work.idと一致しない場合、approval_integrity_failed(subject_mismatch)、provider call 0",
        outcome.status === "approval_integrity_failed" &&
          (outcome as { reason?: string }).reason === "subject_mismatch" &&
          calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case7: taskId mismatch ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          ...makeTamperedApprovalOverrides({ taskId: "task-DIFFERENT" }),
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case7] stored subject.taskIdがApproval.taskId(current)と一致しない場合、approval_integrity_failed(subject_mismatch)、provider call 0",
        outcome.status === "approval_integrity_failed" &&
          (outcome as { reason?: string }).reason === "subject_mismatch" &&
          calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case8: connectionId mismatch ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          ...makeTamperedApprovalOverrides({ connectionId: "conn-DIFFERENT" }),
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case8] stored subject.connectionIdがcurrent connectionIdと一致しない場合、approval_integrity_failed(subject_mismatch)、provider call 0",
        outcome.status === "approval_integrity_failed" &&
          (outcome as { reason?: string }).reason === "subject_mismatch" &&
          calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case9: riskClass変化(escalation) -> stored側のriskClassSnapshot
  // だけを実際のpolicy結果("write")と異なる値にずらすことで、
  // 「承認時点と現在でrisk classificationが変わった」状況を模す ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          ...makeTamperedApprovalOverrides({ riskClassSnapshot: "destructive" }),
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case9] stored riskClassSnapshotがcurrent policy評価結果と一致しない場合(riskClass escalation/変化)、approval_integrity_failed(subject_mismatch)、provider call 0——古いApprovalをそのまま使わせない",
        outcome.status === "approval_integrity_failed" &&
          (outcome as { reason?: string }).reason === "subject_mismatch" &&
          calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case10〜16: stored evidence自体が欠落/壊れている場合、fail closed ----
  {

    // Case10: subject_version欠落(undefined)
    {
      const { deps, calls } = makeDeps({
        getApproval: async (workId, userId, _accessToken, approvalId) => {
          if (userId !== OWNER_USER_ID) return undefined;
          const approval = makeApproval({ id: approvalId, workId });
          return { ...approval, subjectVersion: undefined };
        },
      });

      const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

      results.push(
        check(
          "[ARCH-P1c/Case10] subjectVersion欠落(ARCH-P1b以前のlegacy Approval相当)はfail closedされる(approval_integrity_failed、version_unsupported)、provider call 0",
          outcome.status === "approval_integrity_failed" &&
            (outcome as { reason?: string }).reason === "version_unsupported" &&
            calls.executeIntegrationActionCalls === 0
        )
      );
    }

    // Case11: subject_json欠落(undefined、subjectVersionだけ残る想定外の形)
    {
      const { deps, calls } = makeDeps({
        getApproval: async (workId, userId, _accessToken, approvalId) => {
          if (userId !== OWNER_USER_ID) return undefined;
          const approval = makeApproval({ id: approvalId, workId });
          return { ...approval, subject: undefined };
        },
      });

      const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

      results.push(
        check(
          "[ARCH-P1c/Case11] subject_json欠落はfail closedされる(approval_integrity_failed、stored_subject_invalid)、provider call 0",
          outcome.status === "approval_integrity_failed" &&
            (outcome as { reason?: string }).reason === "stored_subject_invalid" &&
            calls.executeIntegrationActionCalls === 0
        )
      );
    }

    // Case12: subject_hash欠落
    {
      const { deps, calls } = makeDeps({
        getApproval: async (workId, userId, _accessToken, approvalId) => {
          if (userId !== OWNER_USER_ID) return undefined;
          const approval = makeApproval({ id: approvalId, workId });
          return { ...approval, subjectHash: undefined };
        },
      });

      const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

      results.push(
        check(
          "[ARCH-P1c/Case12] subject_hash欠落はfail closedされる(approval_integrity_failed、hash_mismatch)、provider call 0",
          outcome.status === "approval_integrity_failed" &&
            (outcome as { reason?: string }).reason === "hash_mismatch" &&
            calls.executeIntegrationActionCalls === 0
        )
      );
    }

    // Case13: malformed subject(必須fieldが欠けたobject)
    {
      const { deps, calls } = makeDeps({
        getApproval: async (workId, userId, _accessToken, approvalId) => {
          if (userId !== OWNER_USER_ID) return undefined;
          const approval = makeApproval({ id: approvalId, workId });
          return { ...approval, subject: { garbage: true } };
        },
      });

      const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

      results.push(
        check(
          "[ARCH-P1c/Case13] malformedなsubject_json(必須field欠落)はfail closedされる(approval_integrity_failed、stored_subject_invalid)",
          outcome.status === "approval_integrity_failed" &&
            (outcome as { reason?: string }).reason === "stored_subject_invalid" &&
            calls.executeIntegrationActionCalls === 0
        )
      );
    }

    // Case14: unsupported version(未知のversion番号)
    {
      const { deps, calls } = makeDeps({
        getApproval: async (workId, userId, _accessToken, approvalId) => {
          if (userId !== OWNER_USER_ID) return undefined;
          const subject = { ...makeMatchingSubject(), subjectVersion: 999 };
          return makeApproval({
            id: approvalId,
            workId,
            subjectVersion: 999,
            subject: subject as unknown as Record<string, unknown>,
            subjectHash: hashApprovalSubject(canonicalizeApprovalSubject(subject)),
          });
        },
      });

      const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

      results.push(
        check(
          "[ARCH-P1c/Case14] サポート外のsubject_version(未知の数値)はfail closedされる(approval_integrity_failed、version_unsupported)",
          outcome.status === "approval_integrity_failed" &&
            (outcome as { reason?: string }).reason === "version_unsupported" &&
            calls.executeIntegrationActionCalls === 0
        )
      );
    }

    // Case15: stored hash mismatch(subject_jsonは正しいが、hashだけ壊れている)
    {
      const { deps, calls } = makeDeps({
        getApproval: async (workId, userId, _accessToken, approvalId) => {
          if (userId !== OWNER_USER_ID) return undefined;
          return makeApproval({
            id: approvalId,
            workId,
            subjectHash: "0".repeat(64),
          });
        },
      });

      const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

      results.push(
        check(
          "[ARCH-P1c/Case15] subject_hashがsubject_jsonの実際の内容と一致しない場合、fail closedされる(approval_integrity_failed、hash_mismatch)",
          outcome.status === "approval_integrity_failed" &&
            (outcome as { reason?: string }).reason === "hash_mismatch" &&
            calls.executeIntegrationActionCalls === 0
        )
      );
    }

    // Case16: DB subject_version列とsubject_json内部のsubjectVersionが
    // 食い違う(single source of truthの不整合)。DB列側は
    // APPROVAL_SUBJECT_VERSION(サポート対象)のままにする必要がある
    // ——そうしないと、verifyApprovalIntegrity()の1段目のcheck
    // (stored.version !== APPROVAL_SUBJECT_VERSION)がversion_unsupported
    // として先に短絡してしまい、「DBとJSON内部の食い違い」自体を
    // 検証できない。
    {
      const { deps, calls } = makeDeps({
        getApproval: async (workId, userId, _accessToken, approvalId) => {
          if (userId !== OWNER_USER_ID) return undefined;
          // subject_json内部のsubjectVersionだけを2に改ざんする
          // (DB列subjectVersionはAPPROVAL_SUBJECT_VERSION=1のまま)。
          const subject = { ...makeMatchingSubject(), subjectVersion: 2 };
          return makeApproval({
            id: approvalId,
            workId,
            subjectVersion: 1,
            subject: subject as unknown as Record<string, unknown>,
            subjectHash: hashApprovalSubject(canonicalizeApprovalSubject(subject)),
          });
        },
      });

      const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

      results.push(
        check(
          "[ARCH-P1c/Case16] DB列subject_versionとsubject_json内部のsubjectVersionが食い違う場合、fail closedされる(approval_integrity_failed、stored_subject_invalid、single source of truth不整合検知)",
          outcome.status === "approval_integrity_failed" &&
            (outcome as { reason?: string }).reason === "stored_subject_invalid" &&
            calls.executeIntegrationActionCalls === 0
        )
      );
    }

  }

  // ---- Case17: key順序だけが異なるcanonicalInput -> matchする ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "Slackへ投稿します",
              // 既定payloadと同じ内容だが、object literalのkey順序を
              // 入れ替えるだけ({text, channel}の順)。
              metadata: {
                operation: "send_message",
                service: "slack",
                connectionId: "conn-1",
                input: { text: "hi", channel: "#general" },
              },
            },
          },
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case17] canonicalInput/metadataのkey順序だけが異なる場合はmatchする(deterministic canonicalization)、providerが正常に呼ばれる",
        outcome.status === "completed" && calls.executeIntegrationActionCalls === 1
      )
    );
  }

  // ---- Case18: exact approved re-entry(既にapproved状態のApprovalへ
  // 同じ内容で再度到達)は安全にexecuteされる(dedup前ならexecute、
  // dedup後ならalready_executed) ----
  {
    const { deps } = makeDeps();

    const first = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);
    // 2回目の呼び出し(例: Bot decision callbackの再送)は、1回目の
    // 成功が既にcreateRunCalls経由でRunとして記録されているという
    // 前提が無いこの単純fakeでは、listRunsForTaskが常に[]を返すため
    // dedup条件そのものは別test(Case32)で確認する。ここではre-entryの
    // たびにIntegrity検証が再実行されること自体を、mismatch側の
    // Case19と対比して確認する。
    void first;

    results.push(
      check(
        "[ARCH-P1c/Case18] 同一subject(変化なし)でのre-entryは安全に成功する(Integrity検証を再実行しても一致するため)",
        (await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps)).status === "completed"
      )
    );
  }

  // ---- Case19: changed subject re-entry -> 毎回検証するため、2回目以降も
  // 一貫してfail closedされる(1回目の検証結果をcacheしない) ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "test",
              metadata: {
                service: "slack",
                operation: "send_message",
                input: { channel: "#general-CHANGED", text: "hi" },
                connectionId: "conn-1",
              },
            },
          },
        });
      },
    });

    const first = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);
    const second = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case19] 内容が変化したApprovalへのre-entryは、1回目・2回目いずれもfail closedされる(絶対条件Step12: execution boundaryへ入るたび毎回検証する、decision時だけの検証で終わらない)",
        first.status === "approval_integrity_failed" &&
          second.status === "approval_integrity_failed" &&
          calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case26/27/28: Integrity failure時のprovider call/Run/Approval.status ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "test",
              metadata: {
                service: "slack",
                operation: "send_message",
                input: { channel: "#general-CHANGED", text: "hi" },
                connectionId: "conn-1",
              },
            },
          },
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case26] Integrity failure時、provider call countは0",
        outcome.status === "approval_integrity_failed" && calls.executeIntegrationActionCalls === 0
      )
    );

    results.push(
      check(
        "[ARCH-P1c/Case27] Integrity failure時、Run作成countは0(createRunCalls===0、Run='1回のexecution attempt'という定義上、Integrity Gateで拒否された時点でattemptは開始されていない)",
        calls.createRunCalls === 0
      )
    );

    results.push(
      check(
        "[ARCH-P1c/Case28] Integrity failure時、updateTaskStatus()も一切呼ばれない(Taskはpendingのまま、Approval.status自体もこの境界からは一切変更されない——deps自体にupdateApprovalStatus的なものが無い設計を維持)",
        calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // ---- Case29: 現在のPolicyがDENY相当(未登録/read)なら、Integrityが
  // matchしていてもApprovalはそれをoverrideしない ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        // stored subjectはread操作(list_channels)に対して"完全に一致"
        // するよう構築するが、list_channelsはpolicy上read(Approval
        // 経由の実行対象外)であるため、Integrityがmatchしても
        // invalid_actionで拒否されるべき。
        const subjectResult = buildApprovalSubject({
          workId: "work-1",
          taskId: "task-1",
          service: "slack",
          operation: "list_channels",
          input: {},
          connectionId: "conn-1",
          riskClassSnapshot: "read",
        });
        if (!subjectResult.ok) throw new Error("unreachable");
        const subject = subjectResult.subject;
        return makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "test",
              metadata: { service: "slack", operation: "list_channels", input: {}, connectionId: "conn-1" },
            },
          },
          subjectVersion: subject.subjectVersion,
          subject: subject as unknown as Record<string, unknown>,
          subjectHash: hashApprovalSubject(canonicalizeApprovalSubject(subject)),
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case29] Integrityが完全match(stored=currentで一致)していても、現在のPolicyがreadを示す操作はinvalid_actionで拒否される(絶対条件Step6C: ApprovalはPolicy DENYをoverrideしない、Policy再検証がIntegrity検証より先に働く)",
        outcome.status === "invalid_action" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case31: 同一TACT connectionIdのまま、Connection内部の
  // providerConnectionRef(内部credential参照)だけが変化した場合は
  // integrity matchを維持する(credential rotationはAction semantic
  // changeではない、絶対条件Step7) ----
  {
    const { deps, calls } = makeDeps({
      getConnection: async (connectionId, userId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        // providerConnectionRef(内部credential参照)だけを変更する。
        // connectionId自体(TACT-owned)は不変。
        return makeConnection({ id: connectionId, providerConnectionRef: "ca_slack_ROTATED" });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case31] 同一TACT connectionIdのまま、Connection内部のproviderConnectionRef(credential参照)だけが変化してもintegrity matchは維持される(provider mechanicsであり、人間が再承認すべきAction semantic changeではない)",
        outcome.status === "completed" && calls.executeIntegrationActionCalls === 1
      )
    );
  }

  // ---- Case32: 既にcompleted Run(同一subject) -> already_executed(dedup優先) ----
  {
    const existingRun = makeRun({
      id: "run-existing",
      taskId: "task-1",
      attempt: 1,
      status: "completed",
      externalRef: { approvalId: "approval-1", providerExecutionRef: "log-0" },
    });

    const { deps, calls } = makeDeps({
      listRunsForTask: async () => {
        calls.listRunsForTaskCalls += 1;
        return [existingRun];
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case32] 既に同一approvalIdで成功済みのRunがある場合(subject一致)、already_executedを返し、providerは再実行されない",
        outcome.status === "already_executed" && calls.executeIntegrationActionCalls === 0 && calls.createRunCalls === 0
      )
    );
  }

  // ---- Case33: 既にcompleted Run + stored subjectが(将来の想定外の
  // 事情で)現在の内容と一致しない場合でも、dedupが先に働き
  // already_executedが返る(絶対条件Step2/11 Case4の結論、成功済みの
  // side effectの報告を、後から発覚した不一致で上書きしない) ----
  {
    const existingRun = makeRun({
      id: "run-existing",
      taskId: "task-1",
      attempt: 1,
      status: "completed",
      externalRef: { approvalId: "approval-1", providerExecutionRef: "log-0" },
    });

    const { deps, calls } = makeDeps({
      listRunsForTask: async () => {
        calls.listRunsForTaskCalls += 1;
        return [existingRun];
      },
      getApproval: async (workId, userId, _accessToken, approvalId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({
          id: approvalId,
          workId,
          payload: {
            action: {
              kind: "integration_action",
              summary: "test",
              metadata: {
                service: "slack",
                operation: "send_message",
                input: { channel: "#general-CHANGED", text: "hi" },
                connectionId: "conn-1",
              },
            },
          },
          // subject/subjectHashは古い(元の)内容のまま——payloadだけが
          // 変化した状態を模す。
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[ARCH-P1c/Case33] 既にcompleted Runがある場合、subjectが(想定外に)一致しなくてもalready_executedが優先される(dedupがIntegrity検証より先、成功済みside effectの報告を上書きしない)、provider call 0",
        outcome.status === "already_executed" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // =========================
  // Architecture Migration Phase C2.2: executeReadIntegrationAction()
  // (Approval不要read用のcanonical public boundary、Section10)
  // =========================

  // ---- Case1: read action(slack.list_channels) -> 許可、provider 1回 ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "list_channels", input: {} },
      },
      deps
    );

    results.push(
      check(
        "[Read/Case1] read policyのaction(slack.list_channels)は実行が許可され、provider(executeIntegrationAction)が正確に1回呼ばれ、completedを返す",
        outcome.status === "completed" && calls.executeIntegrationActionCalls === 1
      )
    );
  }

  // ---- Case2: write action -> 拒否、provider 0・Run 0(defense-in-depth) ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "send_message", input: { channel: "general", text: "hi" } },
      },
      deps
    );

    results.push(
      check(
        "[Read/Case2] write policyのaction(slack.send_message)はread実行境界からは拒否される(invalid_action、provider call 0・Run作成0、callerの自己申告を信用しない)",
        outcome.status === "invalid_action" && calls.executeIntegrationActionCalls === 0 && calls.createRunCalls === 0
      )
    );
  }

  // ---- Case3: 未知action -> 拒否、provider 0・Run 0 ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "unknown_operation", input: {} },
      },
      deps
    );

    results.push(
      check(
        "[Read/Case3] policy allowlistに存在しない未知action(slack.unknown_operation)はread実行境界でも拒否される(invalid_action、provider call 0・Run作成0、fail-closed)",
        outcome.status === "invalid_action" && calls.executeIntegrationActionCalls === 0 && calls.createRunCalls === 0
      )
    );
  }

  // ---- Case4: Connection unavailable -> provider 0 ----
  {
    const { deps, calls } = makeDeps({ getConnection: async () => undefined });

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "list_channels", input: {} },
      },
      deps
    );

    results.push(
      check(
        "[Read/Case4] Connectionが見つからない場合、connection_unavailableを返しprovider call 0",
        outcome.status === "connection_unavailable" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case5: Work not runnable -> provider 0 ----
  {
    const { deps, calls } = makeDeps({
      getWork: async (workId, userId) =>
        userId === OWNER_USER_ID ? makeWork({ id: workId, status: "waiting_for_approval" }) : undefined,
    });

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "list_channels", input: {} },
      },
      deps
    );

    results.push(
      check(
        "[Read/Case5] Workがrunning以外の場合、work_not_runnableを返しprovider call 0",
        outcome.status === "work_not_runnable" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case6: Taskがpending以外 -> task_not_executable、provider 0 ----
  {
    const { deps, calls } = makeDeps({
      listTasksForWork: async () => {
        calls.listTasksForWorkCalls += 1;
        return [makeTask({ status: "completed" })];
      },
    });

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "list_channels", input: {} },
      },
      deps
    );

    results.push(
      check(
        "[Read/Case6] Taskがpending以外(既にcompleted等)の場合、task_not_executableを返しprovider call 0(絶対条件: readでも新規実行前提はpendingのみ)",
        outcome.status === "task_not_executable" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- Case7: provider失敗 -> failed、Task failed、retry 0 ----
  {
    const { deps, calls } = makeDeps({
      executeIntegrationAction: async () => {
        calls.executeIntegrationActionCalls += 1;
        return { status: "failed", error: { code: "provider_execution_failed", message: "boom", retryable: false } };
      },
    });

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "list_channels", input: {} },
      },
      deps
    );

    results.push(
      check(
        "[Read/Case7] providerが失敗を返した場合、failedを返しTaskもfailedへ更新、executeIntegrationAction()は1回のみ(自動retryしない)",
        outcome.status === "failed" &&
          calls.executeIntegrationActionCalls === 1 &&
          calls.updateTaskStatusCalls[calls.updateTaskStatusCalls.length - 1]?.status === "failed"
      )
    );
  }

  // ---- Case8: read成功後もreconcileWorkCompletionStatus()が呼ばれる ----
  {
    const { deps, calls } = makeDeps();

    await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "list_channels", input: {} },
      },
      deps
    );

    results.push(
      check(
        "[Read/Case8] read成功後もreconcileWorkCompletionStatus()が呼ばれる(Phase C2.1aのWork reconciliationをread側も再利用)",
        calls.reconcileWorkCompletionStatusCalls === 1
      )
    );
  }

  // ---- Case9: cross-user -> not_found、provider 0 ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: "attacker",
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "list_channels", input: {} },
      },
      deps
    );

    results.push(
      check(
        "[Read/Case9] 所有権が無いuserIdではnot_foundとなり、Composio呼び出しは一切発生しない",
        outcome.status === "not_found" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // =========================
  // Architecture Migration Phase C2.2b: Deep end-to-end read test
  // (実mapSlackActionToComposioTool() + 実buildExecutionResultFrom
  // ToolResult()をそのまま通す。fakeにするのは実際のComposio
  // client.tools.execute()というnetwork呼び出し部分のみ——canonical
  // action構築からcanonical result抽出までの変換ロジックは一切
  // fakeにしない、最も忠実な「mocked read success/failure」)
  // =========================

  // ---- Case10: mocked read success end-to-end ----
  {
    const { deps, calls } = makeDeps({
      executeIntegrationAction: async (request) => {

        calls.executeIntegrationActionCalls += 1;

        const mapped = mapSlackActionToComposioTool(request.action);

        if (!mapped.ok) {
          throw new Error(`unexpected mapping failure in test: ${mapped.reason}`);
        }

        // live network callだけをfakeにする(実際のSlack
        // conversations.list相当のraw responseを模す、
        // response_metadata.next_cursorも含めてpagination非対応を
        // 確認する)。
        const fakeRawToolResult = {
          successful: true,
          logId: "log-e2e-1",
          data: {
            ok: true,
            channels: [
              { id: "C1", name: "general", is_private: false, created: 1, num_members: 5 },
              { id: "C2", name: "tact", is_private: true, created: 2 },
            ],
            response_metadata: { next_cursor: "SOME_NEXT_CURSOR" },
          },
        };

        return buildExecutionResultFromToolResult(request.action, fakeRawToolResult);

      },
    });

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "list_channels", input: {} },
      },
      deps
    );

    const canonicalOutput =
      outcome.status === "completed" ? JSON.parse(outcome.run.result?.output ?? "null") : null;

    results.push(
      check(
        "[Case10/E2E] mocked read success: provider dispatch正確に1回、completedを返し、canonical channels(id/name/isPrivateのみ)がRun.result.outputへ到達する(実mapping/実canonicalizationロジックを通した状態)",
        calls.executeIntegrationActionCalls === 1 &&
          outcome.status === "completed" &&
          JSON.stringify(canonicalOutput) ===
            JSON.stringify({
              channels: [
                { id: "C1", name: "general", isPrivate: false },
                { id: "C2", name: "tact", isPrivate: true },
              ],
            })
      )
    );

    results.push(
      check(
        "[Case10/E2E] next_cursor/num_members等のraw provider fieldがoutcomeへ一切露出しない",
        !JSON.stringify(outcome).includes("SOME_NEXT_CURSOR") && !JSON.stringify(outcome).includes("num_members")
      )
    );

    results.push(
      check(
        "[Case10/E2E] Run.externalRefにapprovalIdが含まれない(read実行はApprovalを一切経由しない構造的証拠)",
        outcome.status === "completed" && !("approvalId" in (outcome.run.externalRef ?? {}))
      )
    );
  }

  // ---- Case11: mocked read failure end-to-end(Slack側logical error) ----
  {
    const { deps, calls } = makeDeps({
      executeIntegrationAction: async (request) => {

        calls.executeIntegrationActionCalls += 1;

        const mapped = mapSlackActionToComposioTool(request.action);

        if (!mapped.ok) {
          throw new Error("unexpected mapping failure in test");
        }

        // Slack API側のlogical error(data.ok:false)を模す。
        const fakeRawToolResult = { successful: true, logId: "log-e2e-2", data: { ok: false } };

        return buildExecutionResultFromToolResult(request.action, fakeRawToolResult);

      },
    });

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "list_channels", input: {} },
      },
      deps
    );

    results.push(
      check(
        "[Case11/E2E] mocked read failure: provider dispatchは1回のみでfailedへ倒れ、Task failedへ更新される(自動retryなし)",
        calls.executeIntegrationActionCalls === 1 &&
          outcome.status === "failed" &&
          calls.updateTaskStatusCalls[calls.updateTaskStatusCalls.length - 1]?.status === "failed"
      )
    );
  }

  return summarize("integration/execution", results);

}
