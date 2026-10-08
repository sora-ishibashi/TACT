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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  executeApprovedIntegrationAction,
  executeReadIntegrationAction,
  isRuntimeEligibleIntegrationAction,
  dispatchIntegrationReadToRuntime,
  executeRuntimeIntegrationRead,
  type ExecuteApprovedIntegrationActionDeps,
} from "../../../core/tact-integration/execution";
import {
  emitGovernanceDiagnosticEvent,
  type GovernanceDiagnosticEvent,
} from "../../../core/tact-integration/governanceDiagnostics";
import type { RuntimeAdapter, RuntimeStartOutcome, RuntimeExecutionRequest } from "../../../core/tact-runtime/types";
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
import { isRetryableIntegrationFailure } from "../../../core/tact-work/taskRunReconciliation";
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
    // Fast Port P5c: attachRunExternalRef()呼び出しの記録。
    attachRunExternalRefCalls: [] as { runId: string; externalRef: Record<string, unknown> | null | undefined }[],
    updateTaskStatusCalls: [] as { taskId: string; status: string }[],
    executeIntegrationActionCalls: 0,
    reconcileWorkCompletionStatusCalls: 0,
    // Fast Port P4b: emitAuditEvent()呼び出しの記録(Fast Port P4a
    // incidentの教訓——実装のrecordAuditEvent()/Supabaseへは絶対に
    // 委譲せず、手書きのfakeだけを注入する)。
    emitAuditEventCalls: [] as { eventType: string; category: string; reasonCode?: string | null; details?: unknown }[],
    // Fast Port P4b(Step9/Resume brief Step12 ordering tests): 各fake
    // handlerが呼ばれた実際の相対順序を1本のarrayへ記録する。Audit
    // eventは"audit:<eventType>"、非Audit呼び出しはその名前で記録する
    // (ordering testが「policy.evaluated→run.created→provider.called
    // →provider呼び出し本体→provider.completed→completeRun→
    // run.completed」等のtimelineをdeps境界だけから直接確認できる
    // ようにするため)。
    callOrder: [] as string[],
    // SOR-138 Slice 3A-2: distinct from emitAuditEventCalls/callOrder —
    // counts actual Preflight network-seam invocations. Legacy (ungoverned)
    // tests never override runsGovernancePreflight and must never trigger
    // this default fake at all (see its own throw below).
    runsGovernancePreflightCalls: 0,
    // SOR-138 Slice 3A-3: counts actual Complete network-seam invocations.
    // Unlike runsGovernancePreflight's default (which throws, since every
    // ungoverned test must never reach it), this one defaults to a harmless
    // "linked" success — completeRunsGovernanceBestEffort() itself already
    // structurally guarantees zero calls for every path that never sets a
    // governanceContext (see its own no-op guard), so every existing
    // (non-3A-3) test in this file naturally asserts 0 here without needing
    // to know this dep exists at all.
    runsGovernanceCompleteCalls: 0,
    // SOR-138 Slice 3A-4: records every diagnostics-only event emitted
    // through the DI seam (never console output — see
    // governanceDiagnostics.ts's own header comment). Legacy/ungoverned
    // tests never read this; governed-path diagnostics tests assert on it
    // directly instead of scraping console.warn.
    emitGovernanceDiagnosticCalls: [] as GovernanceDiagnosticEvent[],
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
      calls.callOrder.push("createRun");
      return makeRun({ workId, taskId, attempt: params.attempt, capability: params.capability, provider: params.provider ?? null });
    },

    completeRun: async () => {
      calls.completeRunCalls += 1;
      calls.callOrder.push("completeRun");
    },

    failRun: async () => {
      calls.failRunCalls += 1;
      calls.callOrder.push("failRun");
    },

    attachRunExternalRef: async (_workId, _userId, _accessToken, runId, externalRef) => {
      calls.attachRunExternalRefCalls.push({ runId, externalRef });
      calls.callOrder.push("attachRunExternalRef");
    },

    updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
      calls.updateTaskStatusCalls.push({ taskId, status });
    },

    executeIntegrationAction: async (): Promise<IntegrationExecutionResult> => {
      calls.executeIntegrationActionCalls += 1;
      calls.callOrder.push("executeIntegrationAction");
      return { status: "completed", providerExecutionRef: "log-1", output: { ok: true } };
    },

    reconcileWorkCompletionStatus: async () => {
      calls.reconcileWorkCompletionStatusCalls += 1;
      return { status: "no_change", reason: "tasks_not_all_terminal" };
    },

    emitAuditEvent: async (request) => {
      calls.emitAuditEventCalls.push({
        eventType: request.eventType,
        category: request.category,
        reasonCode: request.reasonCode ?? null,
        details: request.details ?? null,
      });
      calls.callOrder.push(`audit:${request.eventType}`);
    },

    // SOR-138 Slice 3A-2: the default fake deliberately throws — every
    // existing (ungoverned) test in this file relies on
    // RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED being unset/non-"true"
    // in the test environment, so this dep must never be reached by them.
    // Governed-path tests always override this explicitly.
    runsGovernancePreflight: async () => {
      calls.runsGovernancePreflightCalls += 1;
      calls.callOrder.push("runsGovernancePreflight");
      throw new Error(
        "runsGovernancePreflight default fake invoked — a test reached the governed branch " +
        "without overriding this dep. Either the test enabled the governance flag unintentionally, " +
        "or shouldGovernDirectIntegrationAction() regressed to govern an action it should not."
      );
    },

    // SOR-138 Slice 3A-3: harmless default (unlike runsGovernancePreflight's
    // throwing default above) — completeRunsGovernanceBestEffort() itself
    // guarantees this is never called unless a governed execution set a
    // governanceContext, so there is nothing to defend against here the way
    // the Preflight default has to. Governed-path Complete tests override
    // this explicitly to capture/inspect the actual envelope.
    runsGovernanceComplete: async () => {
      calls.runsGovernanceCompleteCalls += 1;
      calls.callOrder.push("runsGovernanceComplete");
      return { status: "completed", result: { status: "linked" } };
    },

    // SOR-138 Slice 3A-4: harmless default — records the event and nothing
    // else (no console output in tests, no behavior to assert by default).
    // Diagnostics-specific tests override this to make assertions on
    // `calls.emitGovernanceDiagnosticCalls` without needing the real env
    // flag enabled or console scraped.
    emitGovernanceDiagnostic: (event) => {
      calls.emitGovernanceDiagnosticCalls.push(event);
      calls.callOrder.push(`diagnostic:${event.stage}`);
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
        "[SOR-138/3A-3 write path] write経路はgovernanceContextを一切持たないため、Runs Completeは0回のまま",
        calls.runsGovernanceCompleteCalls === 0
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

  // ---- RUNS-P1(Failure Recording): Provider失敗時、
  // IntegrationExecutionError.code/.retryableがRun.externalRefへ
  // 永続化される(以前はmessageだけが抽出され、Run自体からは
  // 二度と読み取れなかった)。isRetryableIntegrationFailure()が
  // それをそのまま読み取れることも合わせて確認する(単体でではなく、
  // 実際にexecuteApprovedIntegrationAction()を通した結果で確認する) ----
  {
    const failRunCalls: { runId: string; error: string; externalRef?: Record<string, unknown> | null }[] = [];

    const { deps, calls } = makeDeps({
      executeIntegrationAction: async (): Promise<IntegrationExecutionResult> => {
        calls.executeIntegrationActionCalls += 1;
        return {
          status: "failed",
          error: { code: "temporary_failure", message: "gateway timeout", retryable: true },
        };
      },
      failRun: async (_workId, _userId, _accessToken, runId, params) => {
        calls.failRunCalls += 1;
        failRunCalls.push({
          runId,
          error: params.error,
          externalRef: params.externalRef as Record<string, unknown> | null | undefined,
        });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[RUNS-P1] failRun()へ渡されるexternalRefにerrorCode(temporary_failure)とerrorRetryable(true)が含まれる(新しい列・migrationなし、既存externalRef jsonbへの追記のみ)",
        failRunCalls.length === 1 &&
          failRunCalls[0].externalRef?.errorCode === "temporary_failure" &&
          failRunCalls[0].externalRef?.errorRetryable === true
      )
    );

    results.push(
      check(
        "[RUNS-P1] isRetryableIntegrationFailure()が、この失敗したRunをretryable=trueとして正しく分類する(read-only、side effect無し)",
        outcome.status === "failed" &&
          isRetryableIntegrationFailure(outcome.run) === true
      )
    );
  }

  // ---- RUNS-P1(Failure Recording、non-retryableの場合): 既存の
  // composio adapterが現状常にretryable:falseを返す(Repository
  // Reality Audit finding)ことを踏まえ、その場合も安全に
  // false(「retryableではないと明示されている」)として分類され、
  // undefined(不明)と混同されないことを確認する ----
  {
    const failRunCalls: { externalRef?: Record<string, unknown> | null }[] = [];

    const { deps } = makeDeps({
      executeIntegrationAction: async (): Promise<IntegrationExecutionResult> => {
        return {
          status: "failed",
          error: { code: "authentication_error", message: "invalid credentials", retryable: false },
        };
      },
      failRun: async (_workId, _userId, _accessToken, _runId, params) => {
        failRunCalls.push({ externalRef: params.externalRef as Record<string, unknown> | null | undefined });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[RUNS-P1] authentication_error等の非retryable failureはexternalRef.errorRetryable=falseとして永続化され、isRetryableIntegrationFailure()はfalseを返す(undefinedと混同しない)",
        failRunCalls[0]?.externalRef?.errorRetryable === false &&
          outcome.status === "failed" &&
          isRetryableIntegrationFailure(outcome.run) === false
      )
    );
  }

  // ---- RUNS-P1: Approval rejected / Integrity failedはこの境界に
  // 一切到達しない(=そもそもRun/failRunが作られない)ことを確認する
  // ——「providerが失敗した」ことと「Approvalが却下された/整合性検証に
  // 失敗した」ことは、既存コードの構造上そもそも異なるcode pathであり、
  // isRetryableIntegrationFailure()のようなprovider failure分類の対象に
  // すらならない(RUNS-P1 Section9/11/17: Approval rejection/Integrity
  // failureをretryable provider failureとして扱わない、という絶対条件の
  // 構造的な保証)----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, accessToken, approvalId) => {
        calls.getApprovalCalls += 1;
        if (userId !== OWNER_USER_ID) return undefined;
        return makeApproval({ id: approvalId, workId, status: "rejected" });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[RUNS-P1] rejected Approvalはprovider呼び出し前に安全に停止する(provider call=0・createRun=0・failRun=0、providerのfailureとして分類されない)",
        outcome.status === "approval_not_approved" &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.createRunCalls === 0 &&
          calls.failRunCalls === 0
      )
    );
  }

  // ---- RUNS-P1b(Section6、Run failure -> Task projection、live wiring):
  // retryable=trueの明示的なfailureは、Task.statusをterminal"failed"では
  // なくnon-terminal"waiting_for_retry"へ進める ----
  {
    const { deps, calls } = makeDeps({
      executeIntegrationAction: async (): Promise<IntegrationExecutionResult> => {
        calls.executeIntegrationActionCalls += 1;
        return {
          status: "failed",
          error: { code: "temporary_failure", message: "gateway timeout", retryable: true },
        };
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[RUNS-P1b] retryable=trueのProvider失敗は、Taskをterminal'failed'ではなくnon-terminal'waiting_for_retry'へ進める",
        outcome.status === "failed" &&
          calls.updateTaskStatusCalls[calls.updateTaskStatusCalls.length - 1]?.status === "waiting_for_retry"
      )
    );

    results.push(
      check(
        "[RUNS-P1b] waiting_for_retryへ進んでもRun自体は'failed'のまま(IntegrationActionExecutionOutcomeに新しいstatusは追加しない、既存絶対条件)",
        outcome.status === "failed" && outcome.run.status === "failed"
      )
    );
  }

  // ---- RUNS-P1b(regression、既存"[失敗系]"と同じ入力): retryable=false
  // (このcommit時点の実際のcomposio adapterが常に返す値)は、従来通り
  // terminal'failed'のまま——既存productionの挙動は一切変わらない ----
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
        "[RUNS-P1b regression] retryable=false(既存composio adapterの実際の挙動)は従来通りTaskをterminal'failed'へ進める(既存production挙動は不変)",
        outcome.status === "failed" &&
          calls.updateTaskStatusCalls[calls.updateTaskStatusCalls.length - 1]?.status === "failed"
      )
    );
  }

  // ---- RUNS-P1b(Section8、retry start): prepareRunForExecution()の
  // precondition(このfile冒頭のexecuteApprovedIntegrationAction()経由)が
  // Task.status==='waiting_for_retry'からも新規Run claimを開始できる
  // (canonical transition: waiting_for_retry -> claim new Run -> running)。
  // 既存の失敗Run(attempt=1)はそのままfailedとして残り、新しいRunは
  // attempt=2として作られる ----
  {
    const { deps, calls } = makeDeps({
      listTasksForWork: async () => {
        calls.listTasksForWorkCalls += 1;
        return [makeTask({ status: "waiting_for_retry" })];
      },
      listRunsForTask: async () => {
        calls.listRunsForTaskCalls += 1;
        return [
          makeRun({
            id: "run-attempt-1",
            attempt: 1,
            status: "failed",
            externalRef: { errorCode: "temporary_failure", errorRetryable: true },
          }),
        ];
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[RUNS-P1b] Task.status='waiting_for_retry'からも新規Run claimを開始できる(task_not_executableにならない)、新しいRunはattempt=2として作られ、Taskはrunning->completedへ進む",
        outcome.status === "completed" &&
          calls.createRunCalls === 1 &&
          calls.updateTaskStatusCalls[0]?.status === "running" &&
          calls.updateTaskStatusCalls[calls.updateTaskStatusCalls.length - 1]?.status === "completed"
      )
    );
  }

  // ---- RUNS-P1b(Section11、terminal Run immutability): store.tsの
  // completeRun()/failRun()が、UPDATE自体のWHERE句へ
  // `.eq("status", "running")`を持つこと(compare-and-set guard)の
  // source-level構造的証拠。fakeベースのDIでは実DB query文を検証できない
  // ため(このtest fileの既存方針通り、実Supabaseへは一切接続しない)、
  // 既存tests/tact/orchestrator/capabilityInvocationDecoupling.test.tsの
  // import-line走査と同じ手法でsource自体を確認する ----
  {
    const storeSource = readFileSync(
      join(__dirname, "..", "..", "..", "core", "tact-work", "store.ts"),
      "utf-8"
    );

    const completeRunBody = storeSource.slice(
      storeSource.indexOf("export async function completeRun"),
      storeSource.indexOf("export interface FailRunParams")
    );

    const failRunBody = storeSource.slice(
      storeSource.indexOf("export async function failRun"),
      storeSource.length
    );

    results.push(
      check(
        '[RUNS-P1b] completeRun()/failRun()のUPDATE queryはいずれも`.eq("status", "running")`を含む(terminal Runを上書きしないcompare-and-set guard)',
        completeRunBody.includes('.eq("status", "running")') &&
          failRunBody.includes('.eq("status", "running")')
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
        "[ARCH-P1c/Case4] service mutation to known gmail.send_message fails Approval Integrity before any provider call",
        outcome.status === "approval_integrity_failed" && calls.executeIntegrationActionCalls === 0
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

  // =========================
  // Fast Port P4b(Resume brief Step12) — Audit event ordering
  // =========================
  //
  // 絶対条件(Resume brief Step10/Expected event ordering): read
  // success timelineはpolicy.evaluated→run.created→provider.called→
  // provider.completed→run.completedの順で確定する。この境界(core/
  // tact-integration/execution.ts)自身が呼ぶdeps呼び出しの実際の
  // 相対順序を、callOrder(実装/非Audit呼び出し双方を1本のarrayへ
  // 記録するfake)で直接確認する。

  // ---- [Ordering] read success timeline ----
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
        "[Ordering] read success: policy.evaluated→createRun→run.created→provider.called→executeIntegrationAction→provider.completed→completeRun→run.completedの順",
        outcome.status === "completed" &&
          JSON.stringify(calls.callOrder) ===
            JSON.stringify([
              "audit:policy.evaluated",
              "createRun",
              "audit:run.created",
              "audit:provider.called",
              "executeIntegrationAction",
              "audit:provider.completed",
              "completeRun",
              "audit:run.completed",
            ])
      )
    );
  }

  // ---- [Ordering] protected write success timeline(この境界内、
  // live policy recheckからrun.completedまで) ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Ordering] protected write success(この境界内): policy.evaluated(live recheck)→createRun→run.created→provider.called→executeIntegrationAction→provider.completed→completeRun→run.completedの順",
        outcome.status === "completed" &&
          JSON.stringify(calls.callOrder) ===
            JSON.stringify([
              "audit:policy.evaluated",
              "createRun",
              "audit:run.created",
              "audit:provider.called",
              "executeIntegrationAction",
              "audit:provider.completed",
              "completeRun",
              "audit:run.completed",
            ])
      )
    );
  }

  // ---- [Ordering] provider failure timeline ----
  {
    const { deps, calls } = makeDeps({
      executeIntegrationAction: async () => {
        calls.executeIntegrationActionCalls += 1;
        calls.callOrder.push("executeIntegrationAction");
        return { status: "failed", error: { code: "provider_execution_failed", message: "simulated provider failure", retryable: false } };
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Ordering] provider failure: policy.evaluated→createRun→run.created→provider.called→executeIntegrationAction→provider.failed→failRun→run.failedの順(completeRun/run.completedは一切呼ばれない)",
        outcome.status === "failed" &&
          calls.callOrder.includes("audit:provider.failed") &&
          !calls.callOrder.includes("completeRun") &&
          !calls.callOrder.includes("audit:run.completed") &&
          JSON.stringify(calls.callOrder) ===
            JSON.stringify([
              "audit:policy.evaluated",
              "createRun",
              "audit:run.created",
              "audit:provider.called",
              "executeIntegrationAction",
              "audit:provider.failed",
              "failRun",
              "audit:run.failed",
            ])
      )
    );
  }

  // ---- [Ordering] Approval Integrity failure: run.created/provider.
  // called共に0回(絶対条件、Resume brief Expected event ordering
  // "Integrity failure: no run.created / no provider.called") ----
  {
    const { deps, calls } = makeDeps({
      getApproval: async (workId, userId, accessToken, approvalId) => {
        calls.getApprovalCalls += 1;
        // subjectを承認後に変化させ、Integrity検証をmismatchさせる。
        return makeApproval({ id: approvalId, workId, ...subjectStorageFields(makeMatchingSubject({ canonicalInput: { channel: "#other", text: "hi" } })) });
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Ordering] Approval Integrity failure: audit event(run.created/provider.called)が一切emitされない",
        outcome.status === "approval_integrity_failed" &&
          calls.createRunCalls === 0 &&
          calls.executeIntegrationActionCalls === 0 &&
          !calls.callOrder.some((entry) => entry.startsWith("audit:run.") || entry.startsWith("audit:provider."))
      )
    );
  }

  // =========================
  // Fast Port P4b(Resume brief Step12) — Audit failure is non-fatal
  // =========================
  //
  // 絶対条件(最重要): Audit insert失敗(emitAuditEvent自体が例外を
  // 投げる場合を含む)によって、既に確定した/確定しつつあるbusiness
  // outcomeを一切変更しない。emitAuditEvent()はこの境界の視点からは
  // 「呼ぶだけ」であり(実際の安全化はcore/tact-work/audit.tsの
  // emitAuditSafely()内部で行われる)、ここでは「emitAuditEventが
  // 例外を投げても、この境界のexecuteIntegrationActionCore()自体が
  // 落ちない」ことまでは保証しない設計(emitAuditSafely()が例外を
  // 握り潰す責務を持つため、この境界はemitAuditEventをtry/catchで
  // 包まない——二重に安全化しない、絶対条件Step2の「責務は
  // audit.ts側に一本化する」を守る)。そのため、この境界のテストでは
  // 「emitAuditSafely()と同じcontractを守るfake(例外を投げず、単に
  // 失敗をmarkするだけ)」を注入し、それでもbusiness outcomeが一切
  // 影響を受けないことを確認する。
  {
    const { deps, calls } = makeDeps({
      emitAuditEvent: async (request) => {
        calls.emitAuditEventCalls.push({ eventType: request.eventType, category: request.category });
        calls.callOrder.push(`audit:${request.eventType}`);
        // emitAuditSafely()の実際の契約(例外を外へ伝播させない)を
        // そのまま模す——ここでは意図的に何もしない(diagnostic
        // loggingのみ、no-op)ことで「Audit書き込みが実質失敗した」
        // 状況を安全に再現する。
        return;
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
        "[Audit non-fatal] read success時、Audit emitterがno-op(=失敗相当)でもprovider成功・Run確定は一切影響を受けない(provider call=1・createRun=1・completeRun=1・failRun=0)",
        outcome.status === "completed" &&
          calls.executeIntegrationActionCalls === 1 &&
          calls.createRunCalls === 1 &&
          calls.completeRunCalls === 1 &&
          calls.failRunCalls === 0
      )
    );
  }

  {
    const { deps, calls } = makeDeps({
      executeIntegrationAction: async () => {
        calls.executeIntegrationActionCalls += 1;
        calls.callOrder.push("executeIntegrationAction");
        return { status: "failed", error: { code: "provider_execution_failed", message: "simulated provider failure", retryable: false } };
      },
      emitAuditEvent: async (request) => {
        calls.emitAuditEventCalls.push({ eventType: request.eventType, category: request.category });
        calls.callOrder.push(`audit:${request.eventType}`);
        return;
      },
    });

    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[Audit non-fatal] provider失敗時、Audit emitterが失敗相当でもfailRun/Task failedは正しく確定し、providerの自動retry(2回目呼び出し)は発生しない(provider call=1・createRun=1・failRun=1・completeRun=0)",
        outcome.status === "failed" &&
          calls.executeIntegrationActionCalls === 1 &&
          calls.createRunCalls === 1 &&
          calls.failRunCalls === 1 &&
          calls.completeRunCalls === 0
      )
    );
  }

  // =========================
  // Fast Port P4b(Resume brief Step11/Step23) — Data minimization
  // =========================
  //
  // 絶対条件: raw secret/token/provider credential/Approval subject_json
  // 全文/canonicalInput全文のいずれもAuditへ複製されない。この境界が
  // 実際にemitするdetailsの中身(service/operation/provider/attempt/
  // capability程度の安全なmachine-readable値のみ)を、疑わしいkey名
  // (P4aのcontainsSuspiciousKey()と同じ固定blocklist)およびcanonical
  // Approval Subjectの既知key名(canonicalInput/connectionId/
  // providerConnectionRef等)の不在で確認する。
  {
    const { deps, calls } = makeDeps();

    await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    const serializedDetails = JSON.stringify(calls.emitAuditEventCalls.map((entry) => entry.details));
    const forbiddenSubstrings = [
      "token",
      "secret",
      "password",
      "credential",
      "apikey",
      "api_key",
      "authorization",
      "subject_json",
      "subjecthash",
      "subjectHash",
      "canonicalInput",
      "providerConnectionRef",
      "connectionId",
      "ca_slack_123",
    ];

    results.push(
      check(
        "[Data minimization] 承認後write成功timelineでemitされた全auditイベントのdetailsに、secret/subject_json/canonicalInput/providerConnectionRef/実connectionId等が一切含まれない",
        forbiddenSubstrings.every((substring) => !serializedDetails.toLowerCase().includes(substring.toLowerCase()))
      )
    );
  }

  // =========================
  // LIVE-1A(Composio Error Cause Observability): provider.failed audit
  // detailsへのsanitized diagnostics反映
  // =========================
  //
  // 対象: core/tact-integration/execution.tsのtoJsonSafeProviderDetails()
  // 配線(executeIntegrationActionCore()のprovider.failed emit)。
  // Provider実装(ここではfakeがComposio Adapterの実際の出力shapeを
  // 模す)がIntegrationExecutionError.providerDetailsへ安全な診断値を
  // 詰めた場合、auditイベントのdetailsへそれがJSON-safeな形で
  // 転記されること、かつobject/array/functionのような非primitive値は
  // 構造的に落とされることを確認する。

  // ---- E: provider.failed detailsへsanitized diagnosticsのみが入る ----
  {
    const { deps, calls } = makeDeps({
      executeIntegrationAction: async (): Promise<IntegrationExecutionResult> => {
        calls.executeIntegrationActionCalls += 1;
        calls.callOrder.push("executeIntegrationAction");
        return {
          status: "failed",
          error: {
            code: "provider_execution_failed",
            message: "Error executing the tool GMAIL_FETCH_EMAILS",
            retryable: false,
            providerDetails: {
              provider: "composio",
              errorName: "ComposioToolExecutionError",
              providerCode: "TS-SDK::TOOL_EXECUTION_ERROR",
              statusCode: 400,
              causeName: "BadRequestError",
              causeMessage: "invalid connected_account_id for this toolkit",
              // 非primitive値(将来のProvider実装が誤って詰めた場合の
              // 防御的ケース)——JSON-safeフィルタで落ちることを確認する。
              rawCause: { nested: "object" },
            },
          },
        };
      },
    });

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-1",
        action: { service: "gmail", operation: "search_messages", input: { query: "A社" } },
      },
      deps
    );

    const providerFailedDetails = calls.emitAuditEventCalls.find((e) => e.eventType === "provider.failed")
      ?.details as { providerDetails?: Record<string, unknown> } | null | undefined;

    results.push(
      check(
        "[LIVE-1A/E] provider.failedのdetails.providerDetailsへ、safeなdiagnostic(provider/errorName/providerCode/statusCode/causeName/causeMessage)が反映される",
        outcome.status === "failed" &&
          providerFailedDetails?.providerDetails?.provider === "composio" &&
          providerFailedDetails?.providerDetails?.errorName === "ComposioToolExecutionError" &&
          providerFailedDetails?.providerDetails?.providerCode === "TS-SDK::TOOL_EXECUTION_ERROR" &&
          providerFailedDetails?.providerDetails?.statusCode === 400 &&
          providerFailedDetails?.providerDetails?.causeName === "BadRequestError" &&
          providerFailedDetails?.providerDetails?.causeMessage === "invalid connected_account_id for this toolkit"
      )
    );

    results.push(
      check(
        "[LIVE-1A/E] 非primitiveな値(rawCause等のnested object)はJSON-safeフィルタにより構造的に落とされる",
        !!providerFailedDetails?.providerDetails && !("rawCause" in providerFailedDetails.providerDetails)
      )
    );

    results.push(
      check(
        // 絶対条件: toJsonSafeProviderDetails()がJSON-safeなkeyを
        // 「機械的に通す」フィルタである以上、この境界(execution.ts)
        // 自身が生のrequest相当の値(providerConnectionRef/connectionId/
        // userId/query等)をproviderDetailsへ新たに追加しないことを
        // 「providerDetailsのkey集合がfakeが返した6 keyちょうどと一致する」
        // という厳密な形で確認する(部分文字列一致は、causeMessageの
        // ような自由文, 説明文——例:「invalid connected_account_id for
        // this toolkit」——を誤検出するため使わない、実際の値の漏洩は
        // mapping.test.tsのLIVE-1A/Dでexact stringのredactionとして
        // 別途確認済み)。
        "[LIVE-1A/D] provider.failed detailsのproviderDetailsは、Provider実装(fake)が返した安全な6 key以外を一切追加しない(providerConnectionRef/connectionId/userId/query等、raw request相当の値を新設しない)",
        !!providerFailedDetails?.providerDetails &&
          JSON.stringify(Object.keys(providerFailedDetails.providerDetails).sort()) ===
            JSON.stringify(["causeMessage", "causeName", "errorName", "provider", "providerCode", "statusCode"])
      )
    );
  }

  // ---- providerDetailsが無い(undefined)場合、detailsへproviderDetails
  // keyそのものを追加しない(既存の{service, operation}のみのshapeを
  // 不必要に変えない) ----
  {
    const { deps, calls } = makeDeps({
      executeIntegrationAction: async (): Promise<IntegrationExecutionResult> => {
        calls.executeIntegrationActionCalls += 1;
        return {
          status: "failed",
          error: { code: "provider_execution_failed", message: "simulated provider failure", retryable: false },
        };
      },
    });

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

    const providerFailedDetails = calls.emitAuditEventCalls.find((e) => e.eventType === "provider.failed")?.details;

    results.push(
      check(
        "[LIVE-1A] providerDetails未設定のIntegrationExecutionErrorでは、detailsに'providerDetails'キー自体が追加されない(既存shapeを壊さない)",
        !!providerFailedDetails && !("providerDetails" in (providerFailedDetails as Record<string, unknown>))
      )
    );
  }

  // =========================
  // Fast Port P5c — Runtime read slice allowlist
  // =========================
  {
    results.push(
      check(
        "[P5c allowlist] slack.list_channelsはeligible",
        isRuntimeEligibleIntegrationAction("slack", "list_channels") === true
      )
    );
    results.push(
      check(
        "[P5c allowlist] slack.send_messageはeligibleではない(protected write structural guard)",
        isRuntimeEligibleIntegrationAction("slack", "send_message") === false
      )
    );
    results.push(
      check(
        "[P5c allowlist] gmail.list_messages(未登録service)はeligibleではない",
        isRuntimeEligibleIntegrationAction("gmail", "list_messages") === false
      )
    );
  }

  function makeFakeRuntimeAdapter(outcome: RuntimeStartOutcome): { adapter: RuntimeAdapter; capturedRequests: RuntimeExecutionRequest[] } {
    const capturedRequests: RuntimeExecutionRequest[] = [];
    const adapter: RuntimeAdapter = {
      provider: "trigger_dev",
      getCapabilities: () => ({ durableExecution: true, durableWait: true, scheduling: true }),
      startExecution: async (request) => {
        capturedRequests.push(request);
        return outcome;
      },
    };
    return { adapter, capturedRequests };
  }

  // =========================
  // Fast Port P5c — dispatchIntegrationReadToRuntime()
  // =========================

  // ---- [Dispatch] eligible action + success: dispatched、run.created
  // →attachRunExternalRefの順、provider callは一切発生しない ----
  {
    const { deps, calls } = makeDeps();
    const { adapter, capturedRequests } = makeFakeRuntimeAdapter({
      status: "started",
      handle: { provider: "trigger_dev", executionId: "fake-trigger-run-1" },
    });

    const outcome = await dispatchIntegrationReadToRuntime(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      adapter,
      deps
    );

    results.push(
      check(
        "[Dispatch] 成功時: status='dispatched'、createRun=1・provider call(executeIntegrationAction)=0・attachRunExternalRef=1",
        outcome.status === "dispatched" &&
          calls.createRunCalls === 1 &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.attachRunExternalRefCalls.length === 1
      )
    );

    results.push(
      check(
        "[Dispatch] 順序: policy.evaluated→createRun→run.created→attachRunExternalRef(completeRun/failRun/provider.*は一切発生しない)",
        JSON.stringify(calls.callOrder) ===
          JSON.stringify(["audit:policy.evaluated", "createRun", "audit:run.created", "attachRunExternalRef"])
      )
    );

    results.push(
      check(
        "[Dispatch] RuntimeExecutionRequestにuserId/workId/taskId/runId/actionが正しく渡る(secretは含まれない)",
        capturedRequests.length === 1 &&
          capturedRequests[0].kind === "integration_action" &&
          capturedRequests[0].userId === OWNER_USER_ID &&
          capturedRequests[0].workId === "work-1" &&
          !JSON.stringify(capturedRequests[0]).toLowerCase().includes("token")
      )
    );

    results.push(
      check(
        "[Dispatch] Run.externalRefにtrigger_dev providerとexecutionIdが保存される",
        calls.attachRunExternalRefCalls[0]?.externalRef?.runtimeProvider === "trigger_dev" &&
          calls.attachRunExternalRefCalls[0]?.externalRef?.runtimeExecutionId === "fake-trigger-run-1"
      )
    );
  }

  // ---- [Dispatch] Runtime start失敗: run.created→run.failed、provider call=0、新しいRunは作られない ----
  {
    const { deps, calls } = makeDeps();
    const { adapter } = makeFakeRuntimeAdapter({
      status: "failed",
      error: { code: "runtime_unavailable", message: "safe message", retryable: true, outcomeKnown: true },
    });

    const outcome = await dispatchIntegrationReadToRuntime(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      adapter,
      deps
    );

    results.push(
      check(
        "[Dispatch/失敗] status='runtime_start_failed'、createRun=1(既に作成済みRunをfailedへ)・provider call=0・attachRunExternalRef=0・failRun=1",
        outcome.status === "runtime_start_failed" &&
          calls.createRunCalls === 1 &&
          calls.executeIntegrationActionCalls === 0 &&
          calls.attachRunExternalRefCalls.length === 0 &&
          calls.failRunCalls === 1
      )
    );

    results.push(
      check(
        "[Dispatch/失敗] 順序: policy.evaluated→createRun→run.created→run.failed→failRun(既存executeIntegrationActionCore()のfailure順序と同じ、completeRun/provider.*は一切発生しない)、run.failedのreasonCodeはRuntimeErrorCode",
        JSON.stringify(calls.callOrder) ===
          JSON.stringify(["audit:policy.evaluated", "createRun", "audit:run.created", "audit:run.failed", "failRun"]) &&
          calls.emitAuditEventCalls.find((e) => e.eventType === "run.failed")?.reasonCode === "runtime_unavailable"
      )
    );
  }

  // ---- [Dispatch] ineligible action(send_message)はallowlistで即拒否、Run作成0・Runtime呼び出し0 ----
  {
    const { deps, calls } = makeDeps();
    const { adapter, capturedRequests } = makeFakeRuntimeAdapter({
      status: "started",
      handle: { provider: "trigger_dev", executionId: "should-not-be-used" },
    });

    const outcome = await dispatchIntegrationReadToRuntime(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: { service: "slack", operation: "send_message", input: { channel: "#general", text: "hi" } } },
      adapter,
      deps
    );

    results.push(
      check(
        "[Dispatch/protected write guard] slack.send_messageはinvalid_actionで即拒否され、Run作成0・Runtime起動0(たとえruntime configが有効でも対象外)",
        outcome.status === "invalid_action" &&
          calls.createRunCalls === 0 &&
          capturedRequests.length === 0
      )
    );
  }

  // ---- [Dispatch] Connection不正/Task不正時は既存statusをそのまま返す ----
  {
    const { deps } = makeDeps({ getConnection: async () => undefined });
    const { adapter } = makeFakeRuntimeAdapter({ status: "started", handle: { provider: "trigger_dev", executionId: "x" } });

    const outcome = await dispatchIntegrationReadToRuntime(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      adapter,
      deps
    );

    results.push(check("[Dispatch/precondition] Connection不正時はconnection_unavailableをそのまま返す", outcome.status === "connection_unavailable"));
  }

  // =========================
  // Fast Port P5c — executeRuntimeIntegrationRead()
  // (Trigger.dev task側から呼ばれる、既存Run再開の中核ロジック)
  // =========================

  // ---- [Resume] 既存running Runを再開し、providerが成功 -> completed、createRunは一切呼ばれない(絶対条件Step9) ----
  {
    const { deps, calls } = makeDeps({
      listRunsForTask: async () => {
        calls.listRunsForTaskCalls += 1;
        return [makeRun({ id: "run-existing-1", workId: "work-1", taskId: "task-1", status: "running" })];
      },
    });

    const outcome = await executeRuntimeIntegrationRead(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", runId: "run-existing-1", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      deps
    );

    results.push(
      check(
        "[Resume] 既存Runを再開し、providerが成功するとcompletedを返す。createRunは一切呼ばれない(Trigger task内でcreateRun禁止、絶対条件Step9)",
        outcome.status === "completed" && calls.createRunCalls === 0 && calls.completeRunCalls === 1
      )
    );

    results.push(
      check(
        "[SOR-138/3A-3 runtime worker path] executeRuntimeIntegrationRead()はgovernanceContextを一切持たないため、Runs Completeは0回のまま(3Bまでは未配線)",
        calls.runsGovernanceCompleteCalls === 0
      )
    );

    results.push(
      check(
        "[Resume] run.createdは再emitされない(既存Runをそのまま使う、二重emission防止)",
        !calls.emitAuditEventCalls.some((e) => e.eventType === "run.created")
      )
    );

    results.push(
      check(
        "[Resume] provider.called→provider.completed→run.completedはこの境界(Trigger task側)で正しくemitされる",
        calls.emitAuditEventCalls.some((e) => e.eventType === "provider.called") &&
          calls.emitAuditEventCalls.some((e) => e.eventType === "provider.completed") &&
          calls.emitAuditEventCalls.some((e) => e.eventType === "run.completed")
      )
    );
  }

  // ---- [Resume] runIdが実在しない -> not_found ----
  {
    const { deps } = makeDeps({
      listRunsForTask: async () => [],
    });

    const outcome = await executeRuntimeIntegrationRead(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", runId: "run-missing", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      deps
    );

    results.push(check("[Resume/correlation] 存在しないrunIdはnot_foundを返す(Run/Task/action correlation再検証)", outcome.status === "not_found"));
  }

  // ---- [Resume] 既にcompleted状態のRunは二重実行しない(duplicate provider call防止、絶対条件18) ----
  {
    const { deps, calls } = makeDeps({
      listRunsForTask: async () => [makeRun({ id: "run-done-1", workId: "work-1", taskId: "task-1", status: "completed" })],
    });

    const outcome = await executeRuntimeIntegrationRead(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", runId: "run-done-1", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      deps
    );

    results.push(
      check(
        "[Resume/dedup] 既にcompleted状態のRunはalready_executedを返し、providerを再実行しない",
        outcome.status === "already_executed" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- [Resume] ineligible actionはallowlistで即拒否(Trigger task側の二重ゲート) ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await executeRuntimeIntegrationRead(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", runId: "run-1", connectionId: "conn-1", action: { service: "slack", operation: "send_message", input: { channel: "#general", text: "hi" } } },
      deps
    );

    results.push(
      check(
        "[Resume/allowlist] slack.send_messageはinvalid_actionで即拒否される(Trigger task側でも二重にゲートする、絶対条件Step19)",
        outcome.status === "invalid_action" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- [Resume] providerが失敗した場合 -> failed、createRunは呼ばれない ----
  {
    const { deps, calls } = makeDeps({
      listRunsForTask: async () => [makeRun({ id: "run-existing-2", workId: "work-1", taskId: "task-1", status: "running" })],
      executeIntegrationAction: async () => {
        calls.executeIntegrationActionCalls += 1;
        return { status: "failed", error: { code: "provider_execution_failed", message: "simulated", retryable: false } };
      },
    });

    const outcome = await executeRuntimeIntegrationRead(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", runId: "run-existing-2", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      deps
    );

    results.push(
      check(
        "[Resume/失敗] providerが失敗した場合はfailedを返し、createRunは一切呼ばれない",
        outcome.status === "failed" && calls.createRunCalls === 0 && calls.failRunCalls === 1
      )
    );
  }

  // =========================
  // Fast Port P5d — ambiguous runtime start(Step30)
  // =========================

  // ---- [Ambiguous] outcomeKnown=falseの場合、Runはrunningのまま維持され、failRun/run.failedは一切発生しない ----
  {
    const { deps, calls } = makeDeps();
    const { adapter, capturedRequests } = makeFakeRuntimeAdapter({
      status: "failed",
      error: { code: "runtime_unavailable", message: "safe message", retryable: true, outcomeKnown: false },
    });

    const outcome = await dispatchIntegrationReadToRuntime(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      adapter,
      deps
    );

    results.push(
      check(
        "[Ambiguous] status='ambiguous'、failRun=0・run.failed emit=0・updateTaskStatus('failed')=0(Runをfailedへ確定させない、絶対条件Step8)",
        outcome.status === "ambiguous" &&
          calls.failRunCalls === 0 &&
          !calls.emitAuditEventCalls.some((e) => e.eventType === "run.failed") &&
          !calls.updateTaskStatusCalls.some((u) => u.status === "failed")
      )
    );

    results.push(
      check(
        "[Ambiguous] provider callは一切発生しない(direct fallback禁止、絶対条件16)",
        calls.executeIntegrationActionCalls === 0 && capturedRequests.length === 1
      )
    );

    results.push(
      check(
        "[Ambiguous] 返り値のrunはstatus変更されず、dispatch直後のRun(status='running')のまま",
        outcome.status === "ambiguous" && outcome.run.status === "running"
      )
    );
  }

  // ---- [Resume/dedup] 既にfailed状態のRunへのduplicate task呼び出しもprovider 0(Step32) ----
  {
    const { deps, calls } = makeDeps({
      listRunsForTask: async () => [makeRun({ id: "run-failed-1", workId: "work-1", taskId: "task-1", status: "failed" })],
    });

    const outcome = await executeRuntimeIntegrationRead(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", runId: "run-failed-1", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      deps
    );

    results.push(
      check(
        "[Resume/dedup] 既にfailed状態のRunへのduplicate task呼び出しもalready_executedを返し、providerを実行しない",
        outcome.status === "already_executed" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- [Resume/correlation] 別のRun(異なるtaskId)は互いに独立して扱われる(Step32/33) ----
  {
    const { deps } = makeDeps({
      listRunsForTask: async (_workId, _userId, _accessToken, taskId) => {
        if (taskId === "task-a") return [makeRun({ id: "run-a-1", workId: "work-1", taskId: "task-a", status: "running" })];
        return [];
      },
    });

    const outcomeA = await executeRuntimeIntegrationRead(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-a", runId: "run-a-1", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      deps
    );

    const outcomeB = await executeRuntimeIntegrationRead(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-b", runId: "run-a-1", connectionId: "conn-1", action: { service: "slack", operation: "list_channels", input: {} } },
      deps
    );

    results.push(
      check(
        "[Resume/correlation] 同じrunIdでもtaskIdが一致しないRunはnot_foundとなる(Trigger payloadのcorrelationを鵜呑みにしない、絶対条件13/14/Step33)",
        outcomeA.status === "completed" && outcomeB.status === "not_found"
      )
    );
  }

  // =========================
  // SOR-138 Slice 3A-2 — governed executeReadIntegrationAction()
  // (slack.list_channels, RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED)
  // =========================
  //
  // All governance-related assertions below use the fully-DI'd
  // runsGovernancePreflight dep — never a real HTTP request (see
  // ExecuteApprovedIntegrationActionDeps's own comment on this seam).
  await withGovernanceEnabled(async () => {

    const GOVERNED_ACTION = { service: "slack" as const, operation: "list_channels", input: {} };

    async function runGoverned(
      preflightFake: ExecuteApprovedIntegrationActionDeps["runsGovernancePreflight"],
      overrides: Partial<ExecuteApprovedIntegrationActionDeps> = {},
      // SOR-138 Slice 3A-3: optional — tests that only care about the
      // Preflight verdict (DENY/UNKNOWN/unavailable/etc.) never need this;
      // the default (harmless "linked", wired in makeDeps()) is never even
      // reached for those since governanceContext never gets set.
      completeFake?: ExecuteApprovedIntegrationActionDeps["runsGovernanceComplete"]
    ) {
      const { deps, calls } = makeDeps(overrides);
      // Wrap the test's fake so makeDeps()'s own call counter (normally
      // only incremented by the default throwing stub) still counts
      // invocations — set after construction, since `calls` does not
      // exist yet at the point an override would otherwise be supplied.
      deps.runsGovernancePreflight = (async (...args: Parameters<typeof preflightFake>) => {
        calls.runsGovernancePreflightCalls += 1;
        calls.callOrder.push("runsGovernancePreflight");
        return preflightFake(...args);
      }) as ExecuteApprovedIntegrationActionDeps["runsGovernancePreflight"];
      if (completeFake) {
        deps.runsGovernanceComplete = (async (...args: Parameters<typeof completeFake>) => {
          calls.runsGovernanceCompleteCalls += 1;
          calls.callOrder.push("runsGovernanceComplete");
          return completeFake(...args);
        }) as ExecuteApprovedIntegrationActionDeps["runsGovernanceComplete"];
      }
      const outcome = await executeReadIntegrationAction(
        { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: GOVERNED_ACTION },
        deps
      );
      return { outcome, calls };
    }

    // SOR-138 Slice 3A-3: same wiring as runGoverned() above, but catches
    // whatever executeReadIntegrationAction() itself throws instead of
    // letting it reject the test — needed for the local-finalization-throw
    // tests (review Section 21), where completeRun()/failRun() throwing is
    // expected to propagate all the way out, and the test must inspect both
    // that original error AND `calls` (runGoverned() alone can't do both,
    // since a rejected call never returns `calls`).
    async function runGovernedAllowingThrow(
      preflightFake: ExecuteApprovedIntegrationActionDeps["runsGovernancePreflight"],
      overrides: Partial<ExecuteApprovedIntegrationActionDeps>,
      completeFake: ExecuteApprovedIntegrationActionDeps["runsGovernanceComplete"]
    ) {
      const { deps, calls } = makeDeps(overrides);
      deps.runsGovernancePreflight = (async (...args: Parameters<typeof preflightFake>) => {
        calls.runsGovernancePreflightCalls += 1;
        calls.callOrder.push("runsGovernancePreflight");
        return preflightFake(...args);
      }) as ExecuteApprovedIntegrationActionDeps["runsGovernancePreflight"];
      deps.runsGovernanceComplete = (async (...args: Parameters<typeof completeFake>) => {
        calls.runsGovernanceCompleteCalls += 1;
        calls.callOrder.push("runsGovernanceComplete");
        return completeFake(...args);
      }) as ExecuteApprovedIntegrationActionDeps["runsGovernanceComplete"];

      let threw: unknown;
      try {
        await executeReadIntegrationAction(
          { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: GOVERNED_ACTION },
          deps
        );
      } catch (error) {
        threw = error;
      }
      return { threw, calls };
    }

    function decided(verdict: "ALLOW" | "DENY" | "UNKNOWN" | "APPROVAL_REQUIRED", approvalStatus: "approved" | "rejected" | null = null) {
      return async () => ({
        status: "decided" as const,
        response: {
          decisionId: "dec-1",
          invocationId: "inv-1",
          verdict,
          reasonCode: "test",
          evaluatorVersion: "v1",
          policyVersion: "a".repeat(64),
          matchedRuleIdentifier: null,
          approval: { approvalId: verdict === "APPROVAL_REQUIRED" ? "apr-1" : null, status: approvalStatus },
        },
      });
    }

    function unavailable(reason: "unconfigured" | "network_error" | "timeout" | "malformed_response" | "invalid_response_shape" | "non_2xx") {
      return async () => ({ status: "unavailable" as const, reason });
    }

    // ---- ALLOW ----
    {
      const { outcome, calls } = await runGoverned(decided("ALLOW"));
      results.push(check(
        "[SOR-138/ALLOW] governed slack.list_channels with verdict=ALLOW completes: Preflight exactly once, Run exactly once, provider exactly once",
        outcome.status === "completed" &&
        calls.runsGovernancePreflightCalls === 1 &&
        calls.createRunCalls === 1 &&
        calls.executeIntegrationActionCalls === 1
      ));
      results.push(check(
        "[SOR-138/ALLOW ordering] policy.evaluated -> runsGovernancePreflight -> createRun -> run.created -> updateTaskStatus(running, implicit) -> provider.called -> executeIntegrationAction -> provider.completed -> completeRun -> run.completed",
        (() => {
          const order = calls.callOrder;
          const idx = (name: string) => order.indexOf(name);
          return (
            idx("audit:policy.evaluated") >= 0 &&
            idx("audit:policy.evaluated") < idx("runsGovernancePreflight") &&
            idx("runsGovernancePreflight") < idx("createRun") &&
            idx("createRun") < idx("audit:run.created") &&
            idx("audit:run.created") < idx("audit:provider.called") &&
            idx("audit:provider.called") < idx("executeIntegrationAction") &&
            idx("executeIntegrationAction") < idx("audit:provider.completed") &&
            idx("audit:provider.completed") < idx("completeRun") &&
            idx("completeRun") < idx("audit:run.completed")
          );
        })()
      ));
    }

    // =========================
    // SOR-138 Slice 3A-3 — Runs Complete wiring for governed direct
    // slack.list_channels
    // =========================

    // ---- success: full envelope + ordering + Complete=1 proof ----
    {
      let preflightEnvelope: { request: { invocationId: string } } | undefined;
      let completeEnvelope:
        | { onBehalfOfUserId: string; request: { decisionId: string; invocationId: string; execution: Record<string, unknown>; outcome?: unknown } }
        | undefined;

      const { outcome, calls } = await runGoverned(
        async (envelope) => {
          preflightEnvelope = envelope as typeof preflightEnvelope;
          return {
            status: "decided" as const,
            response: {
              decisionId: "dec-1",
              invocationId: envelope.request.invocationId,
              verdict: "ALLOW" as const,
              reasonCode: "test",
              evaluatorVersion: "v1",
              policyVersion: "a".repeat(64),
              matchedRuleIdentifier: null,
              approval: { approvalId: null, status: null },
            },
          };
        },
        {},
        async (envelope) => {
          completeEnvelope = envelope as unknown as typeof completeEnvelope;
          return { status: "completed" as const, result: { status: "linked" as const } };
        }
      );

      results.push(check(
        "[SOR-138/3A-3 success] governed ALLOW + provider success: Preflight=1, Run=1, provider=1, Complete=1",
        outcome.status === "completed" &&
        calls.runsGovernancePreflightCalls === 1 &&
        calls.createRunCalls === 1 &&
        calls.executeIntegrationActionCalls === 1 &&
        calls.runsGovernanceCompleteCalls === 1
      ));

      const runId = outcome.status === "completed" ? outcome.run.id : undefined;
      const serializedComplete = JSON.stringify(completeEnvelope);

      results.push(check(
        "[SOR-138/3A-3 success] Complete envelope: same invocationId as Preflight, same decisionId, externalEventId===Run.id, provider='slack', sourceType='sdk_callback', adapterVersion='yolna-direct-integration@1', status='succeeded', outcome absent, providerOccurredAt absent/null, no raw provider output/providerExecutionRef",
        !!completeEnvelope &&
        !!preflightEnvelope &&
        completeEnvelope.request.invocationId === preflightEnvelope.request.invocationId &&
        completeEnvelope.request.decisionId === "dec-1" &&
        completeEnvelope.request.execution.externalEventId === runId &&
        completeEnvelope.request.execution.provider === "slack" &&
        completeEnvelope.request.execution.sourceType === "sdk_callback" &&
        completeEnvelope.request.execution.adapterVersion === "yolna-direct-integration@1" &&
        completeEnvelope.request.execution.status === "succeeded" &&
        completeEnvelope.request.outcome === undefined &&
        (completeEnvelope.request.execution.providerOccurredAt === undefined || completeEnvelope.request.execution.providerOccurredAt === null) &&
        !("errorCode" in completeEnvelope.request.execution) &&
        !serializedComplete.includes("log-1") && // the fixture's providerExecutionRef value
        !serializedComplete.includes("\"output\"")
      ));

      results.push(check(
        "[SOR-138/3A-3 success ordering] executeIntegrationAction -> completeRun -> runsGovernanceComplete (Complete is attempted strictly after local Run/Task finalization, per the reviewed ordering)",
        (() => {
          const order = calls.callOrder;
          const idx = (name: string) => order.indexOf(name);
          return (
            idx("executeIntegrationAction") >= 0 &&
            idx("executeIntegrationAction") < idx("completeRun") &&
            idx("completeRun") < idx("runsGovernanceComplete")
          );
        })()
      ));
    }

    // ---- provider-declared failure: Complete execution.status='failed', errorCode mapped, no raw message/providerDetails ----
    {
      let completeEnvelope:
        | { request: { execution: Record<string, unknown> } }
        | undefined;
      // A local counter, not calls.executeIntegrationActionCalls — this
      // override replaces makeDeps()'s own counting default entirely, and
      // (unlike the sibling makeDeps({...}) call sites elsewhere in this
      // file) `calls` itself does not exist yet while runGoverned() is
      // still being awaited, so it cannot be referenced from inside this
      // closure.
      let providerInvocations = 0;

      const { outcome, calls } = await runGoverned(
        decided("ALLOW"),
        {
          executeIntegrationAction: async () => {
            providerInvocations += 1;
            return {
              status: "failed",
              error: {
                code: "provider_execution_failed",
                message: "raw secret-ish provider detail that must never reach Complete",
                retryable: false,
              },
            };
          },
        },
        async (envelope) => {
          completeEnvelope = envelope as unknown as typeof completeEnvelope;
          return { status: "completed" as const, result: { status: "linked" as const } };
        }
      );

      const serializedComplete = JSON.stringify(completeEnvelope);

      results.push(check(
        "[SOR-138/3A-3 provider failure] provider=1, Complete=1, execution.status='failed', errorCode=canonical code, no raw message/providerDetails, Run remains failed",
        outcome.status === "failed" &&
        providerInvocations === 1 &&
        calls.runsGovernanceCompleteCalls === 1 &&
        !!completeEnvelope &&
        completeEnvelope.request.execution.status === "failed" &&
        completeEnvelope.request.execution.errorCode === "provider_execution_failed" &&
        (completeEnvelope.request.execution.errorMessage === undefined || completeEnvelope.request.execution.errorMessage === null) &&
        !("providerDetails" in completeEnvelope.request.execution) &&
        !serializedComplete.includes("raw secret-ish provider detail")
      ));

      results.push(check(
        "[SOR-138/3A-3 provider failure ordering] failRun -> runsGovernanceComplete",
        (() => {
          const order = calls.callOrder;
          const idx = (name: string) => order.indexOf(name);
          return idx("failRun") >= 0 && idx("failRun") < idx("runsGovernanceComplete");
        })()
      ));
    }

    // ---- Complete success-result classes: both "linked" and "already_linked" preserve the normal provider outcome ----
    for (const completeStatus of ["linked", "already_linked"] as const) {

      const { outcome: successOutcome, calls: successCalls } = await runGoverned(
        decided("ALLOW"),
        {},
        async () => ({ status: "completed" as const, result: { status: completeStatus } })
      );
      results.push(check(
        `[SOR-138/3A-3 Complete result=${completeStatus}] provider success still returns completed`,
        successOutcome.status === "completed" && successCalls.runsGovernanceCompleteCalls === 1
      ));

      const { outcome: failureOutcome, calls: failureCalls } = await runGoverned(
        decided("ALLOW"),
        {
          executeIntegrationAction: async () => ({
            status: "failed",
            error: { code: "provider_execution_failed", message: "boom", retryable: false },
          }),
        },
        async () => ({ status: "completed" as const, result: { status: completeStatus } })
      );
      results.push(check(
        `[SOR-138/3A-3 Complete result=${completeStatus}] provider failure still returns failed`,
        failureOutcome.status === "failed" && failureCalls.runsGovernanceCompleteCalls === 1
      ));

    }

    // ---- Complete failure-result classes: none of these alter the provider/Run outcome, retry, or create a second Run ----
    {

      type CompleteFailureCase = {
        label: string;
        completeFake: ExecuteApprovedIntegrationActionDeps["runsGovernanceComplete"];
      };

      const cases: CompleteFailureCase[] = [
        {
          label: "A. transport unavailable",
          completeFake: async () => ({ status: "unavailable", reason: "network_error" }),
        },
        {
          label: "B. link_conflict",
          completeFake: async () => ({ status: "completed", result: { status: "link_conflict" } }),
        },
        {
          label: "C. invocation_not_found",
          completeFake: async () => ({ status: "completed", result: { status: "invocation_not_found" } }),
        },
        {
          label: "C. decision_not_found",
          completeFake: async () => ({ status: "completed", result: { status: "decision_not_found" } }),
        },
        {
          label: "D. invalid",
          completeFake: async () => ({ status: "completed", result: { status: "invalid" } }),
        },
        {
          label: "E. unexpected throw",
          completeFake: async () => {
            throw new Error("simulated Complete client crash");
          },
        },
      ];

      for (const { label, completeFake } of cases) {

        const { outcome, calls } = await runGoverned(decided("ALLOW"), {}, completeFake);

        results.push(check(
          `[SOR-138/3A-3 Complete failure ${label}] provider call remains exactly 1, Run/Task based on actual provider result, no second Run, no provider retry, caller-facing status unchanged (completed)`,
          outcome.status === "completed" &&
          calls.executeIntegrationActionCalls === 1 &&
          calls.createRunCalls === 1 &&
          calls.runsGovernanceCompleteCalls === 1
        ));

      }

    }

    // ---- local-finalization-throw: completeRun() throws (success side) ----
    {
      let completeCalls = 0;

      const { threw, calls } = await runGovernedAllowingThrow(
        decided("ALLOW"),
        {
          completeRun: async () => {
            throw new Error("simulated completeRun failure (local finalization)");
          },
        },
        async () => {
          completeCalls += 1;
          return { status: "completed" as const, result: { status: "linked" as const } };
        }
      );

      results.push(check(
        "[SOR-138/3A-3 local-finalization-throw, success side] completeRun() throws: Runs Complete is still attempted exactly once with status=succeeded, and the ORIGINAL completeRun error propagates unmasked",
        threw instanceof Error &&
        threw.message === "simulated completeRun failure (local finalization)" &&
        completeCalls === 1 &&
        calls.runsGovernanceCompleteCalls === 1 &&
        calls.createRunCalls === 1 &&
        calls.executeIntegrationActionCalls === 1
      ));
    }

    // ---- local-finalization-throw: failRun() throws (failure side) ----
    {
      let completeCalls = 0;
      let capturedStatus: unknown;
      // Local counter, not calls.executeIntegrationActionCalls — this
      // override (needed to force a provider-declared failure) replaces
      // makeDeps()'s own counting default, same reasoning as the earlier
      // provider-declared-failure test above.
      let providerInvocations = 0;

      const { threw, calls } = await runGovernedAllowingThrow(
        decided("ALLOW"),
        {
          executeIntegrationAction: async () => {
            providerInvocations += 1;
            return {
              status: "failed",
              error: { code: "provider_execution_failed", message: "boom", retryable: false },
            };
          },
          failRun: async () => {
            throw new Error("simulated failRun failure (local finalization)");
          },
        },
        async (envelope) => {
          completeCalls += 1;
          capturedStatus = (envelope as { request: { execution: { status: unknown } } }).request.execution.status;
          return { status: "completed" as const, result: { status: "linked" as const } };
        }
      );

      results.push(check(
        "[SOR-138/3A-3 local-finalization-throw, failure side] provider returned failed, failRun() throws: Runs Complete is still attempted exactly once with status=failed, and the ORIGINAL failRun error propagates unmasked",
        threw instanceof Error &&
        threw.message === "simulated failRun failure (local finalization)" &&
        completeCalls === 1 &&
        capturedStatus === "failed" &&
        calls.runsGovernanceCompleteCalls === 1 &&
        calls.createRunCalls === 1 &&
        providerInvocations === 1
      ));
    }

    // =========================
    // SOR-138 Slice 3A-2 pre-commit correction — post-ALLOW revalidation
    // (stale-state tests A-H, review Section 6)
    // =========================
    //
    // Each override below observes a mutable `stateChanged` flag that the
    // Preflight fake flips just before returning ALLOW.
    // planRunForExecution() (runs BEFORE Preflight, inside
    // executeReadIntegrationAction()) always observes the flag as false —
    // only revalidateGovernedExecutionState() (runs AFTER Preflight
    // returns) observes it flipped. This models TACT's own local state
    // changing during the Preflight network wait without needing any real
    // concurrency.
    function allowThatChangesStateAfter(
      setStateChanged: () => void
    ): ExecuteApprovedIntegrationActionDeps["runsGovernancePreflight"] {
      return async () => {
        setStateChanged();
        return {
          status: "decided",
          response: {
            decisionId: "dec-1",
            invocationId: "inv-1",
            verdict: "ALLOW",
            reasonCode: "test",
            evaluatorVersion: "v1",
            policyVersion: "a".repeat(64),
            matchedRuleIdentifier: null,
            approval: { approvalId: null, status: null },
          },
        };
      };
    }

    // ---- A. ALLOW, then Task becomes cancelled before revalidation ----
    {
      let stateChanged = false;
      const { outcome, calls } = await runGoverned(
        allowThatChangesStateAfter(() => { stateChanged = true; }),
        { listTasksForWork: async () => [makeTask({ status: stateChanged ? "cancelled" : "pending" })] }
      );
      results.push(check(
        "[SOR-138/stale-A] ALLOW, then Task becomes cancelled before revalidation: blocks task_not_executable, Run 0, provider 0",
        outcome.status === "task_not_executable" &&
        (outcome as { taskStatus: string }).taskStatus === "cancelled" &&
        calls.createRunCalls === 0 &&
        calls.executeIntegrationActionCalls === 0
      ));
    }

    // ---- B. ALLOW, then Task becomes completed before revalidation ----
    {
      let stateChanged = false;
      const { outcome, calls } = await runGoverned(
        allowThatChangesStateAfter(() => { stateChanged = true; }),
        { listTasksForWork: async () => [makeTask({ status: stateChanged ? "completed" : "pending" })] }
      );
      results.push(check(
        "[SOR-138/stale-B] ALLOW, then Task becomes completed before revalidation: blocks task_not_executable, Run 0, provider 0",
        outcome.status === "task_not_executable" &&
        (outcome as { taskStatus: string }).taskStatus === "completed" &&
        calls.createRunCalls === 0 &&
        calls.executeIntegrationActionCalls === 0
      ));
    }

    // ---- C. ALLOW, then Work is no longer running before revalidation ----
    {
      let stateChanged = false;
      const { outcome, calls } = await runGoverned(
        allowThatChangesStateAfter(() => { stateChanged = true; }),
        {
          getWork: async (workId, userId) =>
            userId === OWNER_USER_ID
              ? makeWork({ id: workId, status: stateChanged ? "completed" : "running" })
              : undefined,
        }
      );
      results.push(check(
        "[SOR-138/stale-C] ALLOW, then Work is no longer running before revalidation: blocks work_not_runnable, Run 0, provider 0",
        outcome.status === "work_not_runnable" &&
        calls.createRunCalls === 0 &&
        calls.executeIntegrationActionCalls === 0
      ));
    }

    // ---- D. ALLOW, then Connection becomes inactive before revalidation ----
    {
      let stateChanged = false;
      const { outcome, calls } = await runGoverned(
        allowThatChangesStateAfter(() => { stateChanged = true; }),
        {
          getConnection: async (connectionId, userId) =>
            userId === OWNER_USER_ID
              ? makeConnection({ id: connectionId, status: stateChanged ? "revoked" : "active" })
              : undefined,
        }
      );
      results.push(check(
        "[SOR-138/stale-D] ALLOW, then Connection becomes inactive before revalidation: blocks connection_unavailable, Run 0, provider 0",
        outcome.status === "connection_unavailable" &&
        calls.createRunCalls === 0 &&
        calls.executeIntegrationActionCalls === 0
      ));
    }

    // ---- E. ALLOW, then a running Run appears before revalidation ----
    {
      let stateChanged = false;
      const { outcome, calls } = await runGoverned(
        allowThatChangesStateAfter(() => { stateChanged = true; }),
        { listRunsForTask: async () => (stateChanged ? [makeRun({ status: "running" })] : []) }
      );
      results.push(check(
        "[SOR-138/stale-E] ALLOW, then a running Run appears before revalidation: blocks task_not_executable, Run 0, provider 0",
        outcome.status === "task_not_executable" &&
        (outcome as { taskStatus: string }).taskStatus === "running" &&
        calls.createRunCalls === 0 &&
        calls.executeIntegrationActionCalls === 0
      ));
    }

    // ---- F/H. ALLOW planned attempt 1, then a real Run for attempt 1
    // lands before revalidation (current nextAttempt is now 2, no longer
    // matching planned.nextAttempt) — must block, and must NEVER silently
    // claim attempt+1 under the ALLOW that was granted for attempt 1. ----
    {
      let stateChanged = false;
      const { outcome, calls } = await runGoverned(
        allowThatChangesStateAfter(() => { stateChanged = true; }),
        { listRunsForTask: async () => (stateChanged ? [makeRun({ attempt: 1, status: "completed" })] : []) }
      );
      results.push(check(
        "[SOR-138/stale-F,H] ALLOW planned attempt 1, then current nextAttempt advances to 2 before revalidation: blocks task_not_executable, Run 0, provider 0 — never silently claims attempt+1 under the stale ALLOW",
        outcome.status === "task_not_executable" &&
        calls.createRunCalls === 0 &&
        calls.executeIntegrationActionCalls === 0
      ));
    }

    // ---- G. unchanged state: exactly planned.nextAttempt(=1) is claimed,
    // provider executes once ----
    {
      const { outcome, calls } = await runGoverned(decided("ALLOW"));
      results.push(check(
        "[SOR-138/stale-G] unchanged state: completes claiming exactly planned.nextAttempt(=1), Run exactly once, provider exactly once",
        outcome.status === "completed" &&
        calls.createRunCalls === 1 &&
        calls.executeIntegrationActionCalls === 1 &&
        (outcome as { run: Run }).run.attempt === 1
      ));
    }

    // ---- DENY ----
    {
      const { outcome, calls } = await runGoverned(decided("DENY"));
      results.push(check(
        "[SOR-138/DENY] blocks: invalid_action, Run 0, provider 0, Complete 0",
        outcome.status === "invalid_action" && calls.createRunCalls === 0 && calls.executeIntegrationActionCalls === 0 &&
        calls.runsGovernanceCompleteCalls === 0
      ));
      results.push(check(
        "[SOR-138/DENY] no run.created, no provider.called emitted",
        !calls.emitAuditEventCalls.some((e) => e.eventType === "run.created" || e.eventType === "provider.called")
      ));
    }

    // ---- UNKNOWN ----
    {
      const { outcome, calls } = await runGoverned(decided("UNKNOWN"));
      results.push(check(
        "[SOR-138/UNKNOWN] blocks: invalid_action, Run 0, provider 0, Complete 0",
        outcome.status === "invalid_action" && calls.createRunCalls === 0 && calls.executeIntegrationActionCalls === 0 &&
        calls.runsGovernanceCompleteCalls === 0
      ));
    }

    // ---- APPROVAL_REQUIRED, pending ----
    {
      const { outcome, calls } = await runGoverned(decided("APPROVAL_REQUIRED", null));
      results.push(check(
        "[SOR-138/APPROVAL_REQUIRED pending] blocks: invalid_action, Run 0, provider 0, Complete 0",
        outcome.status === "invalid_action" && calls.createRunCalls === 0 && calls.executeIntegrationActionCalls === 0 &&
        calls.runsGovernanceCompleteCalls === 0
      ));
    }

    // ---- APPROVAL_REQUIRED, approved (absolute condition: still blocked) ----
    {
      const { outcome, calls } = await runGoverned(decided("APPROVAL_REQUIRED", "approved"));
      results.push(check(
        "[SOR-138/APPROVAL_REQUIRED approved] an approved ApprovalRequest does NOT authorize execution — still blocks: invalid_action, Run 0, provider 0, Complete 0",
        outcome.status === "invalid_action" && calls.createRunCalls === 0 && calls.executeIntegrationActionCalls === 0 &&
        calls.runsGovernanceCompleteCalls === 0
      ));
    }

    // ---- transport unavailable (unconfigured) ----
    {
      const { outcome, calls } = await runGoverned(unavailable("unconfigured"));
      results.push(check(
        "[SOR-138/unconfigured] blocks: invalid_action, Run 0, provider 0, Complete 0",
        outcome.status === "invalid_action" && calls.createRunCalls === 0 && calls.executeIntegrationActionCalls === 0 &&
        calls.runsGovernanceCompleteCalls === 0
      ));
    }

    // ---- timeout ----
    {
      const { outcome, calls } = await runGoverned(unavailable("timeout"));
      results.push(check(
        "[SOR-138/timeout] blocks: invalid_action, Run 0, provider 0, Complete 0",
        outcome.status === "invalid_action" && calls.createRunCalls === 0 && calls.executeIntegrationActionCalls === 0 &&
        calls.runsGovernanceCompleteCalls === 0
      ));
    }

    // ---- network error / non-2xx / malformed / invalid shape ----
    for (const reason of ["network_error", "non_2xx", "malformed_response", "invalid_response_shape"] as const) {
      const { outcome, calls } = await runGoverned(unavailable(reason));
      results.push(check(
        `[SOR-138/${reason}] blocks: invalid_action, Run 0, provider 0, Complete 0`,
        outcome.status === "invalid_action" && calls.createRunCalls === 0 && calls.executeIntegrationActionCalls === 0 &&
        calls.runsGovernanceCompleteCalls === 0
      ));
    }

    // ---- 409 invocation conflict surfaces through the client as unavailable/non_2xx (see runsGovernance.ts) ----
    {
      const { outcome, calls } = await runGoverned(unavailable("non_2xx"));
      results.push(check(
        "[SOR-138/409-shaped non_2xx] blocks: invalid_action, Run 0, provider 0, Complete 0",
        outcome.status === "invalid_action" && calls.createRunCalls === 0 && calls.executeIntegrationActionCalls === 0 &&
        calls.runsGovernanceCompleteCalls === 0
      ));
    }

    // ---- feature disabled: exact legacy path, Preflight never called ----
    {
      const originalFlag = process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED;
      delete process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED;
      try {
        const { deps, calls } = makeDeps();
        const outcome = await executeReadIntegrationAction(
          { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: GOVERNED_ACTION },
          deps
        );
        results.push(check(
          "[SOR-138/feature-disabled] exact legacy execution path: Preflight never called, Complete never called, completes via existing provider dispatch",
          outcome.status === "completed" && calls.runsGovernancePreflightCalls === 0 && calls.executeIntegrationActionCalls === 1 &&
          calls.runsGovernanceCompleteCalls === 0
        ));
      } finally {
        if (originalFlag === undefined) delete process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED;
        else process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED = originalFlag;
      }
    }

    // ---- non-slack / non-list_channels read: Preflight 0, existing behavior ----
    {
      const { deps, calls } = makeDeps();
      const outcome = await executeReadIntegrationAction(
        { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: { service: "gmail", operation: "search_messages", input: {} } },
        deps
      );
      results.push(check(
        "[SOR-138/non-governed action] gmail.search_messages is never governed even with the flag on: Preflight 0, Complete 0, existing behavior unaffected",
        calls.runsGovernancePreflightCalls === 0 && calls.runsGovernanceCompleteCalls === 0
      ));
      void outcome;
    }

    // ---- exact string match only: "TRUE" / "1" / whitespace do not enable governance ----
    {
      const originalFlag = process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED;
      for (const notEnabled of ["TRUE", "1", " true", "true "]) {
        process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED = notEnabled;
        const { deps, calls } = makeDeps();
        await executeReadIntegrationAction(
          { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: GOVERNED_ACTION },
          deps
        );
        results.push(check(
          `[SOR-138/exact-match] RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED=${JSON.stringify(notEnabled)} does not enable governance`,
          calls.runsGovernancePreflightCalls === 0
        ));
      }
      if (originalFlag === undefined) delete process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED;
      else process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED = originalFlag;
    }

    // ---- concurrency: two independent planning calls over the same empty
    // Task state derive the SAME nextAttempt (and therefore would derive
    // the same invocationId, asking Runs about the same GovernanceInvocation)
    // — proven here via two full runGoverned() calls sharing a fresh
    // listRunsForTask fake that always reports zero existing runs (as if
    // neither caller's createRun() had landed yet), each independently
    // computing its own plan. The actual exclusion authority for a REAL
    // simultaneous claim remains the DB's own idx_tact_runs_task_id_attempt
    // unique index at createRun() time, unchanged by this slice.
    {
      const seenInvocationIds: string[] = [];
      const preflightSpy = async (envelope: { request: { invocationId: string } }) => {
        seenInvocationIds.push(envelope.request.invocationId);
        return { status: "decided" as const, response: { decisionId: "dec-1", invocationId: envelope.request.invocationId, verdict: "DENY" as const, reasonCode: "test", evaluatorVersion: "v1", policyVersion: "a".repeat(64), matchedRuleIdentifier: null, approval: { approvalId: null, status: null } } };
      };

      await runGoverned(preflightSpy, { listRunsForTask: async () => [] });
      await runGoverned(preflightSpy, { listRunsForTask: async () => [] });

      results.push(check(
        "[SOR-138/concurrency] two independent planning calls over the same empty Task state derive the SAME invocationId",
        seenInvocationIds.length === 2 && seenInvocationIds[0] === seenInvocationIds[1]
      ));
    }

    // ---- crash/retry semantics: a genuinely new attempt (a real Run now
    // exists for attempt 1) derives a DIFFERENT invocationId than the
    // first, never-claimed attempt did — proving a retry after a real
    // attempt exists is re-evaluated, not silently reusing the stale
    // decision identity.
    {
      const seenInvocationIds: string[] = [];
      const preflightSpy = async (envelope: { request: { invocationId: string } }) => {
        seenInvocationIds.push(envelope.request.invocationId);
        return { status: "decided" as const, response: { decisionId: "dec-1", invocationId: envelope.request.invocationId, verdict: "DENY" as const, reasonCode: "test", evaluatorVersion: "v1", policyVersion: "a".repeat(64), matchedRuleIdentifier: null, approval: { approvalId: null, status: null } } };
      };

      // "Call 1": plans attempt 1 against a Task with zero existing Runs
      // (modeling a crash before createRun() ever landed — the planned
      // attempt was never actually claimed).
      await runGoverned(preflightSpy, { listRunsForTask: async () => [] });

      // A genuine subsequent attempt: a real Run for attempt 1 now exists
      // (e.g. a previous attempt actually completed/failed), so planning
      // again correctly derives attempt 2.
      await runGoverned(preflightSpy, { listRunsForTask: async () => [makeRun({ attempt: 1, status: "completed" })] });

      results.push(check(
        "[SOR-138/crash-retry] once a real Run exists for the prior attempt, the next plan's nextAttempt changes and therefore derives a DIFFERENT invocationId — re-evaluated, not inherited",
        seenInvocationIds.length === 2 && seenInvocationIds[0] !== seenInvocationIds[1]
      ));
    }

    // ---- same-attempt retry (no Run claimed yet) reuses the SAME
    // invocationId — this is the actual "crash before createRun()" retry
    // case, and is intentionally idempotent at the governance layer.
    {
      const seenInvocationIds: string[] = [];
      const preflightSpy = async (envelope: { request: { invocationId: string } }) => {
        seenInvocationIds.push(envelope.request.invocationId);
        return { status: "decided" as const, response: { decisionId: "dec-1", invocationId: envelope.request.invocationId, verdict: "DENY" as const, reasonCode: "test", evaluatorVersion: "v1", policyVersion: "a".repeat(64), matchedRuleIdentifier: null, approval: { approvalId: null, status: null } } };
      };

      await runGoverned(preflightSpy, { listRunsForTask: async () => [] });
      await runGoverned(preflightSpy, { listRunsForTask: async () => [] });

      results.push(check(
        "[SOR-138/same-attempt retry] a retry of the SAME never-claimed attempt (still zero existing Runs) reuses the identical invocationId",
        seenInvocationIds.length === 2 && seenInvocationIds[0] === seenInvocationIds[1]
      ));
    }

    // =========================
    // SOR-138 Slice 3A-4 — diagnostics-only instrumentation (DI seam,
    // never console output in these tests — see makeDeps()'s default
    // emitGovernanceDiagnostic fake). Every case below asserts the exact
    // stage sequence AND that no field carries anything beyond the
    // hand-typed primitive shapes governanceDiagnostics.ts declares — this
    // is itself part of the "no secret/raw payload can appear" guarantee,
    // since JSON.stringify(event) can never contain more than the object
    // literal this file constructed.
    // =========================

    function diagnosticStages(calls: { emitGovernanceDiagnosticCalls: GovernanceDiagnosticEvent[] }): string[] {
      return calls.emitGovernanceDiagnosticCalls.map((event) => event.stage);
    }

    function diagnosticFieldsAreSafe(calls: { emitGovernanceDiagnosticCalls: GovernanceDiagnosticEvent[] }): boolean {
      // Every event must serialize to a JSON object whose own keys are a
      // subset of this closed allowlist — proves no caller ever widened an
      // event literal with an extra (potentially unsafe) field at a call
      // site, independent of the type system.
      const ALLOWED_KEYS = new Set([
        "stage", "invocationId", "service", "operation", "actionCategory",
        "durationMs", "httpStatus", "transportResult", "outcome",
        "rejectionCategory", "verdict", "plannedAttempt", "observedAttempt",
        "attemptMatch", "errorCategory",
      ]);
      return calls.emitGovernanceDiagnosticCalls.every((event) =>
        Object.keys(event).every((key) => ALLOWED_KEYS.has(key))
      );
    }

    // ---- [3A-4/happy-path] valid HTTP 200 ALLOW: full stage sequence ----
    {
      const { calls } = await runGoverned(decided("ALLOW"));
      results.push(check(
        "[3A-4/happy-path] ALLOW emits the full A->E diagnostic sequence in order",
        (() => {
          const stages = diagnosticStages(calls);
          return (
            stages.indexOf("preflight_request_started") === 0 &&
            stages.indexOf("preflight_transport_completed") === 1 &&
            stages.indexOf("root_decision_gate") === 2 &&
            stages.indexOf("revalidation_entered") === 3 &&
            stages.indexOf("revalidation_resolved") === 4 &&
            stages.indexOf("run_creation_entered") === 5 &&
            stages.indexOf("run_creation_resolved") === 6 &&
            stages.length === 7
          );
        })()
      ));
      const transportEvent = calls.emitGovernanceDiagnosticCalls[1];
      const gateEvent = calls.emitGovernanceDiagnosticCalls[2];
      const revalidationEvent = calls.emitGovernanceDiagnosticCalls[4];
      const runEvent = calls.emitGovernanceDiagnosticCalls[6];
      results.push(check(
        "[3A-4/happy-path] stage B reports httpStatus=200/decided, stage C accepted/ALLOW, stage D passed+attemptMatch, stage E succeeded",
        transportEvent?.stage === "preflight_transport_completed" && transportEvent.httpStatus === 200 && transportEvent.transportResult === "decided" &&
        gateEvent?.stage === "root_decision_gate" && gateEvent.outcome === "accepted" && gateEvent.verdict === "ALLOW" &&
        revalidationEvent?.stage === "revalidation_resolved" && revalidationEvent.outcome === "passed" && revalidationEvent.attemptMatch === true &&
        runEvent?.stage === "run_creation_resolved" && runEvent.outcome === "succeeded" && runEvent.errorCategory === null
      ));
      results.push(check(
        "[3A-4/happy-path] every emitted event's own fields stay within the closed diagnostic allowlist (no secret/raw-payload field ever present)",
        diagnosticFieldsAreSafe(calls)
      ));
    }

    // ---- [3A-4/invalid-shape] HTTP 200 but invalid response shape ----
    {
      const { calls } = await runGoverned(unavailable("invalid_response_shape"));
      const transportEvent = calls.emitGovernanceDiagnosticCalls[1];
      const gateEvent = calls.emitGovernanceDiagnosticCalls[2];
      results.push(check(
        "[3A-4/invalid-shape] stage B reports invalid_response_shape, stage C rejects with that category, D/E never emitted, fail-closed preserved",
        diagnosticStages(calls).join(",") === "preflight_request_started,preflight_transport_completed,root_decision_gate" &&
        transportEvent?.stage === "preflight_transport_completed" && transportEvent.transportResult === "invalid_response_shape" &&
        gateEvent?.stage === "root_decision_gate" && gateEvent.outcome === "rejected" && gateEvent.rejectionCategory === "invalid_response_shape" && gateEvent.verdict === null &&
        calls.createRunCalls === 0
      ));
    }

    // ---- [3A-4/non-200] HTTP non-200 ----
    {
      const { calls } = await runGoverned(unavailable("non_2xx"));
      const transportEvent = calls.emitGovernanceDiagnosticCalls[1];
      results.push(check(
        "[3A-4/non-200] stage B reports non_2xx, D/E never emitted, fail-closed preserved",
        diagnosticStages(calls).join(",") === "preflight_request_started,preflight_transport_completed,root_decision_gate" &&
        transportEvent?.stage === "preflight_transport_completed" && transportEvent.transportResult === "non_2xx" &&
        calls.createRunCalls === 0
      ));
    }

    // ---- [3A-4/timeout] client-side timeout ----
    {
      const { calls } = await runGoverned(unavailable("timeout"));
      const transportEvent = calls.emitGovernanceDiagnosticCalls[1];
      results.push(check(
        "[3A-4/timeout] stage B reports timeout, D/E never emitted, fail-closed preserved",
        diagnosticStages(calls).join(",") === "preflight_request_started,preflight_transport_completed,root_decision_gate" &&
        transportEvent?.stage === "preflight_transport_completed" && transportEvent.transportResult === "timeout" &&
        calls.createRunCalls === 0
      ));
    }

    // ---- [3A-4/network-error] transport network error ----
    {
      const { calls } = await runGoverned(unavailable("network_error"));
      const transportEvent = calls.emitGovernanceDiagnosticCalls[1];
      results.push(check(
        "[3A-4/network-error] stage B reports network_error, D/E never emitted, fail-closed preserved",
        diagnosticStages(calls).join(",") === "preflight_request_started,preflight_transport_completed,root_decision_gate" &&
        transportEvent?.stage === "preflight_transport_completed" && transportEvent.transportResult === "network_error" &&
        calls.createRunCalls === 0
      ));
    }

    // ---- [3A-4/revalidation-rejected] ALLOW decided, but local state drifted
    // between planning and revalidation (a running Run appears for the
    // SAME Task before revalidation re-reads it) — this is precisely the
    // SOR-138 Slice 3A-4 read-only investigation's "candidate C" scenario.
    {
      let listRunsForTaskCallCount = 0;
      const { calls } = await runGoverned(decided("ALLOW"), {
        listRunsForTask: async () => {
          listRunsForTaskCallCount += 1;
          // 1st call is planRunForExecution()'s (before Preflight): zero
          // existing Runs, so planning succeeds with nextAttempt=1. 2nd
          // call is revalidateGovernedExecutionState()'s own re-read
          // (after Preflight ALLOW): a running Run now exists — this is
          // the exact "state drifted during the Preflight wait" case that
          // function exists to catch.
          if (listRunsForTaskCallCount === 1) return [];
          return [makeRun({ attempt: 1, status: "running" })];
        },
      });
      const revalidationResolvedEvent = calls.emitGovernanceDiagnosticCalls.find((e) => e.stage === "revalidation_resolved");
      results.push(check(
        "[3A-4/revalidation-rejected] stage D entered+resolved(rejected, task_not_executable), stage E never emitted, zero Run created",
        diagnosticStages(calls).join(",") ===
          "preflight_request_started,preflight_transport_completed,root_decision_gate,revalidation_entered,revalidation_resolved" &&
        revalidationResolvedEvent?.stage === "revalidation_resolved" &&
        revalidationResolvedEvent.outcome === "rejected" &&
        revalidationResolvedEvent.rejectionCategory === "task_not_executable" &&
        revalidationResolvedEvent.observedAttempt === null &&
        revalidationResolvedEvent.attemptMatch === null &&
        calls.createRunCalls === 0
      ));
    }

    // ---- [3A-4/create-run-failed] revalidation passes, but createRun()
    // itself returns no Run (the SOR-138 Slice 3A-4 read-only
    // investigation's "candidate D" scenario) ----
    {
      const { calls } = await runGoverned(decided("ALLOW"), {
        createRun: async () => undefined,
      });
      const runResolvedEvent = calls.emitGovernanceDiagnosticCalls.find((e) => e.stage === "run_creation_resolved");
      results.push(check(
        "[3A-4/create-run-failed] stage D passed, stage E entered+resolved(failed, not_found), matching createRun() returning no Run",
        diagnosticStages(calls).join(",") ===
          "preflight_request_started,preflight_transport_completed,root_decision_gate,revalidation_entered,revalidation_resolved,run_creation_entered,run_creation_resolved" &&
        runResolvedEvent?.stage === "run_creation_resolved" &&
        runResolvedEvent.outcome === "failed" &&
        runResolvedEvent.errorCategory === "not_found"
      ));
    }

    // ---- [3A-4/disabled-by-default] the real (non-fake) emitter is a
    // total no-op unless RUNS_GOVERNANCE_DIAGNOSTICS_ENABLED==="true" —
    // proven directly against emitGovernanceDiagnosticEvent() itself, not
    // through the DI seam (which always uses the test's own fake above).
    {
      let emitted = false;
      const originalFlag = process.env.RUNS_GOVERNANCE_DIAGNOSTICS_ENABLED;
      delete process.env.RUNS_GOVERNANCE_DIAGNOSTICS_ENABLED;
      emitGovernanceDiagnosticEvent(
        { stage: "run_creation_entered", invocationId: "inv-x" },
        { emit: () => { emitted = true; } }
      );
      if (originalFlag === undefined) delete process.env.RUNS_GOVERNANCE_DIAGNOSTICS_ENABLED;
      else process.env.RUNS_GOVERNANCE_DIAGNOSTICS_ENABLED = originalFlag;
      results.push(check(
        "[3A-4/disabled-by-default] emitGovernanceDiagnosticEvent() never calls emit() when RUNS_GOVERNANCE_DIAGNOSTICS_ENABLED is unset",
        emitted === false
      ));
    }

    // ---- [3A-4/enabled-exact-match] only the exact string "true" enables
    // it — same contract as RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED.
    {
      let emittedLine: string | null = null;
      emitGovernanceDiagnosticEvent(
        { stage: "run_creation_entered", invocationId: "inv-y" },
        { env: { ...process.env, RUNS_GOVERNANCE_DIAGNOSTICS_ENABLED: "TRUE" }, emit: (line) => { emittedLine = line; } }
      );
      let emittedWhenTrue: string | null = null;
      emitGovernanceDiagnosticEvent(
        { stage: "run_creation_entered", invocationId: "inv-y" },
        { env: { ...process.env, RUNS_GOVERNANCE_DIAGNOSTICS_ENABLED: "true" }, emit: (line) => { emittedWhenTrue = line; } }
      );
      results.push(check(
        "[3A-4/enabled-exact-match] a non-exact value (\"TRUE\") stays disabled; only exact \"true\" emits, and the emitted line contains no more than the tagged JSON event",
        emittedLine === null &&
        typeof emittedWhenTrue === "string" &&
        (emittedWhenTrue as string).startsWith("[runs-governance-diagnostics] ") &&
        JSON.parse((emittedWhenTrue as string).slice("[runs-governance-diagnostics] ".length)).invocationId === "inv-y"
      ));
    }

    // ---- [3A-4/emitter-throws-safety] a diagnostic emitter that throws on
    // EVERY stage — including stage E ("run_creation_resolved"), which
    // fires only AFTER createRun() and the provider call/finalization have
    // already succeeded — must never change the real outcome. Before this
    // fix, an emitter exception at stage E rejected the whole async
    // function and discarded an already-successful `coreOutcome`.
    {
      const emittedStages: string[] = [];
      let threw: unknown;
      let outcome: Awaited<ReturnType<typeof executeReadIntegrationAction>> | undefined;
      const { calls } = await (async () => {
        const { deps, calls } = makeDeps({
          runsGovernancePreflight: decided("ALLOW"),
          emitGovernanceDiagnostic: (event) => {
            emittedStages.push(event.stage);
            throw new Error(`simulated diagnostic emitter failure at stage "${event.stage}"`);
          },
        });
        try {
          outcome = await executeReadIntegrationAction(
            { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: GOVERNED_ACTION },
            deps
          );
        } catch (error) {
          threw = error;
        }
        return { calls };
      })();

      results.push(check(
        "[3A-4/emitter-throws-safety] a throwing diagnostic emitter never rejects executeReadIntegrationAction(), and the real outcome (Run completed) is still returned",
        threw === undefined &&
        outcome?.status === "completed" &&
        calls.createRunCalls === 1 &&
        calls.completeRunCalls === 1 &&
        calls.executeIntegrationActionCalls === 1 &&
        emittedStages.length === 7 &&
        emittedStages[6] === "run_creation_resolved"
      ));
    }

  });

  return summarize("integration/execution", results);

}

// SOR-138 Slice 3A-2: sets/restores RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED
// around a block of governed-path tests — same convention as this repo's
// other env-var-scoped test helpers (e.g. tactConversationOrchestration.test.ts's
// RUNTIME_TRIGGER_DEV_ENABLED_ENV_KEY handling).
async function withGovernanceEnabled(fn: () => Promise<void>): Promise<void> {
  const original = process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED;
  process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED = "true";
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED;
    else process.env.RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED = original;
  }
}
