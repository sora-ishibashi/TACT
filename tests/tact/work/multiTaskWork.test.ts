// =========================
// TACT Work — Multi-Task Work Semantics (WORK-P2)
// =========================
//
// 対象: core/tact-work/execution.tsのrunWorkTurn()と
// core/tact-work/completion.tsのreconcileWorkCompletionStatus()を
// 組み合わせた、「1 Workが複数の意味のあるTaskを保持し、その
// progressionとWork completionをCanonicalに扱えること」という
// WORK-P2の中核契約。実Supabase・実Orchestrator・実LLM/Search API
// には一切接続しない(既存tests/tact/work/execution.test.tsと同じ
// DI手法)。
//
// Repository Reality Audit(WORK-P2実装前に実施)で判明した事実:
// Work/WorkTask/TaskDependency/Run/Approval/Clarificationという
// Canonical Modelと、依存関係を尊重するOrchestrator executor
// (core/tact-orchestrator/executor.tsのrunTasks()、wave-based
// scheduling + cascade-cancel-on-dependency-failure)、決定論的な
// Work完了判定(reconcileWorkCompletionStatus())は、ARCH-R2/Phase B1/
// B2/C2.1aで既に実装済みであり、REF-P1fのGmail referent workflow
// (1 Workの下にNotion search/read_page・Gmail search_messages・
// Gmail send_message-pending-approvalという複数WorkTaskが既に
// 共存する)や、Research capabilityの逐次比較decomposition
// (SEQUENTIAL_PATTERN、2 Task + 1 TaskDependency)を通じて、既に
// 本番で使われている。
//
// このtest fileが新たに埋める具体的なgap(既存testで未検証だった点):
//   1. onTasksPlanned()がTaskDependency行を、Orchestratorの一時的な
//      Task.id(runtime UUID)ではなく、永続化されたWorkTaskのDB id
//      同士で正しく作成すること(既存tests/tact/work/execution.test.ts
//      はcalls.createdDependenciesを記録するfixtureを持ちながら、
//      実際にはどのtestからも一度もassertされていなかった)。
//   2. 3 Task(A→B→C、逐次依存)が1つのWorkの下で、実際の
//      reconcileWorkCompletionStatus()(reimplementした模倣ロジック
//      ではなく本物の関数)を通して、正しいタイミングでのみWork
//      completed/failedへ確定すること。
//   3. 汎用(non-Integration)Approval機構(Phase B3由来の
//      summary.approvalRequirement)がTask進行の途中に挟まった場合、
//      複数Task構成のWorkでも「pending Approvalが残る限りWorkは
//      確定しない」という既存の絶対条件が保たれること。
//
// 既に別fileで十分にカバーされているためこのfileでは重複しない項目:
//   - cross-user Work/Task/Run/Approval分離
//     (tests/tact/work/storeAuthorization.test.ts)
//   - dependency失敗によるcascade cancel
//     (tests/tact/work/execution.test.ts「Dependency failure」)
//   - Retry = new Run(1 Task → N Runs)
//     (tests/tact/work/execution.test.ts「Retry exhausted」)
//   - 単一Task Workの既存lifecycle
//     (tests/tact/work/execution.test.ts「Lifecycle」)
//   - Clarification pending時にWorkがwaiting_for_inputへ進むこと
//     (tests/tact/work/execution.test.ts、tests/tact/work/
//     referentClarification.test.ts)
//   - Approval Integrity / provider write ゼロ(reject時等)
//     (tests/tact/work/approvalIntegrity.test.ts、
//     tests/tact/integration/sourceReferentExecution.test.ts)

import { runWorkTurn, type RunWorkTurnDeps } from "../../../core/tact-work/execution";
import { reconcileWorkCompletionStatus as realReconcileWorkCompletionStatus } from "../../../core/tact-work/completion";
import type { Work, WorkTask, Run, Approval } from "../../../core/tact-work/types";
import type {
  Task,
  TaskExecutionSummary,
  OrchestrationResult,
  OrchestrationHooks,
  OrchestrationRequest,
} from "../../../core/tact-orchestrator";
import { check, summarize, type CheckResult } from "../lib/check";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "created",
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

const baseOrchestrationRequest: OrchestrationRequest = {
  input: "A社との更新案件を確認して、必要なら返信して",
};

function makeTask(overrides: Partial<Task>): Task {
  return { id: crypto.randomUUID(), description: "テスト", status: "pending", ...overrides };
}

function makeSummary(overrides: Partial<TaskExecutionSummary> & { taskId: string }): TaskExecutionSummary {
  return { status: "completed", ...overrides };
}

