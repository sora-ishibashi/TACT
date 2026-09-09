// =========================
// TACT Work — Stranded Task/Run Projection Reconciliation Regression
// (DUR-P1: Stranded Task State Integrity Fix)
// =========================
//
// 対象:
//   - core/tact-work/taskRunReconciliation.ts
//     (evaluateStrandedTaskProjection() / reconcileStrandedTaskProjection())
//   - core/tact-integration/execution.ts の prepareRunForExecution()
//     (Run claimをTask projection更新より先に行う新しい順序、
//     および先行attemptがrunningのまま残っている場合の新しいguard)
//
// 実Supabase・実Composio・実Trigger.devのいずれにも一切接続しない
// (既存tests/tact/integration/execution.test.ts・work/resume.test.ts・
// runtime/reconciliation.test.tsと同じDIテスト手法)。
import {
  evaluateStrandedTaskProjection,
  findLatestRun,
  reconcileStrandedTaskProjection,
  type ReconcileStrandedTaskProjectionDeps,
} from "../../../core/tact-work/taskRunReconciliation";
import {
  dispatchIntegrationReadToRuntime,
  type ExecuteApprovedIntegrationActionDeps,
} from "../../../core/tact-integration/execution";
import type { Run, Work, WorkTask, TaskStatus } from "../../../core/tact-work/types";
import type { Connection, IntegrationExecutionResult } from "../../../core/tact-integration/types";
import type { RuntimeAdapter, RuntimeStartOutcome, RuntimeExecutionRequest } from "../../../core/tact-runtime/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";

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

// =========================
// Pure function tests: evaluateStrandedTaskProjection() / findLatestRun()
// =========================

function testPureFunctions(results: CheckResult[]): void {

  results.push(
    check(
      "[pure] findLatestRun()はattempt番号が最大のRunを返す",
      findLatestRun([makeRun({ id: "a", attempt: 1 }), makeRun({ id: "b", attempt: 3 }), makeRun({ id: "c", attempt: 2 })])?.id === "b"
    )
  );

  results.push(
    check(
      "[pure] findLatestRun()はRunが0件ならundefinedを返す",
      findLatestRun([]) === undefined
    )
  );

  // state A(Task running / Run 0)は、Run無しの場合は常にnot_applicable
  // (=修復不要)として扱われる——prepareRunForExecution()の新しい順序
  // 変更により、このstate自体が構造的に発生しなくなったため、
  // このfileはstate Aを「直すべきdrift」として扱わない。
  results.push(
    check(
      "[state A] Runが1件も無い場合はnot_applicable(no_runs)——Task.statusを勝手に変更しない",
      evaluateStrandedTaskProjection("running", []).status === "not_applicable"
    )
  );

  // state B: Run running / Task pending -> Task を running へ projection。
  results.push(
    check(
      "[state B] Run running / Task pending -> projected(running)",
      JSON.stringify(evaluateStrandedTaskProjection("pending", [makeRun({ status: "running" })])) ===
        JSON.stringify({ status: "projected", taskStatus: "running" })
    )
  );

  // state C: Run completed / Task running -> Task を completed へ projection。
  results.push(
    check(
      "[state C] Run completed / Task running -> projected(completed)",
      JSON.stringify(evaluateStrandedTaskProjection("running", [makeRun({ status: "completed" })])) ===
        JSON.stringify({ status: "projected", taskStatus: "completed" })
    )
  );

  // state D: Run failed / Task running -> Task を failed へ projection。
  results.push(
    check(
      "[state D] Run failed / Task running -> projected(failed)",
      JSON.stringify(evaluateStrandedTaskProjection("running", [makeRun({ status: "failed" })])) ===
        JSON.stringify({ status: "projected", taskStatus: "failed" })
    )
  );

  // state E: Run completed / Task pending -> Task を completed へ projection
  // (対称: failedも同様)。
  results.push(
    check(
      "[state E] Run completed / Task pending -> projected(completed)",
      JSON.stringify(evaluateStrandedTaskProjection("pending", [makeRun({ status: "completed" })])) ===
        JSON.stringify({ status: "projected", taskStatus: "completed" })
    )
  );

  results.push(
    check(
      "[state E/failed] Run failed / Task pending -> projected(failed)",
      JSON.stringify(evaluateStrandedTaskProjection("pending", [makeRun({ status: "failed" })])) ===
        JSON.stringify({ status: "projected", taskStatus: "failed" })
    )
  );

  // state F: 複数のRunが同時にrunning -> どちらが正か機械的に判定できない
  // ため、独自にルールを拡張せずnot_applicableとする。
  results.push(
    check(
      "[state F] 複数のRunが同時にrunning -> not_applicable(multiple_active_runs)、Task.statusを勝手に変更しない",
      evaluateStrandedTaskProjection("pending", [
        makeRun({ id: "a", attempt: 1, status: "running" }),
        makeRun({ id: "b", attempt: 2, status: "running" }),
      ]).status === "not_applicable"
    )
  );

  // 正当なambiguous state(Step6): Run running / Task running は
  // 「今まさに正しく実行中」であり、drift/壊れたstateとして誤認して
  // はいけない(no_drift、修復しない)。
  results.push(
    check(
      "[Runtime ambiguity互換] Run running / Task running(legitimate in-flight) -> no_drift(壊れたstateと誤認しない)",
      evaluateStrandedTaskProjection("running", [makeRun({ status: "running" })]).status === "no_drift"
    )
  );

  // 既にTask.statusがRunの実体と一致している場合(completed/completed)は
  // no_drift。
  results.push(
    check(
      "[no_drift] Task completed / Run completed -> no_drift",
      evaluateStrandedTaskProjection("completed", [makeRun({ status: "completed" })]).status === "no_drift"
    )
  );

}

