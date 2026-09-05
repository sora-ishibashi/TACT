// =========================
// TACT Work — Work Execution Boundary Regression
// (Architecture Migration Phase B2)
// =========================
//
// 対象: core/tact-work/execution.tsのrunWorkTurn()。実Supabase・実
// Orchestrator・実LLM/Search APIには一切接続しない
// (RunWorkTurnDeps経由でStore呼び出し・runOrchestration()自体を
// 偽実装に差し替える)。
//
// 偽実装のrunOrchestration()は、実際のcore/tact-orchestrator/
// commander.tsが行うのと同じ順序でhooksを呼ぶ(onTasksPlanned →
// onAttempt(×N) → onTaskFinished)——これにより、runWorkTurn()自身の
// 「hooksをどうStoreへ翻訳するか」というロジックだけを、Orchestrator
// 本体を一切動かさずに検証できる。

import { runWorkTurn, type RunWorkTurnDeps } from "../../../core/tact-work/execution";
import type { Work, Run, WorkTask } from "../../../core/tact-work/types";
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
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

const baseOrchestrationRequest: OrchestrationRequest = {
  input: "テスト依頼",
};

// テストごとに呼び出しを記録する、最小限のfake Store実装を作る。
function makeRecordingDeps(
  runOrchestration: (
    request: OrchestrationRequest,
    hooks?: OrchestrationHooks
  ) => Promise<OrchestrationResult>
) {

  const calls: {
    workStatusUpdates: string[];
    createTaskDescriptions: string[];
    createdDependencies: { taskId: string; dependsOnTaskId: string }[];
    createRunCalls: { taskId: string; attempt: number; capability: string }[];
    completeRunCalls: string[];
    failRunCalls: { runId: string; error: string }[];
    updateTaskStatusCalls: { taskId: string; status: string }[];
  } = {
    workStatusUpdates: [],
    createTaskDescriptions: [],
    createdDependencies: [],
    createRunCalls: [],
    completeRunCalls: [],
    failRunCalls: [],
    updateTaskStatusCalls: [],
  };

  let nextTaskDbId = 1;
  let nextRunDbId = 1;
  const taskDbIdByDescription = new Map<string, string>();

  const deps: RunWorkTurnDeps = {

    updateWorkStatus: async (_workId, _userId, _accessToken, status) => {
      calls.workStatusUpdates.push(status);
    },

    createTask: async (_workId, _userId, _accessToken, params): Promise<WorkTask | undefined> => {
      calls.createTaskDescriptions.push(params.description);
      const id = `task-db-${nextTaskDbId++}`;
      taskDbIdByDescription.set(params.description, id);
      return {
        id,
        workId: "work-1",
        description: params.description,
        status: "pending",
        assignedCapability: params.assignedCapability ?? null,
        tableSchema: params.tableSchema ?? null,
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
      };
    },

    createTaskDependency: async (_workId, _userId, _accessToken, taskId, dependsOnTaskId) => {
      calls.createdDependencies.push({ taskId, dependsOnTaskId });
      return { taskId, dependsOnTaskId, createdAt: "2026-09-06T00:00:00.000Z" };
    },

    updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
      calls.updateTaskStatusCalls.push({ taskId, status });
    },

    createRun: async (_workId, _userId, _accessToken, taskId, params): Promise<Run | undefined> => {
      calls.createRunCalls.push({ taskId, attempt: params.attempt, capability: params.capability });
      const id = `run-db-${nextRunDbId++}`;
      return {
        id,
        workId: "work-1",
        taskId,
        attempt: params.attempt,
        capability: params.capability,
        provider: params.provider ?? null,
        model: params.model ?? null,
        status: "running",
        startedAt: "2026-09-06T00:00:00.000Z",
        createdAt: "2026-09-06T00:00:00.000Z",
      };
    },

    completeRun: async (_workId, _userId, _accessToken, runId) => {
      calls.completeRunCalls.push(runId);
    },

    failRun: async (_workId, _userId, _accessToken, runId, params) => {
      calls.failRunCalls.push({ runId, error: params.error });
    },

    runOrchestration,

  };

  return { deps, calls, taskDbIdByDescription };

}

