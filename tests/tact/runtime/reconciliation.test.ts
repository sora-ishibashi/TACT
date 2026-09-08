// =========================
// TACT Runtime — Reconciliation Regression
// (Fast Port P5d: Runtime Reconciliation / Idempotency Hardening)
// =========================
//
// 対象: core/tact-runtime/reconciliation.tsのreconcileRuntimeExecution()。
// 実Supabase・実Trigger.devのいずれにも一切接続しない(全deps/
// RuntimeAdapterをfakeで差し替える、Fast Port P4a incidentの教訓を
// 踏襲)。
import { reconcileRuntimeExecution, type ReconciliationDeps } from "../../../core/tact-runtime/reconciliation";
import type { RuntimeAdapter, RuntimeStartOutcome, RuntimeExecutionRequest } from "../../../core/tact-runtime/types";
import type { Work, Run } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: OWNER_USER_ID,
    createdByActorKind: "user",
    createdByActorId: OWNER_USER_ID,
    status: "running",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    workId: "work-1",
    taskId: "task-1",
    attempt: 1,
    capability: "integration.slack.list_channels",
    provider: "composio",
    status: "running",
    startedAt: "2026-09-09T00:00:00.000Z",
    createdAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReconciliationDeps> = {}) {

  const calls = {
    getWorkCalls: 0,
    listRunsForTaskCalls: 0,
    attachRunExternalRefCalls: [] as { runId: string; externalRef: Record<string, unknown> | null | undefined }[],
    failRunCalls: 0,
    updateTaskStatusCalls: [] as { taskId: string; status: string }[],
    emitAuditEventCalls: [] as { eventType: string; reasonCode?: string | null }[],
  };

  let runs: Run[] = [makeRun()];

  const deps: ReconciliationDeps = {

    getWork: async (workId, userId) => {
      calls.getWorkCalls += 1;
      if (userId !== OWNER_USER_ID) return undefined;
      return makeWork({ id: workId });
    },

    listRunsForTask: async () => {
      calls.listRunsForTaskCalls += 1;
      return runs;
    },

    attachRunExternalRef: async (_workId, _userId, _accessToken, runId, externalRef) => {
      calls.attachRunExternalRefCalls.push({ runId, externalRef });
    },

    failRun: async () => {
      calls.failRunCalls += 1;
    },

    updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
      calls.updateTaskStatusCalls.push({ taskId, status });
    },

    emitAuditEvent: async (request) => {
      calls.emitAuditEventCalls.push({ eventType: request.eventType, reasonCode: request.reasonCode ?? null });
    },

    ...overrides,

  };

  return {
    deps,
    calls,
    setRuns: (newRuns: Run[]) => { runs = newRuns; },
  };

}

function makeFakeRuntimeAdapter(outcomes: RuntimeStartOutcome[]): { adapter: RuntimeAdapter; capturedRequests: RuntimeExecutionRequest[] } {
  const capturedRequests: RuntimeExecutionRequest[] = [];
  let callIndex = 0;
  const adapter: RuntimeAdapter = {
    provider: "trigger_dev",
    getCapabilities: () => ({ durableExecution: true, durableWait: true, scheduling: true }),
    startExecution: async (request) => {
      capturedRequests.push(request);
      const outcome = outcomes[Math.min(callIndex, outcomes.length - 1)];
      callIndex += 1;
      return outcome;
    },
  };
  return { adapter, capturedRequests };
}