// =========================
// reconcileStrandedTaskProjection() — DIベースのside effect検証
// =========================

interface MakeReconcileDepsOptions {
  // undefined(省略)= 既定のWorkを使う。null = Work不明(所有者不一致/
  // 存在しない)を明示的に表す——省略時とnull指定を区別するため、
  // デフォルトのoptional undefinedとは別の値として扱う。
  work?: Work | null;
  tasks?: WorkTask[];
  runs?: Run[];
}

function makeReconcileDeps(options: MakeReconcileDepsOptions = {}) {

  const calls = {
    updateTaskStatusCalls: [] as { taskId: string; status: TaskStatus }[],
    reconcileWorkCompletionStatusCalls: 0,
  };

  const work: Work | undefined =
    options.work === null
      ? undefined
      : (options.work ??
        ({
          id: "work-1",
          userId: OWNER_USER_ID,
          createdByActorKind: "user",
          createdByActorId: OWNER_USER_ID,
          status: "running",
          createdAt: "2026-09-09T00:00:00.000Z",
          updatedAt: "2026-09-09T00:00:00.000Z",
        } as Work));

  const tasks: WorkTask[] =
    options.tasks ?? [
      {
        id: "task-1",
        workId: "work-1",
        description: "test",
        status: "pending",
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
      } as WorkTask,
    ];

  const runs: Run[] = options.runs ?? [];

  const deps: ReconcileStrandedTaskProjectionDeps = {

    getWork: async () => work,

    listTasksForWork: async () => tasks,

    listRunsForTask: async () => runs,

    updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
      calls.updateTaskStatusCalls.push({ taskId, status });
    },

    reconcileWorkCompletionStatus: async () => {
      calls.reconcileWorkCompletionStatusCalls += 1;
      return { status: "no_change", reason: "tasks_not_all_terminal" };
    },

  };

  return { deps, calls };

}