function makeTask(overrides: Partial<Task>): Task {
  return { id: crypto.randomUUID(), description: "テスト", status: "pending", ...overrides };
}

function makeSummary(overrides: Partial<TaskExecutionSummary> & { taskId: string }): TaskExecutionSummary {
  return { status: "completed", ...overrides };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Lifecycle: created -> planning -> running -> completed
  // (単一Task・単一attempt・成功) ----
  {
    const task = makeTask({ description: "SROIについて調べる", assignedCapability: "research" });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([task]);

      await hooks?.onAttempt?.(task, {
        attempt: 1,
        capability: "research",
        provider: "openai",
        model: "gpt-4o-mini",
        status: "completed",
        output: "回答",
        result: { success: true, output: "回答" },
      });

      const summary = makeSummary({ taskId: task.id, status: "completed", output: "回答" });

      await hooks?.onTaskFinished?.(task, summary);

      return {
        answer: "回答",
        executionId: "exec-1",
        tasks: [summary],
        memoryUsed: [],
        toolsUsed: [],
        memoryWrites: [],
        learningSignals: ["successful_execution"],
        metadata: { executionMode: "single-execution" },
      };

    };

    const { deps, calls } = makeRecordingDeps(fakeOrchestration);

    const result = await runWorkTurn(
      { work: makeWork({ status: "created" }), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(
      check(
        "[Lifecycle] created -> planning -> running -> completedの順でWork statusが遷移する",
        calls.workStatusUpdates.join(",") === "planning,running,completed"
      )
    );

    results.push(
      check(
        "[Persistence] Orchestrator TaskがcreateTask()で永続化される(description一致)",
        calls.createTaskDescriptions.length === 1 &&
          calls.createTaskDescriptions[0] === "SROIについて調べる"
      )
    );

    results.push(
      check(
        "[Persistence] Capability attemptがcreateRun()で永続化される(capability/attempt一致)",
        calls.createRunCalls.length === 1 &&
          calls.createRunCalls[0].capability === "research" &&
          calls.createRunCalls[0].attempt === 1
      )
    );

    results.push(
      check(
        "[Persistence] 成功attemptはcompleteRun()を呼び、failRun()は呼ばない",
        calls.completeRunCalls.length === 1 && calls.failRunCalls.length === 0
      )
    );

    results.push(
      check(
        "[Persistence] Task最終状態(completed)がupdateTaskStatus()へ反映される",
        calls.updateTaskStatusCalls.length === 1 &&
          calls.updateTaskStatusCalls[0].status === "completed"
      )
    );

    results.push(
      check(
        "[Response compatibility] runWorkTurn()はOrchestrationResultをそのまま返す(既存Conversation層のresponse生成は無変更)",
        result.answer === "回答" && result.tasks.length === 1
      )
    );
  }

  // ---- Retry: 同一Taskに複数Run(1回目失敗・2回目成功) ----
  {
    const task = makeTask({ description: "一時的に失敗するTask", assignedCapability: "phase-b2-mock" });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([task]);

      await hooks?.onAttempt?.(task, {
        attempt: 1,
        capability: "phase-b2-mock",
        status: "failed",
        error: "temporary failure",
      });

      await hooks?.onAttempt?.(task, {
        attempt: 2,
        capability: "phase-b2-mock",
        status: "completed",
        output: "retry後に成功",
      });

      const summary = makeSummary({
        taskId: task.id,
        status: "completed",
        output: "retry後に成功",
        retried: true,
      });

      await hooks?.onTaskFinished?.(task, summary);

      return {
        answer: "retry後に成功",
        executionId: "exec-2",
        tasks: [summary],
        memoryUsed: [],
        toolsUsed: [],
        memoryWrites: [],
        learningSignals: ["successful_execution"],
        metadata: { executionMode: "single-execution" },
      };

    };

    const { deps, calls } = makeRecordingDeps(fakeOrchestration);

    await runWorkTurn(
      { work: makeWork(), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(
      check(
        "[Retry] 同一Taskに対しattempt=1・attempt=2の2件のRunが作られる",
        calls.createRunCalls.length === 2 &&
          calls.createRunCalls[0].attempt === 1 &&
          calls.createRunCalls[1].attempt === 2
      )
    );

    results.push(
      check(
        "[Retry] attempt=1はfailRun()、attempt=2はcompleteRun()が呼ばれる(Run#1 failed, Run#2 completed)",
        calls.failRunCalls.length === 1 && calls.completeRunCalls.length === 1
      )
    );

    results.push(
      check(
        "[Retry] 最終的にTaskはcompletedとして記録される",
        calls.updateTaskStatusCalls[calls.updateTaskStatusCalls.length - 1]?.status === "completed"
      )
    );
  }

  // ---- Retry exhausted: 2回とも失敗 -> Task failed ----
  {
    const task = makeTask({ description: "2回とも失敗するTask", assignedCapability: "phase-b2-mock" });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([task]);
      await hooks?.onAttempt?.(task, { attempt: 1, capability: "phase-b2-mock", status: "failed", error: "1回目失敗" });
      await hooks?.onAttempt?.(task, { attempt: 2, capability: "phase-b2-mock", status: "failed", error: "2回目も失敗" });

      const summary = makeSummary({ taskId: task.id, status: "failed", error: "2回目も失敗" });

      await hooks?.onTaskFinished?.(task, summary);

      return {
        answer: "",
        executionId: "exec-3",
        tasks: [summary],
        memoryUsed: [],
        toolsUsed: [],
        memoryWrites: [],
        learningSignals: ["permanent_failure"],
        metadata: { executionMode: "single-execution" },
      };

    };

    const { deps, calls } = makeRecordingDeps(fakeOrchestration);

    const result = await runWorkTurn(
      { work: makeWork(), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(
      check(
        "[Retry exhausted] 2回とも failRun()が呼ばれる(completeRun()は呼ばれない)",
        calls.failRunCalls.length === 2 && calls.completeRunCalls.length === 0
      )
    );

    results.push(
      check(
        "[Retry exhausted] Task最終状態はfailed",
        calls.updateTaskStatusCalls[calls.updateTaskStatusCalls.length - 1]?.status === "failed"
      )
    );

    results.push(
      check(
        "[Retry exhausted] Work全体もfailedになる(不可逆な失敗)",
        calls.workStatusUpdates[calls.workStatusUpdates.length - 1] === "failed"
      )
    );

    results.push(
      check(
        "[Retry exhausted] runOrchestration()自体は例外を投げず、OrchestrationResultをそのまま返す",
        result.tasks[0]?.status === "failed"
      )
    );
  }

  // ---- Dependency failure: 依存Task失敗 -> Task cancelled、Run無し ----
  {
    const taskA = makeTask({ description: "先に失敗するTask", assignedCapability: "phase-b2-mock" });
    const taskB = makeTask({ description: "依存先が失敗したため実行されないTask", assignedCapability: "phase-b2-mock", dependencies: [taskA.id] });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([taskA, taskB]);

      await hooks?.onAttempt?.(taskA, { attempt: 1, capability: "phase-b2-mock", status: "failed", error: "failed" });
      const summaryA = makeSummary({ taskId: taskA.id, status: "failed", error: "failed" });
      await hooks?.onTaskFinished?.(taskA, summaryA);

      // taskBはonAttempt()を一切呼ばれず(Runを作らない)、直接cancelled
      // として確定する(既存executor.ts/runTasks()の絶対条件17と同じ)。
      const summaryB = makeSummary({ taskId: taskB.id, status: "cancelled", error: "dependency task did not complete successfully" });
      await hooks?.onTaskFinished?.(taskB, summaryB);

      return {
        answer: "",
        executionId: "exec-4",
        tasks: [summaryA, summaryB],
        memoryUsed: [],
        toolsUsed: [],
        memoryWrites: [],
        learningSignals: ["permanent_failure", "permanent_failure"],
        metadata: { executionMode: "sequential-swarm" },
      };

    };

    const { deps, calls } = makeRecordingDeps(fakeOrchestration);

    await runWorkTurn(
      { work: makeWork(), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(
      check(
        "[Dependency failure] 依存先が失敗したTaskはcreateRun()が一切呼ばれない(絶対条件: cancelledはRunを作らない)",
        calls.createRunCalls.length === 1 && calls.createRunCalls[0].taskId !== undefined
      )
    );

    results.push(
      check(
        "[Dependency failure] cancelledなTaskもupdateTaskStatus(cancelled)として記録される",
        calls.updateTaskStatusCalls.some((c) => c.status === "cancelled")
      )
    );
  }

  // ---- Clarification: Work waiting_for_input(onTasksPlanned自体が
  // 呼ばれない、既存Clarification subsystemは変更していない) ----
  {
    const fakeOrchestration = async (): Promise<OrchestrationResult> => {

      return {
        answer: "どちらのSROIについて調べますか？",
        executionId: "exec-5",
        tasks: [],
        memoryUsed: [],
        toolsUsed: [],
        memoryWrites: [],
        learningSignals: ["clarification_required"],
        clarification: { question: "どちらのSROIについて調べますか？" },
        metadata: { executionMode: "clarification-needed" },
      };

    };

    const { deps, calls } = makeRecordingDeps(fakeOrchestration);

    const result = await runWorkTurn(
      { work: makeWork({ status: "created" }), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(
      check(
        "[Clarification] Task計画自体が行われないため、'running'へは進まずcreated->planning->waiting_for_inputになる",
        calls.workStatusUpdates.join(",") === "planning,waiting_for_input"
      )
    );

    results.push(
      check(
        "[Clarification] createTask()/createRun()は一切呼ばれない(実行コストが発生しない)",
        calls.createTaskDescriptions.length === 0 && calls.createRunCalls.length === 0
      )
    );

    results.push(
      check(
        "[Clarification] OrchestrationResult.clarificationがそのまま呼び出し元(既存Conversation層)へ返る",
        result.clarification?.question === "どちらのSROIについて調べますか？"
      )
    );
  }

  // ---- Work resumed from waiting_for_input: 回答後、次のTurnで
  // onTasksPlanned()が呼ばれれば'running'へ戻る ----
  {
    const task = makeTask({ description: "回答を踏まえた再実行", assignedCapability: "research" });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([task]);
      await hooks?.onAttempt?.(task, { attempt: 1, capability: "research", status: "completed", output: "回答" });
      const summary = makeSummary({ taskId: task.id, status: "completed", output: "回答" });
      await hooks?.onTaskFinished?.(task, summary);

      return {
        answer: "回答",
        executionId: "exec-6",
        tasks: [summary],
        memoryUsed: [],
        toolsUsed: [],
        memoryWrites: [],
        learningSignals: ["successful_execution"],
        metadata: { executionMode: "single-execution" },
      };

    };

    const { deps, calls } = makeRecordingDeps(fakeOrchestration);

    // Work.status="waiting_for_input"(前回のTurnで確定した状態)から
    // 開始する——この場合"created"チェックに引っかからないため、
    // planningへの遷移は行わない。onTasksPlanned()自体がrunningへ
    // 戻す。
    await runWorkTurn(
      { work: makeWork({ status: "waiting_for_input" }), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(
      check(
        "[Clarification resumed] waiting_for_input状態のWorkも、Task計画が行われればrunningへ戻る",
        calls.workStatusUpdates[0] === "running"
      )
    );
  }

  return summarize("work/execution", results);

}
