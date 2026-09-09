// =========================
// TACT Runtime — One-Shot Reconciliation Entrypoint Regression
// (Fast Port P5d: Add Minimal One-Shot Reconciliation Entrypoint)
// =========================
//
// 対象: core/tact-runtime/reconcileOneShotEntrypoint.tsの
// reconcileOneShotIntegrationRead()。実Supabase・実Trigger.devの
// いずれにも一切接続しない(全depsをfakeで差し替える、既存
// runtime/reconciliation.test.tsと同じ規律)。
//
// このsuiteの責務: 「callerが渡せるのはworkId/taskId/runIdだけであり、
// userId/action/connectionIdは信用しない」という、このentrypoint
// 自身が追加する所有者/correlation/eligibility検証だけを確認する。
// reconcileRuntimeExecution()自体のロジック(recovered/still_unknown/
// confirmed_failed等)は既存runtime/reconciliation.test.tsで検証済み
// のため、ここではfakeで置き換えて「正しいparamsで正確に1回だけ
// 呼ばれるか」だけを確認する(二重テスト・二重実装を避ける)。
import {
  reconcileOneShotIntegrationRead,
  type ReconcileOneShotIntegrationReadDeps,
} from "../../../core/tact-runtime/reconcileOneShotEntrypoint";
import type { Work, WorkTask, Run } from "../../../core/tact-work/types";
import type { Connection } from "../../../core/tact-integration/types";
import type { RuntimeIntegrationReadResolution } from "../../../core/tact-runtime/enablement";
import type { RuntimeAdapter } from "../../../core/tact-runtime/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";
const OTHER_USER_ID = "user-2";

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

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    workId: "work-1",
    description: "list slack channels",
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

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    userId: OWNER_USER_ID,
    service: "slack",
    status: "active",
    provider: "composio",
    providerConnectionRef: "composio-ref-1",
    metadata: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

const ENABLED_RESOLUTION: RuntimeIntegrationReadResolution = {
  status: "enabled",
  adapter: {
    provider: "trigger_dev",
    getCapabilities: () => ({ durableExecution: true, durableWait: true, scheduling: true }),
    startExecution: async () => {
      throw new Error("this fake adapter must never be called directly by the entrypoint");
    },
  } as RuntimeAdapter,
};

interface MakeDepsOptions {
  work?: Work | undefined;
  tasks?: WorkTask[];
  runs?: Run[];
  connections?: Connection[];
  resolution?: RuntimeIntegrationReadResolution;
}

function makeDeps(options: MakeDepsOptions = {}) {

  const calls = {
    getWorkCalls: 0,
    reconcileCalls: [] as unknown[],
  };

  const work = "work" in options ? options.work : makeWork();
  const tasks = options.tasks ?? [makeTask()];
  const runs = options.runs ?? [makeRun()];
  const connections = options.connections ?? [makeConnection()];
  const resolution = options.resolution ?? ENABLED_RESOLUTION;

  let reconcileResult: unknown = { status: "recovered", run: runs[0] };

  const deps: ReconcileOneShotIntegrationReadDeps = {

    getWork: async (_workId, userId) => {
      calls.getWorkCalls += 1;
      if (userId !== OWNER_USER_ID) return undefined;
      return work;
    },

    listTasksForWork: async () => tasks,

    listRunsForTask: async () => runs,

    listConnectionsForUser: async () => connections,

    resolveRuntimeAdapter: () => resolution,

    reconcileRuntimeExecution: (async (params: unknown) => {
      calls.reconcileCalls.push(params);
      return reconcileResult;
    }) as ReconcileOneShotIntegrationReadDeps["reconcileRuntimeExecution"],

  };

  return {
    deps,
    calls,
    setReconcileResult: (value: unknown) => { reconcileResult = value; },
  };

}

