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
import type { Work, Approval, Run } from "../../../core/tact-work/types";
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
    listRunsForTaskCalls: 0,
    createRunCalls: 0,
    completeRunCalls: 0,
    failRunCalls: 0,
    updateTaskStatusCalls: [] as { taskId: string; status: string }[],
    executeIntegrationActionCalls: 0,
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
        "[失敗系] 失敗時もexecuteIntegrationAction()は1回のみ(自動retryしない)",
        calls.executeIntegrationActionCalls === 1
      )
    );
  }

  // ---- Execution deduplication(絶対条件Section21) ----
  {
    const existingRun = makeRun({
      id: "run-existing",
      status: "completed",
      externalRef: { approvalId: "approval-1", providerExecutionRef: "log-existing" },
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
        "[Dedup] 同一approvalIdで既に成功済みのRunがある場合、already_executedを返しComposioを再実行しない",
        outcome.status === "already_executed" &&
          (outcome as { run: Run }).run.id === "run-existing" &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.createRunCalls === 0
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