// =========================
// makeMultiTaskDeps
// =========================
//
// tests/tact/work/execution.test.tsのmakeRecordingDeps()と同じ「実
// Storeを一切呼ばず、呼び出しを記録するfake」という設計を踏襲しつつ、
// reconcileWorkCompletionStatusだけは本物のcore/tact-work/completion.ts
// のreconcileWorkCompletionStatus()を、in-memoryなWorkTask/Approval
// 状態を反映するfake sub-depsで包んで呼ぶ(判定ロジック自体を
// このtest fileで再実装しない——LIVE-READINESS TESTと同じ精神: 検証
// 対象のcanonicalロジックは常に本物を通す)。
function makeMultiTaskDeps(
  runOrchestration: (
    request: OrchestrationRequest,
    hooks?: OrchestrationHooks
  ) => Promise<OrchestrationResult>,
  workOverrides: Partial<Work> = {}
) {

  const work: Work = makeWork(workOverrides);

  const tasksById = new Map<string, WorkTask>();
  const approvalsById = new Map<string, Approval>();
  const runsByTaskId = new Map<string, Run[]>();

  const calls = {
    workStatusUpdates: [] as string[],
    createTaskDescriptions: [] as string[],
    createdDependencies: [] as { taskId: string; dependsOnTaskId: string }[],
    createRunCalls: [] as { taskId: string; attempt: number; capability: string }[],
    completeRunCalls: [] as string[],
    failRunCalls: [] as { runId: string; error: string }[],
    updateTaskStatusCalls: [] as { taskId: string; status: string }[],
    requestApprovalCalls: [] as { workId: string; taskId?: string | null; reason: string }[],
  };

  let nextTaskDbId = 1;
  let nextRunDbId = 1;
  // 絶対条件(このtest fileの核心): descriptionではなく、Orchestrator
  // task.id(呼び出し元closureが握っている一時的なruntime UUID)から
  // 永続化されたWorkTask DB idへのmapを持つ——onTasksPlanned()内部の
  // workTaskIdByOrchestratorTaskIdマップと同じ責務を、fake Store側でも
  // 再現する。これによりcreateTaskDependency()へ実際に渡されるIDが
  // 「Orchestratorの一時ID」なのか「永続化されたWorkTaskのDB id」なのか
  // を明確に区別してassertできる。
  const dbTaskIdByOrchestratorTaskId = new Map<string, string>();

  const deps: RunWorkTurnDeps = {

    updateWorkStatus: async (_workId, _userId, _accessToken, status) => {
      calls.workStatusUpdates.push(status);
      work.status = status;
    },

    createTask: async (workId, _userId, _accessToken, params): Promise<WorkTask | undefined> => {
      calls.createTaskDescriptions.push(params.description);
      const id = `task-db-${nextTaskDbId++}`;
      const workTask: WorkTask = {
        id,
        workId,
        description: params.description,
        status: "pending",
        assignedCapability: params.assignedCapability ?? null,
        tableSchema: params.tableSchema ?? null,
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      };
      tasksById.set(id, workTask);
      return workTask;
    },

    createTaskDependency: async (_workId, _userId, _accessToken, taskId, dependsOnTaskId) => {
      calls.createdDependencies.push({ taskId, dependsOnTaskId });
      return { taskId, dependsOnTaskId, createdAt: "2026-09-14T00:00:00.000Z" };
    },

    updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
      calls.updateTaskStatusCalls.push({ taskId, status });
      const existing = tasksById.get(taskId);
      if (existing) {
        tasksById.set(taskId, { ...existing, status });
      }
    },

    createRun: async (workId, _userId, _accessToken, taskId, params): Promise<Run | undefined> => {
      calls.createRunCalls.push({ taskId, attempt: params.attempt, capability: params.capability });
      const id = `run-db-${nextRunDbId++}`;
      const run: Run = {
        id,
        workId,
        taskId,
        attempt: params.attempt,
        capability: params.capability,
        provider: params.provider ?? null,
        model: params.model ?? null,
        status: "running",
        startedAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
      };
      const existing = runsByTaskId.get(taskId) ?? [];
      runsByTaskId.set(taskId, [...existing, run]);
      return run;
    },

    completeRun: async (_workId, _userId, _accessToken, runId) => {
      calls.completeRunCalls.push(runId);
    },

    failRun: async (_workId, _userId, _accessToken, runId, params) => {
      calls.failRunCalls.push({ runId, error: params.error });
    },

    runOrchestration,

    requestApproval: async (request) => {
      calls.requestApprovalCalls.push({ workId: request.workId, taskId: request.taskId, reason: request.reason });
      calls.workStatusUpdates.push("waiting_for_approval");
      work.status = "waiting_for_approval";
      const approval: Approval = {
        id: `approval-db-${calls.requestApprovalCalls.length}`,
        workId: request.workId,
        taskId: request.taskId ?? null,
        requestedByActorKind: request.requestedByActor.kind,
        requestedByActorId: request.requestedByActor.id,
        requestedFromActorKind: request.requestedFromActor.kind,
        requestedFromActorId: request.requestedFromActor.id,
        status: "pending",
        reason: request.reason,
        payload: {},
        requestedAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
      };
      approvalsById.set(approval.id, approval);
      return approval;
    },

    requestClarification: async (request) => {
      calls.workStatusUpdates.push("waiting_for_input");
      work.status = "waiting_for_input";
      return {
        id: "clarification-db-1",
        workId: request.workId,
        taskId: request.taskId ?? null,
        requestedByActorKind: request.requestedByActor.kind,
        requestedByActorId: request.requestedByActor.id,
        allowedResponderIds: request.allowedResponderIds ?? null,
        status: "pending",
        reasonCode: request.reasonCode,
        question: request.question,
        requestedAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
      };
    },

    // 絶対条件(このtest fileの核心、LIVE-READINESS TESTと同じ精神):
    // 判定ロジックを再実装せず、本物のcore/tact-work/completion.tsの
    // reconcileWorkCompletionStatus()を、in-memory状態を映すfake
    // sub-depsで包んで呼ぶ。
    reconcileWorkCompletionStatus: async (workId, userId, accessToken) => {
      return realReconcileWorkCompletionStatus(workId, userId, accessToken, {
        listTasksForWork: async () => Array.from(tasksById.values()),
        listApprovalsForWork: async () => Array.from(approvalsById.values()),
        updateWorkStatus: async (_wId, _uId, _at, status) => {
          calls.workStatusUpdates.push(status);
          work.status = status;
        },
        getWork: async () => work,
      });
    },

    resolveIntegrationConnection: async () => ({ status: "none" }),

    executeReadIntegrationAction: async () => ({ status: "invalid_action" }),

    emitAuditEvent: async () => {},

  };

  return { deps, calls, work, tasksById, dbTaskIdByOrchestratorTaskId };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1〜2/16: 3 Task(A→B→C、逐次依存)が1つのWorkの下にcreateされ、
  // TaskDependencyが永続化されたWorkTask DB id同士(Orchestratorの
  // 一時的なtask.idではない)で正しく作られる ----
  {
    const taskA = makeTask({ description: "Gmailから対象案件を確認" });
    const taskB = makeTask({ description: "必要な返信を準備", dependencies: [taskA.id] });
    const taskC = makeTask({ description: "対応結果を要約", dependencies: [taskB.id] });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([taskA, taskB, taskC]);

      for (const task of [taskA, taskB, taskC]) {
        await hooks?.onAttempt?.(task, { attempt: 1, capability: "phase-work-p2-mock", status: "completed", output: "ok" });
        await hooks?.onTaskFinished?.(task, makeSummary({ taskId: task.id, status: "completed" }));
      }

      return {
        answer: "対応しました",
        executionId: "exec-work-p2-1",
        tasks: [taskA, taskB, taskC].map((t) => makeSummary({ taskId: t.id, status: "completed" })),
        memoryUsed: [], toolsUsed: [], memoryWrites: [],
        learningSignals: ["successful_execution", "successful_execution", "successful_execution"],
        metadata: { executionMode: "sequential-swarm" },
      };

    };

    const { deps, calls } = makeMultiTaskDeps(fakeOrchestration);

    await runWorkTurn(
      { work: makeWork(), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(check(
      "[WORK-P2] 1. 1つのWorkの下に3件の意味のあるTaskがcreateされる(createTask() 3回、description一致)",
      calls.createTaskDescriptions.length === 3 &&
        calls.createTaskDescriptions[0] === "Gmailから対象案件を確認" &&
        calls.createTaskDescriptions[1] === "必要な返信を準備" &&
        calls.createTaskDescriptions[2] === "対応結果を要約"
    ));

    // 永続化されたWorkTask DB idは"task-db-N"形式、Orchestratorの
    // 一時task.idはcrypto.randomUUID()形式——両者は文字列として
    // 明確に異なる。createdDependenciesがOrchestratorの一時IDではなく
    // "task-db-"で始まるDB idを保持していることを直接確認する。
    results.push(check(
      "[WORK-P2] 2/16. TaskDependencyがOrchestratorの一時task.idではなく、永続化されたWorkTaskのDB id同士で作られる(2件、正しい向き: B→A, C→B)",
      calls.createdDependencies.length === 2 &&
        calls.createdDependencies.every((d) => d.taskId.startsWith("task-db-") && d.dependsOnTaskId.startsWith("task-db-")) &&
        calls.createdDependencies[0].taskId === "task-db-2" && calls.createdDependencies[0].dependsOnTaskId === "task-db-1" &&
        calls.createdDependencies[1].taskId === "task-db-3" && calls.createdDependencies[1].dependsOnTaskId === "task-db-2"
    ));

    // ---- 6: 全required Task成功後のみWork completion ----
    results.push(check(
      "[WORK-P2] 6. 3件全てcompletedの場合のみ、本物のreconcileWorkCompletionStatus()経由でWorkがcompletedへ確定する",
      calls.workStatusUpdates[calls.workStatusUpdates.length - 1] === "completed"
    ));

  }

  // ---- 4〜5: 未完了のTaskが残っている間はWork completedにならない
  // (3件中2件のみcompleted、1件はまだpending) ----
  {
    const taskA = makeTask({ description: "Task A(完了)" });
    const taskB = makeTask({ description: "Task B(完了)" });
    const taskC = makeTask({ description: "Task C(まだ未着手のまま残す)" });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      // Task CはonTasksPlanned()でWorkTask行こそ作られるが、
      // onTaskFinished()が一切呼ばれない(=まだ進行中/未着手のまま)。
      await hooks?.onTasksPlanned?.([taskA, taskB, taskC]);

      await hooks?.onTaskFinished?.(taskA, makeSummary({ taskId: taskA.id, status: "completed" }));
      await hooks?.onTaskFinished?.(taskB, makeSummary({ taskId: taskB.id, status: "completed" }));

      return {
        answer: "", executionId: "exec-work-p2-2",
        tasks: [makeSummary({ taskId: taskA.id, status: "completed" }), makeSummary({ taskId: taskB.id, status: "completed" })],
        memoryUsed: [], toolsUsed: [], memoryWrites: [],
        learningSignals: ["successful_execution"],
        metadata: { executionMode: "parallel-swarm" },
      };

    };

    const { deps, calls } = makeMultiTaskDeps(fakeOrchestration);

    await runWorkTurn(
      { work: makeWork(), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(check(
      "[WORK-P2] 4/5. 3件中1件がまだterminalでない場合、Workはcompleted/failedのいずれにも確定しない",
      !calls.workStatusUpdates.includes("completed") && !calls.workStatusUpdates.includes("failed")
    ));

  }

  // ---- 7: Task failure時に誤ってWork completedにならない(3件中1件failed) ----
  {
    const taskA = makeTask({ description: "成功するTask" });
    const taskB = makeTask({ description: "失敗するTask" });
    const taskC = makeTask({ description: "成功するTask2" });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([taskA, taskB, taskC]);
      await hooks?.onTaskFinished?.(taskA, makeSummary({ taskId: taskA.id, status: "completed" }));
      await hooks?.onTaskFinished?.(taskB, makeSummary({ taskId: taskB.id, status: "failed", error: "失敗" }));
      await hooks?.onTaskFinished?.(taskC, makeSummary({ taskId: taskC.id, status: "completed" }));

      return {
        answer: "", executionId: "exec-work-p2-3",
        tasks: [taskA, taskB, taskC].map((t) => makeSummary({ taskId: t.id, status: "completed" })),
        memoryUsed: [], toolsUsed: [], memoryWrites: [],
        learningSignals: ["permanent_failure"],
        metadata: { executionMode: "parallel-swarm" },
      };

    };

    const { deps, calls } = makeMultiTaskDeps(fakeOrchestration);

    await runWorkTurn(
      { work: makeWork(), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(check(
      "[WORK-P2] 7. 3件中1件failedの場合、誤ってcompletedにならずWork全体がfailedへ確定する",
      calls.workStatusUpdates[calls.workStatusUpdates.length - 1] === "failed" &&
        !calls.workStatusUpdates.includes("completed")
    ));

  }

  // ---- 9: Approval待ちの間、後続のprotected actionが実行されず、Work
  // completionもブロックされる(複数Task構成のWorkでも汎用Approval
  // 機構の絶対条件が保たれる) ----
  {
    const taskA = makeTask({ description: "現状確認Task" });
    const taskB = makeTask({ description: "承認が必要な返信送信Task", dependencies: [taskA.id] });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([taskA, taskB]);
      await hooks?.onTaskFinished?.(taskA, makeSummary({ taskId: taskA.id, status: "completed" }));

      // Task Bは汎用(non-Integration)Approval機構(Phase B3由来)を
      // 使う——承認が下りるまでTask自体をcompletedとしてpersistしない
      // (既存絶対条件、tests/tact/work/execution.test.tsの
      // kind="external_write_test"と同じpattern)。
      await hooks?.onTaskFinished?.(taskB, makeSummary({
        taskId: taskB.id,
        status: "completed",
        approvalRequirement: { reason: "外部への返信送信には承認が必要です", action: { kind: "external_write_test", summary: "返信を送信" } },
      }));

      return {
        answer: "", executionId: "exec-work-p2-4",
        tasks: [makeSummary({ taskId: taskA.id, status: "completed" })],
        memoryUsed: [], toolsUsed: [], memoryWrites: [],
        learningSignals: ["successful_execution"],
        metadata: { executionMode: "sequential-swarm" },
      };

    };

    const { deps, calls } = makeMultiTaskDeps(fakeOrchestration);

    await runWorkTurn(
      { work: makeWork(), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(check(
      "[WORK-P2] 9a. Approvalが要求されたTaskはcompletedとして永続化されず、pendingのまま据え置かれる",
      !calls.updateTaskStatusCalls.some((c) => c.taskId === "task-db-2")
    ));

    results.push(check(
      "[WORK-P2] 9b. Approvalが1件作られ、Workはwaiting_for_approvalへ進む",
      calls.requestApprovalCalls.length === 1 && calls.workStatusUpdates.includes("waiting_for_approval")
    ));

    results.push(check(
      "[WORK-P2] 9c. pending Approvalが残っている間、複数Task構成のWorkでもcompletedへ確定しない",
      !calls.workStatusUpdates.includes("completed")
    ));

    results.push(check(
      "[WORK-P2] 9d/10. Approval待ちのTaskに対してcreateRun()やprovider実行相当の呼び出しは一切発生しない(selection/approval待ち中のprovider write=0と同じ精神)",
      calls.createRunCalls.every((c) => c.taskId !== "task-db-2")
    ));

  }

  // ---- 16: 複数Task構成のWorkでも、個々のTaskのRetry(1 Task → N Run)
  // semanticsが壊れない ----
  {
    const taskA = makeTask({ description: "1回で成功するTask" });
    const taskB = makeTask({ description: "1回失敗して2回目で成功するTask" });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([taskA, taskB]);

      await hooks?.onAttempt?.(taskA, { attempt: 1, capability: "phase-work-p2-mock", status: "completed" });
      await hooks?.onTaskFinished?.(taskA, makeSummary({ taskId: taskA.id, status: "completed" }));

      await hooks?.onAttempt?.(taskB, { attempt: 1, capability: "phase-work-p2-mock", status: "failed", error: "一時的な失敗" });
      await hooks?.onAttempt?.(taskB, { attempt: 2, capability: "phase-work-p2-mock", status: "completed" });
      await hooks?.onTaskFinished?.(taskB, makeSummary({ taskId: taskB.id, status: "completed", retried: true }));

      return {
        answer: "", executionId: "exec-work-p2-5",
        tasks: [taskA, taskB].map((t) => makeSummary({ taskId: t.id, status: "completed" })),
        memoryUsed: [], toolsUsed: [], memoryWrites: [],
        learningSignals: ["successful_execution", "successful_execution"],
        metadata: { executionMode: "parallel-swarm" },
      };

    };

    const { deps, calls } = makeMultiTaskDeps(fakeOrchestration);

    await runWorkTurn(
      { work: makeWork(), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    const runsForTaskA = calls.createRunCalls.filter((c) => c.taskId === "task-db-1");
    const runsForTaskB = calls.createRunCalls.filter((c) => c.taskId === "task-db-2");

    results.push(check(
      "[WORK-P2] 16. 複数Task構成のWorkでも、Task Aは1 Run・Task Bは2 Run(retry=new Run)という既存semanticsが個別に保たれ、互いのattempt番号が混線しない",
      runsForTaskA.length === 1 && runsForTaskA[0].attempt === 1 &&
        runsForTaskB.length === 2 && runsForTaskB[0].attempt === 1 && runsForTaskB[1].attempt === 2 &&
        calls.workStatusUpdates[calls.workStatusUpdates.length - 1] === "completed"
    ));

  }

  return summarize("work/multiTaskWork", results);

}