async function testReconcileStrandedTaskProjection(results: CheckResult[]): Promise<void> {

  // Work所有者不一致/存在しない -> not_found、Task.statusへは一切触れない。
  {
    const { deps, calls } = makeReconcileDeps({ work: null });

    const outcome = await reconcileStrandedTaskProjection("work-1", OWNER_USER_ID, "token", "task-1", deps);

    results.push(
      check(
        "[reconcile] Work不明はnot_foundを返し、updateTaskStatusは一切呼ばれない",
        outcome.status === "not_found" && calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // Task不明 -> not_found。
  {
    const { deps } = makeReconcileDeps({ tasks: [] });

    const outcome = await reconcileStrandedTaskProjection("work-1", OWNER_USER_ID, "token", "task-1", deps);

    results.push(check("[reconcile] Task不明はnot_foundを返す", outcome.status === "not_found"));
  }

  // state B修復: Task pending / Run running -> Task を running へ更新、
  // reconcileWorkCompletionStatus()は呼ばれない(terminalではないため)。
  {
    const { deps, calls } = makeReconcileDeps({ runs: [makeRun({ status: "running" })] });

    const outcome = await reconcileStrandedTaskProjection("work-1", OWNER_USER_ID, "token", "task-1", deps);

    results.push(
      check(
        "[reconcile/stateB] Task pending / Run running -> Taskをrunningへ更新",
        outcome.status === "projected" &&
          calls.updateTaskStatusCalls.length === 1 &&
          calls.updateTaskStatusCalls[0].status === "running" &&
          calls.reconcileWorkCompletionStatusCalls === 0
      )
    );
  }

  // state C修復: Task running / Run completed -> Task を completed へ更新、
  // reconcileWorkCompletionStatus()も1回呼ばれる(architecture debt A解消
  // と同じ理由、Work全体の集約判定を促す)。
  {
    const { deps, calls } = makeReconcileDeps({
      tasks: [
        {
          id: "task-1",
          workId: "work-1",
          description: "test",
          status: "running",
          createdAt: "2026-09-09T00:00:00.000Z",
          updatedAt: "2026-09-09T00:00:00.000Z",
        } as WorkTask,
      ],
      runs: [makeRun({ status: "completed" })],
    });

    const outcome = await reconcileStrandedTaskProjection("work-1", OWNER_USER_ID, "token", "task-1", deps);

    results.push(
      check(
        "[reconcile/stateC] Task running / Run completed -> Taskをcompletedへ更新し、reconcileWorkCompletionStatus()も呼ばれる",
        outcome.status === "projected" &&
          calls.updateTaskStatusCalls[0]?.status === "completed" &&
          calls.reconcileWorkCompletionStatusCalls === 1
      )
    );
  }

  // no_drift: Task/Runが既に一致 -> 何も更新しない。
  {
    const { deps, calls } = makeReconcileDeps({
      tasks: [
        {
          id: "task-1",
          workId: "work-1",
          description: "test",
          status: "running",
          createdAt: "2026-09-09T00:00:00.000Z",
          updatedAt: "2026-09-09T00:00:00.000Z",
        } as WorkTask,
      ],
      runs: [makeRun({ status: "running" })],
    });

    const outcome = await reconcileStrandedTaskProjection("work-1", OWNER_USER_ID, "token", "task-1", deps);

    results.push(
      check(
        "[reconcile/no_drift] 既に一致している場合はupdateTaskStatusを一切呼ばない(正当なambiguous stateを壊さない)",
        outcome.status === "no_drift" && calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // reconcileWorkCompletionStatus()自体が失敗しても、修復結果
  // (projected)は変更しない(reconcileAfterTaskUpdate()と同じ
  // fail-safe方針)。
  {
    const { deps, calls } = makeReconcileDeps({
      tasks: [
        {
          id: "task-1",
          workId: "work-1",
          description: "test",
          status: "running",
          createdAt: "2026-09-09T00:00:00.000Z",
          updatedAt: "2026-09-09T00:00:00.000Z",
        } as WorkTask,
      ],
      runs: [makeRun({ status: "failed" })],
    });

    deps.reconcileWorkCompletionStatus = async () => {
      throw new Error("simulated DB failure");
    };

    const outcome = await reconcileStrandedTaskProjection("work-1", OWNER_USER_ID, "token", "task-1", deps);

    results.push(
      check(
        "[reconcile/fail-safe] reconcileWorkCompletionStatus()が失敗してもTask修復結果自体はprojectedのまま返る(例外を外へ伝播させない)",
        outcome.status === "projected" && outcome.taskStatus === "failed" && calls.updateTaskStatusCalls.length === 1
      )
    );
  }

}

// =========================
// prepareRunForExecution()(core/tact-integration/execution.ts)への
// DUR-P1変更の振る舞い検証。dispatchIntegrationReadToRuntime()経由で
// 検証する(executeApprovedIntegrationAction()と共有される同一の
// prepareRunForExecution()を、Approval Integrity setupを必要としない
// read/runtime pathから最小コストで確認する——既存execution.tsの
// コメントが明記する通り、両pathはこの関数を共有する)。
// =========================

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

interface MakeExecutionDepsOptions {
  task?: WorkTask;
  existingRuns?: Run[];
  createRun?: ExecuteApprovedIntegrationActionDeps["createRun"];
  updateTaskStatus?: ExecuteApprovedIntegrationActionDeps["updateTaskStatus"];
}

function makeExecutionDeps(options: MakeExecutionDepsOptions = {}) {

  const calls = {
    createRunCalls: 0,
    updateTaskStatusCalls: [] as { taskId: string; status: string }[],
    executeIntegrationActionCalls: 0,
  };

  const task: WorkTask =
    options.task ?? {
      id: "task-1",
      workId: "work-1",
      description: "test",
      status: "pending",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    };

  const connection: Connection = {
    id: "conn-1",
    userId: OWNER_USER_ID,
    service: "slack",
    status: "active",
    provider: "composio",
    providerConnectionRef: "ca_slack_123",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };

  const defaultCreateRun: ExecuteApprovedIntegrationActionDeps["createRun"] = async (workId, userId, accessToken, taskId, params) => {
    calls.createRunCalls += 1;
    return makeRun({ workId, taskId, attempt: params.attempt, capability: params.capability, provider: params.provider ?? null });
  };

  const defaultUpdateTaskStatus: ExecuteApprovedIntegrationActionDeps["updateTaskStatus"] = async (_workId, _userId, _accessToken, taskId, status) => {
    calls.updateTaskStatusCalls.push({ taskId, status });
  };

  const deps: ExecuteApprovedIntegrationActionDeps = {

    getWork: async (workId, userId) => {
      if (userId !== OWNER_USER_ID) return undefined;
      return {
        id: workId,
        userId: OWNER_USER_ID,
        createdByActorKind: "user",
        createdByActorId: OWNER_USER_ID,
        status: "running",
        createdAt: "2026-09-07T00:00:00.000Z",
        updatedAt: "2026-09-07T00:00:00.000Z",
      } as Work;
    },

    getApproval: async () => undefined,

    getConnection: async (connectionId, userId) => {
      if (userId !== OWNER_USER_ID) return undefined;
      return { ...connection, id: connectionId };
    },

    listTasksForWork: async () => [task],

    listRunsForTask: async () => options.existingRuns ?? [],

    createRun: options.createRun ?? defaultCreateRun,

    completeRun: async () => {},

    failRun: async () => {},

    updateTaskStatus: options.updateTaskStatus ?? defaultUpdateTaskStatus,

    executeIntegrationAction: async (): Promise<IntegrationExecutionResult> => {
      calls.executeIntegrationActionCalls += 1;
      return { status: "completed", providerExecutionRef: "log-1", output: { ok: true } };
    },

    reconcileWorkCompletionStatus: async () => ({ status: "no_change", reason: "tasks_not_all_terminal" }),

    emitAuditEvent: async () => {},

    attachRunExternalRef: async () => {},

  };

  return { deps, calls };

}

const READ_ACTION = { service: "slack", operation: "list_channels", input: {} } as const;

async function testPrepareRunForExecution(results: CheckResult[]): Promise<void> {

  // [8/9] normal execution claim succeeds(既存動作の回帰確認、新しい
  // guard/順序変更後も通常経路は壊れていない)。
  {
    const { deps, calls } = makeExecutionDeps();
    const { adapter } = makeFakeRuntimeAdapter({ status: "started", handle: { provider: "trigger_dev", executionId: "exec-1" } });

    const outcome = await dispatchIntegrationReadToRuntime(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: READ_ACTION },
      adapter,
      deps
    );

    results.push(
      check(
        "[1] normal execution claim succeeds(dispatched、createRun 1回)",
        outcome.status === "dispatched" && calls.createRunCalls === 1
      )
    );
  }

  // [2] Task running / Run 0のstranded windowが防止される: createRun()の
  // 前段でTask.statusをrunningへ更新しない新しい順序のもとでは、
  // createRun()が失敗してもTask.statusはpendingのまま残り、次回の
  // 実行attemptが引き続き可能(=structurally防止、二度とpendingゲートを
  // 通れなくなることが無い)。
  {
    const failingCreateRun: ExecuteApprovedIntegrationActionDeps["createRun"] = async () => {
      throw new Error("simulated DB failure during createRun");
    };

    const { deps, calls } = makeExecutionDeps({ createRun: failingCreateRun });
    const { adapter } = makeFakeRuntimeAdapter({ status: "started", handle: { provider: "trigger_dev", executionId: "exec-1" } });

    let threw = false;

    try {
      await dispatchIntegrationReadToRuntime(
        { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: READ_ACTION },
        adapter,
        deps
      );
    } catch {
      threw = true;
    }

    results.push(
      check(
        "[2] createRun()自体が失敗した場合、updateTaskStatus(\"running\")は一度も呼ばれない(Task.statusはpendingのまま、stranded state A発生不可)",
        threw && calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // [3] Run created / Task update failure -> execution自体は継続する
  // (recover可能、Run claimはすでに成立しているため実行を止めない)。
  {
    const failingUpdateTaskStatus: ExecuteApprovedIntegrationActionDeps["updateTaskStatus"] = async () => {
      throw new Error("simulated DB failure during updateTaskStatus(running)");
    };

    const { deps, calls } = makeExecutionDeps({ updateTaskStatus: failingUpdateTaskStatus });
    const { adapter } = makeFakeRuntimeAdapter({ status: "started", handle: { provider: "trigger_dev", executionId: "exec-1" } });

    const outcome = await dispatchIntegrationReadToRuntime(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: READ_ACTION },
      adapter,
      deps
    );

    results.push(
      check(
        "[3] Run作成成功後にTask projection更新が失敗しても、Run claimは既に成立しているためexecutionはそのまま継続する(dispatched)",
        outcome.status === "dispatched" && calls.createRunCalls === 1
      )
    );
  }

  // [6] two concurrent starts -> canonical Run exactly 1(実store.tsの
  // createRun()と同じ「先にclaimした側だけが成功する」挙動を最小限に
  // 再現する。二重実行防止の最終防御は既存DB unique index
  // (idx_tact_runs_task_id_attempt)であり、ここではその「片方が
  // 必ず例外を投げる」という契約——core/tact-conversation/
  // orchestration.tsのisConcurrentRunClaimError()が検出に使う契約——を
  // このfileが壊していないことを確認する)。
  {
    let claimed = false;
    let createRunCalls = 0;

    const racyCreateRun: ExecuteApprovedIntegrationActionDeps["createRun"] = async (workId, userId, accessToken, taskId, params) => {

      createRunCalls += 1;

      if (claimed) {
        throw new Error(`Run attempt already exists (taskId=${taskId}, attempt=${params.attempt}).`);
      }

      claimed = true;

      await Promise.resolve();

      return makeRun({ workId, taskId, attempt: params.attempt });

    };

    const { deps } = makeExecutionDeps({ createRun: racyCreateRun });
    const { adapter } = makeFakeRuntimeAdapter({ status: "started", handle: { provider: "trigger_dev", executionId: "exec-1" } });

    const results2 = await Promise.allSettled([
      dispatchIntegrationReadToRuntime(
        { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: READ_ACTION },
        adapter,
        deps
      ),
      dispatchIntegrationReadToRuntime(
        { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: READ_ACTION },
        adapter,
        deps
      ),
    ]);

    const fulfilled = results2.filter((r) => r.status === "fulfilled");
    const rejected = results2.filter((r) => r.status === "rejected");

    results.push(
      check(
        "[6] 2つのほぼ同時のstartのうち、canonical Run claim成功はexactly 1件(もう一方はcreateRun()自身の例外——orchestration.tsのisConcurrentRunClaimError()契約に合致する形——で失敗する)",
        createRunCalls === 2 && fulfilled.length === 1 && rejected.length === 1
      )
    );
  }

  // [9] active legitimate ambiguous Runを壊さない: Task.status="running"
  // かつ既存Run.status="running"(externalRef未設定=ambiguous相当)の
  // 状態で、新規executionを試みても新しいRunは作られず、既存Task/Run
  // stateはそのまま安全にtask_not_executableで拒否される。
  {
    const runningTask: WorkTask = {
      id: "task-1",
      workId: "work-1",
      description: "test",
      status: "running",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    };

    const { deps, calls } = makeExecutionDeps({ task: runningTask, existingRuns: [makeRun({ status: "running" })] });
    const { adapter } = makeFakeRuntimeAdapter({ status: "started", handle: { provider: "trigger_dev", executionId: "exec-1" } });

    const outcome = await dispatchIntegrationReadToRuntime(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: READ_ACTION },
      adapter,
      deps
    );

    results.push(
      check(
        "[9] Task running / Run runningのlegitimate ambiguous stateでは、新しいRunは作られずtask_not_executableで安全に拒否される",
        outcome.status === "task_not_executable" && calls.createRunCalls === 0
      )
    );
  }

  // [新guard] Task.status="pending"のまま(先行attemptのTask projection
  // 更新が未完了)でも、既存Run.status="running"が1件でも残っていれば
  // 新規attemptを開始しない(state Bが複数Run(state F)へ悪化することを
  // 防ぐ、Run 0件のstate Aとは別の独立したguard)。
  {
    const { deps, calls } = makeExecutionDeps({ existingRuns: [makeRun({ status: "running" })] });
    const { adapter } = makeFakeRuntimeAdapter({ status: "started", handle: { provider: "trigger_dev", executionId: "exec-1" } });

    const outcome = await dispatchIntegrationReadToRuntime(
      { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-1", action: READ_ACTION },
      adapter,
      deps
    );

    results.push(
      check(
        "[新guard] Task.status='pending'のままでも、既存running Runが残っていれば新規attemptを開始しない(createRun 0、state Fへの悪化を防ぐ)",
        outcome.status === "task_not_executable" && calls.createRunCalls === 0
      )
    );
  }

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  testPureFunctions(results);
  await testReconcileStrandedTaskProjection(results);
  await testPrepareRunForExecution(results);

  return summarize("work/taskRunReconciliation", results);

}