const BASE_PARAMS = {
  userId: OWNER_USER_ID,
  accessToken: "token-abc",
  workId: "work-1",
  taskId: "task-1",
  runId: "run-1",
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [1] 正常系: owner一致・correlation一致・capability一致・Connection1件・runtime enabled -> reconcileRuntimeExecutionへ正確に1回、解決済みconnectionIdで委譲 ----
  {
    const { deps, calls } = makeDeps();

    const result = await reconcileOneShotIntegrationRead(BASE_PARAMS, deps);

    results.push(
      check(
        "[1] 正常系: ok=true、reconcileRuntimeExecutionが正確に1回、hardcodedなslack.list_channels + 再解決済みconnectionIdで呼ばれる",
        result.ok === true &&
          calls.reconcileCalls.length === 1 &&
          JSON.stringify(calls.reconcileCalls[0]).includes('"service":"slack"') &&
          JSON.stringify(calls.reconcileCalls[0]).includes('"operation":"list_channels"') &&
          JSON.stringify(calls.reconcileCalls[0]).includes('"connectionId":"conn-1"')
      )
    );
  }

  // ---- [2] Wrong owner -> not_found、reconcileは呼ばれない(なりすまし不可) ----
  {
    const { deps, calls } = makeDeps();

    const result = await reconcileOneShotIntegrationRead(
      { ...BASE_PARAMS, userId: OTHER_USER_ID },
      deps
    );

    results.push(
      check(
        "[2] 所有者不一致(getWorkがundefinedを返す)場合はnot_found、reconcileRuntimeExecution呼び出し0",
        !result.ok && result.reason === "not_found" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [3] Work/Task correlation不一致(指定workIdに存在しないtaskId) -> not_found ----
  {
    const { deps, calls } = makeDeps({ tasks: [makeTask({ id: "task-1", workId: "other-work" })] });

    const result = await reconcileOneShotIntegrationRead(BASE_PARAMS, deps);

    results.push(
      check(
        "[3] Task.workIdが指定workIdと一致しない場合はnot_found、reconcileRuntimeExecution呼び出し0",
        !result.ok && result.reason === "not_found" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [4] Task/Run correlation不一致(指定taskIdに存在しないrunId) -> not_found ----
  {
    const { deps, calls } = makeDeps({ runs: [makeRun({ id: "run-1", taskId: "other-task" })] });

    const result = await reconcileOneShotIntegrationRead(BASE_PARAMS, deps);

    results.push(
      check(
        "[4] Run.taskIdが指定taskIdと一致しない場合はnot_found、reconcileRuntimeExecution呼び出し0",
        !result.ok && result.reason === "not_found" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [5] protected write相当のRun(capability不一致) -> not_eligible、fail closed ----
  {
    const { deps, calls } = makeDeps({ runs: [makeRun({ capability: "integration.slack.send_message" })] });

    const result = await reconcileOneShotIntegrationRead(BASE_PARAMS, deps);

    results.push(
      check(
        "[5] Run.capabilityがslack.list_channelsでない(例: send_message)場合はnot_eligible、reconcileRuntimeExecution呼び出し0",
        !result.ok && result.reason === "not_eligible" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [6] unknown/無関係なcapabilityのRun -> not_eligible、fail closed ----
  {
    const { deps, calls } = makeDeps({ runs: [makeRun({ capability: "llm.researcher" })] });

    const result = await reconcileOneShotIntegrationRead(BASE_PARAMS, deps);

    results.push(
      check(
        "[6] 無関係なcapability(例: llm.researcher)のRunはnot_eligible、reconcileRuntimeExecution呼び出し0(任意Run lookup不可)",
        !result.ok && result.reason === "not_eligible" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [7] Slack Connectionが0件 -> connection_unresolved、fail closed ----
  {
    const { deps, calls } = makeDeps({ connections: [] });

    const result = await reconcileOneShotIntegrationRead(BASE_PARAMS, deps);

    results.push(
      check(
        "[7] Slack Connectionが0件の場合はconnection_unresolved、reconcileRuntimeExecution呼び出し0",
        !result.ok && result.reason === "connection_unresolved" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [8] Slack Connectionが複数件 -> connection_unresolved、fail closed(推測でどれかを選ばない) ----
  {
    const { deps, calls } = makeDeps({ connections: [makeConnection({ id: "conn-1" }), makeConnection({ id: "conn-2" })] });

    const result = await reconcileOneShotIntegrationRead(BASE_PARAMS, deps);

    results.push(
      check(
        "[8] Slack Connectionが複数件の場合はconnection_unresolved(推測で選ばない)、reconcileRuntimeExecution呼び出し0",
        !result.ok && result.reason === "connection_unresolved" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [9] Runtime flag disabled -> runtime_unavailable、fail closed ----
  {
    const { deps, calls } = makeDeps({ resolution: { status: "disabled" } });

    const result = await reconcileOneShotIntegrationRead(BASE_PARAMS, deps);

    results.push(
      check(
        "[9] resolveRuntimeAdapter()がdisabledの場合はruntime_unavailable、reconcileRuntimeExecution呼び出し0",
        !result.ok && result.reason === "runtime_unavailable" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [10] Runtime config misconfigured -> runtime_unavailable、fail closed(silent fallbackしない) ----
  {
    const { deps, calls } = makeDeps({ resolution: { status: "misconfigured" } });

    const result = await reconcileOneShotIntegrationRead(BASE_PARAMS, deps);

    results.push(
      check(
        "[10] resolveRuntimeAdapter()がmisconfiguredの場合もruntime_unavailable、reconcileRuntimeExecution呼び出し0",
        !result.ok && result.reason === "runtime_unavailable" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [11] このfile自身がProvider実行/新規dispatch/createRunの手段を一切importしていない(型レベルの構造的証拠) ----
  {
    const { deps } = makeDeps();

    results.push(
      check(
        "[11] depsにstartExecution/executeIntegrationAction/createRun相当のfieldが存在しない(reconcileRuntimeExecutionへの委譲1本だけ)",
        typeof (deps as unknown as { startExecution?: unknown }).startExecution === "undefined" &&
          typeof (deps as unknown as { executeIntegrationAction?: unknown }).executeIntegrationAction === "undefined" &&
          typeof (deps as unknown as { createRun?: unknown }).createRun === "undefined"
      )
    );
  }

  // ---- [12] secret safety: 戻り値(outcome)にaccessToken/secretが一切含まれない ----
  {
    const { deps } = makeDeps();

    const result = await reconcileOneShotIntegrationRead(BASE_PARAMS, deps);

    const serialized = JSON.stringify(result).toLowerCase();

    results.push(
      check(
        "[12] secret safety: reconcileOneShotIntegrationRead()の戻り値にaccessToken値/secret文字列が含まれない",
        !serialized.includes(BASE_PARAMS.accessToken.toLowerCase()) && !serialized.includes("secret")
      )
    );
  }

  // ---- [13] 任意Run lookup不可: 存在しないrunIdを指定した場合もnot_found(既存Run一覧に含まれないIDでの直接推測アクセスを許さない) ----
  {
    const { deps, calls } = makeDeps();

    const result = await reconcileOneShotIntegrationRead(
      { ...BASE_PARAMS, runId: "run-does-not-exist" },
      deps
    );

    results.push(
      check(
        "[13] 存在しないrunIdを指定した場合はnot_found、reconcileRuntimeExecution呼び出し0(任意Run lookup不可)",
        !result.ok && result.reason === "not_found" && calls.reconcileCalls.length === 0
      )
    );
  }

  return summarize("runtime/reconcileOneShotEntrypoint", results);

}