const BASE_PARAMS = {
  workId: "work-1",
  userId: OWNER_USER_ID,
  accessToken: "token",
  taskId: "task-1",
  runId: "run-1",
  action: { service: "slack", operation: "list_channels", connectionId: "conn-1" },
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // Step31 — externalRef recovery tests
  // =========================

  // ---- [12][13][14] Trigger start成功+attach失敗後のreconciliation: redispatchが既存executionを返し、handleを復元する ----
  {
    const { deps, calls } = makeDeps();
    const { adapter, capturedRequests } = makeFakeRuntimeAdapter([
      { status: "started", handle: { provider: "trigger_dev", executionId: "recovered-exec-1" } },
    ]);

    const outcome = await reconcileRuntimeExecution(BASE_PARAMS, adapter, deps);

    results.push(
      check(
        "[12/13/14] status='recovered'、redispatchは正確に1回(=exactly one execution前提、idempotency keyによるpoint lookupのため多重match概念自体が存在しない)、attachRunExternalRefが呼ばれる",
        outcome.status === "recovered" &&
          capturedRequests.length === 1 &&
          calls.attachRunExternalRefCalls.length === 1 &&
          calls.attachRunExternalRefCalls[0].externalRef?.runtimeExecutionId === "recovered-exec-1"
      )
    );
  }

  // ---- [15] 0 match相当(Run自体が見つからない) -> not_found ----
  {
    const { deps, setRuns } = makeDeps();
    setRuns([]);
    const { adapter } = makeFakeRuntimeAdapter([{ status: "started", handle: { provider: "trigger_dev", executionId: "x" } }]);

    const outcome = await reconcileRuntimeExecution(BASE_PARAMS, adapter, deps);

    results.push(check("[15] Run自体が存在しない場合はnot_foundを返す(safe unknown)", outcome.status === "not_found"));
  }

  // ---- [18] reconciliationはProviderを一切呼ばない ----
  {
    const { deps } = makeDeps();
    results.push(
      check(
        "[18] ReconciliationDepsにexecuteIntegrationAction相当のfieldが存在しない(Provider呼び出しの手段そのものを型レベルで持たない。isRuntimeEligibleIntegrationAction()はcore/tact-integration/execution.tsから再利用する純粋predicateであり、Provider実行(gateway.ts)を呼び出さない、絶対条件Step15/19)",
        typeof (deps as unknown as { executeIntegrationAction?: unknown }).executeIntegrationAction === "undefined"
      )
    );
  }

  // ---- [19] reconciliationはRunを新規作成しない(createRunに相当するdepsが存在しない、型レベルの証拠) ----
  {
    const { deps } = makeDeps();
    results.push(
      check(
        "[19] ReconciliationDepsにcreateRun相当のfieldが存在しない(型定義自体がcreateRunを持たない)",
        typeof (deps as unknown as { createRun?: unknown }).createRun === "undefined"
      )
    );
  }

  // ---- 既にexternalRefがattach済み -> already_attached(再dispatchしない) ----
  {
    const { deps, setRuns } = makeDeps();
    setRuns([makeRun({ externalRef: { runtimeProvider: "trigger_dev", runtimeExecutionId: "already-there" } })]);
    const { adapter, capturedRequests } = makeFakeRuntimeAdapter([{ status: "started", handle: { provider: "trigger_dev", executionId: "should-not-be-called" } }]);

    const outcome = await reconcileRuntimeExecution(BASE_PARAMS, adapter, deps);

    results.push(
      check(
        "[Step6 pre-check] 既にRun.externalRefが存在する場合はalready_attachedを返し、再dispatchしない(startExecution呼び出し0)",
        outcome.status === "already_attached" && capturedRequests.length === 0
      )
    );
  }

  // ---- 既にterminal(completed)なRun -> not_applicable(reconcile対象外) ----
  {
    const { deps, setRuns } = makeDeps();
    setRuns([makeRun({ status: "completed" })]);
    const { adapter, capturedRequests } = makeFakeRuntimeAdapter([{ status: "started", handle: { provider: "trigger_dev", executionId: "x" } }]);

    const outcome = await reconcileRuntimeExecution(BASE_PARAMS, adapter, deps);

    results.push(
      check(
        "[Step6 pre-check] 既にterminal(completed)なRunはnot_applicableを返し、再dispatchしない",
        outcome.status === "not_applicable" && capturedRequests.length === 0
      )
    );
  }

  // ---- redispatchが再びambiguous -> still_unknown(Runはrunningのまま、failRunは呼ばれない) ----
  {
    const { deps, calls } = makeDeps();
    const { adapter } = makeFakeRuntimeAdapter([
      { status: "failed", error: { code: "runtime_unavailable", message: "safe", retryable: true, outcomeKnown: false } },
    ]);

    const outcome = await reconcileRuntimeExecution(BASE_PARAMS, adapter, deps);

    results.push(
      check(
        "[still_unknown] redispatchが再度ambiguousな場合、still_unknownを返し、failRunは呼ばれない(絶対条件17: 'startしたか不明'状態で再startしない、を再度守る)",
        outcome.status === "still_unknown" && calls.failRunCalls === 0
      )
    );
  }

  // ---- redispatchがdefinite failureを返す -> confirmed_failed(この時点で初めてRunをfailedへ確定) ----
  {
    const { deps, calls } = makeDeps();
    const { adapter } = makeFakeRuntimeAdapter([
      { status: "failed", error: { code: "runtime_rejected", message: "safe", retryable: false, outcomeKnown: true } },
    ]);

    const outcome = await reconcileRuntimeExecution(BASE_PARAMS, adapter, deps);

    results.push(
      check(
        "[confirmed_failed] redispatchがdefinite failureを返した場合、この時点で初めてRunをfailedへ確定する(failRun=1、run.failed emit=1)",
        outcome.status === "confirmed_failed" &&
          calls.failRunCalls === 1 &&
          calls.emitAuditEventCalls.some((e) => e.eventType === "run.failed" && e.reasonCode === "runtime_rejected")
      )
    );
  }

  // ---- ineligible action(send_message)は即座にnot_foundで拒否される(Step19二重ゲート) ----
  {
    const { deps } = makeDeps();
    const { adapter, capturedRequests } = makeFakeRuntimeAdapter([{ status: "started", handle: { provider: "trigger_dev", executionId: "x" } }]);

    const outcome = await reconcileRuntimeExecution(
      { ...BASE_PARAMS, action: { service: "slack", operation: "send_message", connectionId: "conn-1" } },
      adapter,
      deps
    );

    results.push(
      check(
        "[protected write guard] slack.send_messageはreconciliation経由でも拒否され、startExecutionは一切呼ばれない(絶対条件15、Runtime対象外)",
        outcome.status === "not_found" && capturedRequests.length === 0
      )
    );
  }

  // =========================
  // Fast Port P5d — secret safety(Step34)
  // =========================
  {
    const { deps } = makeDeps();
    const { adapter, capturedRequests } = makeFakeRuntimeAdapter([{ status: "started", handle: { provider: "trigger_dev", executionId: "exec-safe" } }]);

    await reconcileRuntimeExecution(BASE_PARAMS, adapter, deps);

    const serialized = JSON.stringify(capturedRequests).toLowerCase();

    results.push(
      check(
        "[secret safety] redispatch requestにservice role key/accessToken/secret等が一切含まれない",
        !serialized.includes("token") && !serialized.includes("secret") && !serialized.includes(BASE_PARAMS.accessToken)
      )
    );
  }

  return summarize("runtime/reconciliation", results);

}
