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
  computeNextAttemptNumber,
  isRetryableIntegrationFailure,
  evaluateTaskRetryEligibility,
  type ReconcileStrandedTaskProjectionDeps,
  type TaskRetryEligibilityDeps,
} from "../../../core/tact-work/taskRunReconciliation";
import {
  dispatchIntegrationReadToRuntime,
  type ExecuteApprovedIntegrationActionDeps,
} from "../../../core/tact-integration/execution";
import { toRun, type RunRow } from "../../../core/tact-work/store";
import { reconcileWorkCompletionStatus } from "../../../core/tact-work/completion";
import type { Run, Work, WorkTask, TaskStatus, WorkStatus } from "../../../core/tact-work/types";
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

  // =========================
  // computeNextAttemptNumber (RUNS-P1)
  // =========================
  //
  // 挙動自体はcore/tact-integration/execution.tsのprepareRunForExecution()
  // に元々inline実装されていたものと完全に同じ(切り出しただけ)。

  results.push(
    check(
      "[RUNS-P1] computeNextAttemptNumber(): Runが0件のTaskは常にattempt=1から始まる",
      computeNextAttemptNumber([]) === 1
    )
  );

  results.push(
    check(
      "[RUNS-P1] computeNextAttemptNumber(): 既存Runの最大attempt+1を返す(配列の順序に依存しない)",
      computeNextAttemptNumber([makeRun({ attempt: 1 }), makeRun({ attempt: 3 }), makeRun({ attempt: 2 })]) === 4
    )
  );

  results.push(
    check(
      "[RUNS-P1] computeNextAttemptNumber(): 単一Runのみの場合はattempt+1",
      computeNextAttemptNumber([makeRun({ attempt: 1, status: "failed" })]) === 2
    )
  );

  results.push(
    check(
      "[RUNS-P1] computeNextAttemptNumber(): statusに関わらずattempt番号だけを見る(failed/completed/runningいずれも対象)",
      computeNextAttemptNumber([
        makeRun({ attempt: 1, status: "failed" }),
        makeRun({ attempt: 2, status: "completed" }),
      ]) === 3
    )
  );

  // =========================
  // isRetryableIntegrationFailure (RUNS-P1)
  // =========================
  //
  // このRunのexternalRefは、core/tact-integration/execution.tsの
  // executeIntegrationActionCore()が実際に書き込むものと同じ形
  // (tests/tact/integration/execution.test.tsのend-to-end確認と対称的な、
  // このfile側の純粋関数単体確認)。

  results.push(
    check(
      '[RUNS-P1] isRetryableIntegrationFailure(): status="failed" かつ externalRef.errorRetryable=trueならtrue',
      isRetryableIntegrationFailure(
        makeRun({ status: "failed", externalRef: { errorCode: "temporary_failure", errorRetryable: true } })
      ) === true
    )
  );

  results.push(
    check(
      '[RUNS-P1] isRetryableIntegrationFailure(): status="failed" かつ externalRef.errorRetryable=falseならfalse(undefinedと混同しない)',
      isRetryableIntegrationFailure(
        makeRun({ status: "failed", externalRef: { errorCode: "authentication_error", errorRetryable: false } })
      ) === false
    )
  );

  results.push(
    check(
      "[RUNS-P1] isRetryableIntegrationFailure(): status=\"completed\"のRunは(externalRefに何があっても)undefined(retryability判定の対象外)",
      isRetryableIntegrationFailure(
        makeRun({ status: "completed", externalRef: { errorCode: "temporary_failure", errorRetryable: true } })
      ) === undefined
    )
  );

  results.push(
    check(
      "[RUNS-P1] isRetryableIntegrationFailure(): externalRefが無い(RUNS-P1以前の既存Run、または非Integration Capability由来)failed Runはundefined(fail closed、falseと混同しない)",
      isRetryableIntegrationFailure(makeRun({ status: "failed", externalRef: null })) === undefined &&
        isRetryableIntegrationFailure(makeRun({ status: "failed", externalRef: undefined })) === undefined
    )
  );

  results.push(
    check(
      "[RUNS-P1] isRetryableIntegrationFailure(): errorRetryableが真偽値でない(壊れた/想定外のexternalRef)場合もundefined",
      isRetryableIntegrationFailure(
        makeRun({ status: "failed", externalRef: { errorRetryable: "yes" } })
      ) === undefined
    )
  );

  // =========================
  // Retry preserves canonical capability / execution binding (RUNS-P1
  // Section14/23-#11)
  // =========================
  //
  // toRun()(core/tact-work/store.ts、CAP-P1b)はcapability(execution
  // binding)からcanonicalCapabilitiesを都度導出する純粋関数。同じTaskの
  // 複数attempt(retry)が同じcapability文字列を持つ限り、
  // canonicalCapabilitiesも常に同じ値へ解決されることを、実際に2件の
  // Run(attempt=1 failed, attempt=2 completed、同じtask_id/capability)を
  // 使って確認する——「retryが新しいcapability/bindingへ黙って変質しない」
  // ことの直接証拠。
  {

    const attempt1Row: RunRow = {
      id: "run-1",
      work_id: "work-1",
      task_id: "task-1",
      attempt: 1,
      capability: "integration.gmail.search_messages",
      provider: "composio",
      model: null,
      status: "failed",
      started_at: "2026-09-14T00:00:00.000Z",
      completed_at: "2026-09-14T00:01:00.000Z",
      error: "temporary network error",
      cost: null,
      external_ref: { errorCode: "temporary_failure", errorRetryable: true },
      result: null,
      created_at: "2026-09-14T00:00:00.000Z",
    };

    const attempt2Row: RunRow = {
      ...attempt1Row,
      id: "run-2",
      attempt: 2,
      status: "completed",
      completed_at: "2026-09-14T00:02:00.000Z",
      error: null,
      external_ref: null,
      result: { success: true },
    };

    const run1 = toRun(attempt1Row);
    const run2 = toRun(attempt2Row);

    results.push(
      check(
        "[RUNS-P1] Retry(attempt 1 failed -> attempt 2 completed)の前後で、実toRun()を通してもRun.capability(execution binding)とcanonicalCapabilities(communication.read)が変質せず同一に保たれる(retryが新しいCapability/bindingへ黙って変質しない、CAP-P1b/CAP-P1c traceabilityの継続)",
        run1.taskId === run2.taskId &&
          run1.capability === run2.capability &&
          run1.attempt !== run2.attempt &&
          JSON.stringify(run1.canonicalCapabilities) === JSON.stringify(["communication.read"]) &&
          JSON.stringify(run1.canonicalCapabilities) === JSON.stringify(run2.canonicalCapabilities)
      )
    );

  }

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

  // ---- Codexコントラクト由来(codex/runs-p1-contract-tests、
  // 115e9af、"a latest failed Run cannot be masked by a stale
  // successful Run"を移植): findLatestRun()が「attempt番号が最大の
  // Run」を正しく選び、単に「completedなRunが1件でもあるか」を見て
  // いないことの確認——古い(attempt=1)成功と新しい(attempt=2)失敗が
  // 混在する場合、新しい失敗が正となる ----
  results.push(
    check(
      "[Codex由来] 古い成功(attempt=1 completed)と新しい失敗(attempt=2 failed)が混在する場合、最新のfailedがcompletedにmaskされずprojected(failed)になる",
      JSON.stringify(evaluateStrandedTaskProjection("pending", [
        makeRun({ id: "run-1", attempt: 1, status: "completed" }),
        makeRun({ id: "run-2", attempt: 2, status: "failed" }),
      ])) === JSON.stringify({ status: "projected", taskStatus: "failed" })
    )
  );

  // =========================
  // RUNS-P1b: evaluateStrandedTaskProjection()のwaiting_for_retry対応
  // =========================

  // state D(retryable版): Run failed(retryable=true) / Task running ->
  // Task を waiting_for_retry へprojection(既存state Dの"failed"固定
  // ではなく、retryabilityで分岐する)。
  results.push(
    check(
      "[RUNS-P1b state D-retryable] Run failed(retryable=true) / Task running -> projected(waiting_for_retry)",
      JSON.stringify(evaluateStrandedTaskProjection("running", [
        makeRun({ status: "failed", externalRef: { errorCode: "temporary_failure", errorRetryable: true } }),
      ])) === JSON.stringify({ status: "projected", taskStatus: "waiting_for_retry" })
    )
  );

  // 既存state D(non-retryable): externalRef.errorRetryable=falseは
  // 従来通りfailedへprojection(fail safeのデフォルトを明示的に上書き)。
  results.push(
    check(
      "[RUNS-P1b state D-non-retryable] Run failed(retryable=false) / Task running -> projected(failed)",
      JSON.stringify(evaluateStrandedTaskProjection("running", [
        makeRun({ status: "failed", externalRef: { errorCode: "authentication_error", errorRetryable: false } }),
      ])) === JSON.stringify({ status: "projected", taskStatus: "failed" })
    )
  );

  // waiting_for_retryのままRunがrunningになった(retry claimがRun作成後
  // ・Task projection更新前でcrashした場合) -> running へprojection
  // (既存state Bと同じ理由、waiting_for_retry版)。
  results.push(
    check(
      "[RUNS-P1b] Run running / Task waiting_for_retry -> projected(running)(retry claim後のcrash復旧、state Bのwaiting_for_retry版)",
      JSON.stringify(evaluateStrandedTaskProjection("waiting_for_retry", [makeRun({ status: "running" })])) ===
        JSON.stringify({ status: "projected", taskStatus: "running" })
    )
  );

  // Task waiting_for_retry のままRunの実体も一致している(最新Runが
  // 依然retryable failed) -> no_drift(修復不要)。
  results.push(
    check(
      "[RUNS-P1b] Task waiting_for_retry / 最新Runも依然retryable failed -> no_drift(既に正しい状態)",
      evaluateStrandedTaskProjection("waiting_for_retry", [
        makeRun({ status: "failed", externalRef: { errorRetryable: true } }),
      ]).status === "no_drift"
    )
  );

  // Task waiting_for_retryだが、実際には既に別経路でこのRunがcompleted
  // へ確定していた(drift) -> completedへprojection。
  results.push(
    check(
      "[RUNS-P1b] Task waiting_for_retry / 最新Runは実はcompleted(drift) -> projected(completed)",
      JSON.stringify(evaluateStrandedTaskProjection("waiting_for_retry", [makeRun({ status: "completed" })])) ===
        JSON.stringify({ status: "projected", taskStatus: "completed" })
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

  // ---- Codexコントラクト由来(codex/runs-p1-contract-tests、115e9af、
  // "recovered final Task projects to completed and allows Work
  // completion only after all Tasks succeed"を移植・拡張): 上記の
  // makeReconcileDeps()はreconcileWorkCompletionStatus()を呼び出し回数
  // だけ数える簡易fakeだが、この1ブロックだけは本物の
  // core/tact-work/completion.tsのreconcileWorkCompletionStatus()を
  // in-memory sub-depsで包んで実際に接続する(multiTaskWork.test.tsと
  // 同じ「判定ロジック自体は常に本物を通す」方針)。Task B(2 Task中の
  // 最後の1件)がRun1 failed/Run2 completedというretry historyを経て
  // 復旧し、reconcileStrandedTaskProjection()がそれをcompletedへ
  // projectした瞬間、他の全Taskが既にcompletedである場合にのみ
  // Work全体もcompletedへ確定することを、2つの関数を実際に繋いだ状態で
  // 確認する。 ----
  {

    let work: Work = {
      id: "work-1", userId: OWNER_USER_ID, createdByActorKind: "user", createdByActorId: OWNER_USER_ID,
      status: "running", createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z",
    };

    let tasks: WorkTask[] = [
      { id: "task-a", workId: "work-1", description: "task-a", status: "completed", createdAt: "x", updatedAt: "x" } as WorkTask,
      { id: "task-b", workId: "work-1", description: "task-b", status: "pending", createdAt: "x", updatedAt: "x" } as WorkTask,
    ];

    const runsForTaskB: Run[] = [
      makeRun({ id: "run-1", taskId: "task-b", attempt: 1, status: "failed", error: "transient" }),
      makeRun({ id: "run-2", taskId: "task-b", attempt: 2, status: "completed", result: { success: true, output: "recovered" } }),
    ];

    const workStatusUpdates: WorkStatus[] = [];

    const deps: ReconcileStrandedTaskProjectionDeps = {

      getWork: async () => work,

      listTasksForWork: async () => tasks,

      listRunsForTask: async (_workId, _userId, _accessToken, taskId) =>
        taskId === "task-b" ? runsForTaskB : [],

      updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
        tasks = tasks.map((t) => (t.id === taskId ? { ...t, status } : t));
      },

      reconcileWorkCompletionStatus: async (workId, userId, accessToken) =>
        reconcileWorkCompletionStatus(workId, userId, accessToken, {
          getWork: async () => work,
          listTasksForWork: async () => tasks,
          listApprovalsForWork: async () => [],
          updateWorkStatus: async (_wId, _uId, _at, status) => {
            workStatusUpdates.push(status);
            work = { ...work, status };
          },
        }),

    };

    const outcome = await reconcileStrandedTaskProjection("work-1", OWNER_USER_ID, "token", "task-b", deps);

    results.push(
      check(
        "[Codex由来/E2E] retry historyで復旧したTask Bがcompletedへprojectされ、他の全Task(task-a)も既にcompletedである場合に限り、本物のreconcileWorkCompletionStatus()経由でWork全体もcompletedへ確定する(Run1 failedはfailedのまま保持)",
        outcome.status === "projected" &&
          outcome.taskStatus === "completed" &&
          tasks.every((t) => t.status === "completed") &&
          workStatusUpdates.length === 1 &&
          workStatusUpdates[0] === "completed" &&
          work.status === "completed" &&
          runsForTaskB[0].status === "failed" &&
          runsForTaskB[1].status === "completed"
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

// =========================
// evaluateTaskRetryEligibility() (RUNS-P1b)
// =========================

interface MakeRetryEligibilityDepsOptions {
  work?: Work | null;
  tasks?: WorkTask[];
  runs?: Run[];
  now?: Date;
}

function makeRetryEligibilityDeps(options: MakeRetryEligibilityDepsOptions = {}) {

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
        status: "waiting_for_retry",
        assignedCapability: "integration.gmail.search_messages",
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
      } as WorkTask,
    ];

  const runs: Run[] = options.runs ?? [
    makeRun({ status: "failed", externalRef: { errorCode: "temporary_failure", errorRetryable: true } }),
  ];

  const deps: TaskRetryEligibilityDeps = {
    getWork: async () => work,
    listTasksForWork: async () => tasks,
    listRunsForTask: async () => runs,
    now: () => options.now ?? new Date("2026-09-14T00:00:00.000Z"),
  };

  return { deps };

}

async function testRetryEligibility(results: CheckResult[]): Promise<void> {

  const BASE_PARAMS = { workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1" };

  // ---- [1] waiting_for_retry Task、no active Run、最新Runがretryable
  // failed -> eligible(Section12の全条件を満たす基本ケース) ----
  {
    const { deps } = makeRetryEligibilityDeps();
    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[RUNS-P1b retry-eligibility 1] waiting_for_retry + no active Run + latest Run retryable failed -> eligible",
        eligibility.status === "eligible"
      )
    );
  }

  // ---- [2] Task.status !== waiting_for_retry(例: pending) ->
  // blocked(task_not_waiting_for_retry)、resume.tsのApproval/
  // Clarification-driven eligibilityとは別の関数であることの確認 ----
  {
    const { deps } = makeRetryEligibilityDeps({
      tasks: [{ id: "task-1", workId: "work-1", description: "test", status: "pending", createdAt: "x", updatedAt: "x" } as WorkTask],
    });
    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[RUNS-P1b retry-eligibility 2] Task.status='pending'(waiting_for_retryではない) -> blocked(task_not_waiting_for_retry)",
        eligibility.status === "blocked" && eligibility.reasonCode === "task_not_waiting_for_retry"
      )
    );
  }

  // ---- [3] active(running)Runが存在する -> blocked(active_run_exists)、
  // duplicate retry不可 ----
  {
    const { deps } = makeRetryEligibilityDeps({ runs: [makeRun({ status: "running" })] });
    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[RUNS-P1b retry-eligibility 3] active(running)Runが存在する -> blocked(active_run_exists)、同一Task duplicate active Run防止",
        eligibility.status === "blocked" && eligibility.reasonCode === "active_run_exists"
      )
    );
  }

  // ---- [4] 最新Runがfailedではない(例: completed、defense-in-depth:
  // Task.statusだけを信用しない) -> blocked(latest_run_missing_or_not_failed) ----
  {
    const { deps } = makeRetryEligibilityDeps({ runs: [makeRun({ status: "completed" })] });
    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[RUNS-P1b retry-eligibility 4] 最新Runがfailedではない(completed) -> blocked(latest_run_missing_or_not_failed、Task.statusだけを信用しないdefense-in-depth)",
        eligibility.status === "blocked" && eligibility.reasonCode === "latest_run_missing_or_not_failed"
      )
    );
  }

  // ---- [5] Runが1件も無い -> blocked(latest_run_missing_or_not_failed) ----
  {
    const { deps } = makeRetryEligibilityDeps({ runs: [] });
    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[RUNS-P1b retry-eligibility 5] Runが1件も無い -> blocked(latest_run_missing_or_not_failed)",
        eligibility.status === "blocked" && eligibility.reasonCode === "latest_run_missing_or_not_failed"
      )
    );
  }

  // ---- [6] 最新Runはfailedだがretryable=false -> blocked
  // (latest_failure_not_retryable、fail safe: falseをeligibleにしない) ----
  {
    const { deps } = makeRetryEligibilityDeps({
      runs: [makeRun({ status: "failed", externalRef: { errorCode: "authentication_error", errorRetryable: false } })],
    });
    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[RUNS-P1b retry-eligibility 6] 最新Runがfailedだがretryable=false -> blocked(latest_failure_not_retryable)",
        eligibility.status === "blocked" && eligibility.reasonCode === "latest_failure_not_retryable"
      )
    );
  }

  // ---- [7] retryabilityが不明(externalRef無し、RUNS-P1以前のRun相当) ->
  // blocked(latest_failure_not_retryable、fail safe: undefinedをeligibleに
  // しない、trueと明示されている場合のみ許可) ----
  {
    const { deps } = makeRetryEligibilityDeps({
      runs: [makeRun({ status: "failed", externalRef: null })],
    });
    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[RUNS-P1b retry-eligibility 7] retryabilityが不明(externalRef無し) -> blocked(latest_failure_not_retryable、fail safe)",
        eligibility.status === "blocked" && eligibility.reasonCode === "latest_failure_not_retryable"
      )
    );
  }

  // ---- [8/9] Work/Task不明 -> fail closed ----
  {
    const { deps: workNotFoundDeps } = makeRetryEligibilityDeps({ work: null });
    const workNotFound = await evaluateTaskRetryEligibility(BASE_PARAMS, workNotFoundDeps);

    const { deps: taskNotFoundDeps } = makeRetryEligibilityDeps({ tasks: [] });
    const taskNotFound = await evaluateTaskRetryEligibility(BASE_PARAMS, taskNotFoundDeps);

    results.push(
      check(
        "[RUNS-P1b retry-eligibility 8/9] Work不明はblocked(work_not_found)、Task不明はblocked(task_not_found)(fail closed)",
        workNotFound.status === "blocked" && workNotFound.reasonCode === "work_not_found" &&
          taskNotFound.status === "blocked" && taskNotFound.reasonCode === "task_not_found"
      )
    );
  }

  // =========================
  // TIME-P1a: evaluateTaskRetryEligibility()への時間的gate統合
  // =========================

  // ---- [10] Task.nextRetryAtが未来 -> blocked(temporal_gate_not_satisfied)
  // (他の全条件を満たしていても、時間的gateが未成立ならeligibleにならない) ----
  {
    const { deps } = makeRetryEligibilityDeps({
      tasks: [{
        id: "task-1", workId: "work-1", description: "test", status: "waiting_for_retry",
        assignedCapability: "integration.gmail.search_messages",
        nextRetryAt: "2026-09-15T00:00:00.000Z", // now(makeRetryEligibilityDepsの既定)より未来
        createdAt: "x", updatedAt: "x",
      } as WorkTask],
      now: new Date("2026-09-14T00:00:00.000Z"),
    });

    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a retry-eligibility 10] nextRetryAtが未来 -> blocked(temporal_gate_not_satisfied)",
        eligibility.status === "blocked" && eligibility.reasonCode === "temporal_gate_not_satisfied"
      )
    );
  }

  // ---- [11] Task.nextRetryAtが過去 -> 他の条件も満たしていればeligible ----
  {
    const { deps } = makeRetryEligibilityDeps({
      tasks: [{
        id: "task-1", workId: "work-1", description: "test", status: "waiting_for_retry",
        assignedCapability: "integration.gmail.search_messages",
        nextRetryAt: "2026-09-13T00:00:00.000Z", // now(既定2026-09-14)より過去
        createdAt: "x", updatedAt: "x",
      } as WorkTask],
    });

    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a retry-eligibility 11] nextRetryAtが過去 -> 時間的gateは満たされ、他の条件も揃っていればeligible",
        eligibility.status === "eligible"
      )
    );
  }

  // ---- [12] Task.nextRetryAtが未設定(null/undefined) -> Section12の
  // 明示的preferred default(時間による制約なし)によりeligible
  // (既に[1]で暗黙にカバーされているが、明示的に確認する) ----
  {
    const { deps } = makeRetryEligibilityDeps({
      tasks: [{
        id: "task-1", workId: "work-1", description: "test", status: "waiting_for_retry",
        assignedCapability: "integration.gmail.search_messages",
        nextRetryAt: null,
        createdAt: "x", updatedAt: "x",
      } as WorkTask],
    });

    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a retry-eligibility 12] nextRetryAt未設定(null) -> 時間による制約なし、eligible",
        eligibility.status === "eligible"
      )
    );
  }

  // ---- [13] 判定順序: 時間的gateは非時間的条件より後に評価される
  // (retryable=falseかつnextRetryAtが未来の場合、
  // temporal_gate_not_satisfiedではなくlatest_failure_not_retryableが
  // 返る——非時間的な安全条件を時間で覆い隠さない) ----
  {
    const { deps } = makeRetryEligibilityDeps({
      tasks: [{
        id: "task-1", workId: "work-1", description: "test", status: "waiting_for_retry",
        assignedCapability: "integration.gmail.search_messages",
        nextRetryAt: "2026-09-15T00:00:00.000Z", // 未来(時間的gateも未成立)
        createdAt: "x", updatedAt: "x",
      } as WorkTask],
      runs: [makeRun({ status: "failed", externalRef: { errorCode: "authentication_error", errorRetryable: false } })],
      now: new Date("2026-09-14T00:00:00.000Z"),
    });

    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a retry-eligibility 13] 非retryableな失敗は、nextRetryAtが未来でもlatest_failure_not_retryableとして報告される(非時間的な安全条件が時間的gateより先に評価される、判定順序の確認)",
        eligibility.status === "blocked" && eligibility.reasonCode === "latest_failure_not_retryable"
      )
    );
  }

  // ---- TIME-P1a FIX1(Section4、COMBINED TEMPORAL RULE): waitUntilと
  // nextRetryAtの両方が設定されている場合、両方を満たして初めて
  // eligibleになる ----

  // [14] waitUntilは過去(満たされている)だがnextRetryAtが未来 -> blocked
  {
    const { deps } = makeRetryEligibilityDeps({
      tasks: [{
        id: "task-1", workId: "work-1", description: "test", status: "waiting_for_retry",
        assignedCapability: "integration.gmail.search_messages",
        waitUntil: "2026-09-13T00:00:00.000Z", // 過去(満たされている)
        nextRetryAt: "2026-09-15T00:00:00.000Z", // 未来(未成立)
        createdAt: "x", updatedAt: "x",
      } as WorkTask],
      now: new Date("2026-09-14T00:00:00.000Z"),
    });

    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a FIX1 combined-14] waitUntilは満たされているがnextRetryAtが未来 -> blocked(temporal_gate_not_satisfied、片方だけでは不十分)",
        eligibility.status === "blocked" && eligibility.reasonCode === "temporal_gate_not_satisfied"
      )
    );
  }

  // [15] nextRetryAtは過去(満たされている)だがwaitUntilが未来 -> blocked
  {
    const { deps } = makeRetryEligibilityDeps({
      tasks: [{
        id: "task-1", workId: "work-1", description: "test", status: "waiting_for_retry",
        assignedCapability: "integration.gmail.search_messages",
        waitUntil: "2026-09-15T00:00:00.000Z", // 未来(未成立)
        nextRetryAt: "2026-09-13T00:00:00.000Z", // 過去(満たされている)
        createdAt: "x", updatedAt: "x",
      } as WorkTask],
      now: new Date("2026-09-14T00:00:00.000Z"),
    });

    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a FIX1 combined-15] nextRetryAtは満たされているがwaitUntilが未来 -> blocked(temporal_gate_not_satisfied、片方だけでは不十分)",
        eligibility.status === "blocked" && eligibility.reasonCode === "temporal_gate_not_satisfied"
      )
    );
  }

  // [16] 両方とも満たされている -> eligible
  {
    const { deps } = makeRetryEligibilityDeps({
      tasks: [{
        id: "task-1", workId: "work-1", description: "test", status: "waiting_for_retry",
        assignedCapability: "integration.gmail.search_messages",
        waitUntil: "2026-09-13T00:00:00.000Z",
        nextRetryAt: "2026-09-13T12:00:00.000Z",
        createdAt: "x", updatedAt: "x",
      } as WorkTask],
      now: new Date("2026-09-14T00:00:00.000Z"),
    });

    const eligibility = await evaluateTaskRetryEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a FIX1 combined-16] waitUntil/nextRetryAtの両方が満たされている -> eligible",
        eligibility.status === "eligible"
      )
    );
  }

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  testPureFunctions(results);
  await testReconcileStrandedTaskProjection(results);
  await testPrepareRunForExecution(results);
  await testRetryEligibility(results);

  return summarize("work/taskRunReconciliation", results);

}
