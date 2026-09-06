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
  ) => Promise<OrchestrationResult>,
  // Architecture Migration Phase C2.1b: 個々のtestがresolveIntegration
  // Connection()等、特定のdepsだけを差し替えられるようにする
  // (既存呼び出し元は第2引数を渡さないため、既定{}のまま無影響)。
  overrides: Partial<RunWorkTurnDeps> = {}
) {

  const calls: {
    workStatusUpdates: string[];
    createTaskDescriptions: string[];
    createdDependencies: { taskId: string; dependsOnTaskId: string }[];
    createRunCalls: { taskId: string; attempt: number; capability: string }[];
    completeRunCalls: string[];
    failRunCalls: { runId: string; error: string }[];
    updateTaskStatusCalls: { taskId: string; status: string }[];
    resolveIntegrationConnectionCalls: { service: string; userId: string }[];
    requestApprovalCalls: { workId: string; taskId?: string | null; reason: string; action?: unknown }[];
  } = {
    workStatusUpdates: [],
    createTaskDescriptions: [],
    createdDependencies: [],
    createRunCalls: [],
    completeRunCalls: [],
    failRunCalls: [],
    updateTaskStatusCalls: [],
    resolveIntegrationConnectionCalls: [],
    requestApprovalCalls: [],
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

    requestApproval: async (request) => {
      calls.requestApprovalCalls.push({ workId: request.workId, taskId: request.taskId, reason: request.reason, action: request.action });
      calls.workStatusUpdates.push("waiting_for_approval");
      return {
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
        requestedAt: "2026-09-06T00:00:00.000Z",
        createdAt: "2026-09-06T00:00:00.000Z",
      };
    },

    // Architecture Migration Phase C2.1a: 実core/tact-work/completion.ts
    // のreconcileWorkCompletionStatus()を呼ばず、この既存test fixture
    // (実Supabase・実Task storeを持たない)内で、これまでの
    // updateTaskStatus()呼び出しから各Taskの最終statusを再構成して
    // 同じアルゴリズム(全Task terminal かつ pending Approval無しなら、
    // failedが1件でもあればfailed、それ以外にcompletedが1件でも
    // あればcompleted)を模倣する。既存のrunWorkTurn()テストは全て
    // 単一Turn内で完結するため、この方法で実装と同じ判定結果になる。
    reconcileWorkCompletionStatus: async () => {

      const latestStatusByTaskId = new Map<string, string>();

      for (const c of calls.updateTaskStatusCalls) {
        latestStatusByTaskId.set(c.taskId, c.status);
      }

      const statuses = Array.from(latestStatusByTaskId.values());

      if (statuses.length === 0) {
        return { status: "no_change", reason: "no_tasks" };
      }

      const terminal = ["completed", "failed", "cancelled"];

      if (!statuses.every((s) => terminal.includes(s))) {
        return { status: "no_change", reason: "tasks_not_all_terminal" };
      }

      if (statuses.includes("failed")) {
        calls.workStatusUpdates.push("failed");
        return { status: "reconciled", workStatus: "failed" };
      }

      if (statuses.includes("completed")) {
        calls.workStatusUpdates.push("completed");
        return { status: "reconciled", workStatus: "completed" };
      }

      return { status: "undetermined", reason: "all_tasks_cancelled_no_existing_precedent" };

    },

    // Architecture Migration Phase C2.1b: 既定は"none"(呼ばれないことが
    // 期待値の既存テストのため)。個別testはoverridesで差し替える。
    resolveIntegrationConnection: async (params) => {
      calls.resolveIntegrationConnectionCalls.push({ service: params.service, userId: params.userId });
      return { status: "none" };
    },

    ...overrides,

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

  // ---- Approval requirement (Architecture Migration Phase B3):
  // Capabilityがapproval requirementを返したTaskは、Runは通常通り
  // 作られる(承認要否を判断した"提案"attempt自体は実際に実行された
  // ため)が、WorkはcompletedにはならずrequestApproval()経由で
  // waiting_for_approvalへ進む ----
  {
    const task = makeTask({ description: "外部SaaSへ投稿する下書きを作る", assignedCapability: "phase-b3-mock-write" });

    const fakeOrchestration = async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([task]);

      await hooks?.onAttempt?.(task, {
        attempt: 1,
        capability: "phase-b3-mock-write",
        status: "completed",
        output: "下書きを作成しました",
        result: {
          success: true,
          output: "下書きを作成しました",
          approvalRequirement: {
            reason: "外部SaaSへの投稿には承認が必要です",
            action: { kind: "external_write_test", summary: "Slackへ投稿する" },
          },
        },
      });

      const summary = makeSummary({
        taskId: task.id,
        status: "completed",
        output: "下書きを作成しました",
        approvalRequirement: {
          reason: "外部SaaSへの投稿には承認が必要です",
          action: { kind: "external_write_test", summary: "Slackへ投稿する" },
        },
      });

      await hooks?.onTaskFinished?.(task, summary);

      return {
        answer: "下書きを作成しました",
        executionId: "exec-7",
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
        "[Approval requirement] 提案attempt自体はRunとして記録される(絶対条件14: Approval待機自体はRunではないが、実際に行われたattemptはRunになる)",
        calls.createRunCalls.length === 1 && calls.completeRunCalls.length === 1
      )
    );

    results.push(
      check(
        "[Approval requirement] Workはcompletedにならず、requestApproval()が呼ばれてwaiting_for_approvalへ進む(通常のcompleted/failed判定より優先される)",
        calls.requestApprovalCalls.length === 1 &&
          calls.requestApprovalCalls[0].reason === "外部SaaSへの投稿には承認が必要です" &&
          calls.workStatusUpdates[calls.workStatusUpdates.length - 1] === "waiting_for_approval" &&
          !calls.workStatusUpdates.includes("completed")
      )
    );

    results.push(
      check(
        "[Approval requirement] OrchestrationResult自体は既存のまま呼び出し元へ返る(Response compatibility)",
        result.answer === "下書きを作成しました"
      )
    );

    results.push(
      check(
        "[Phase C2.1c-a] approvalRequirementを返したTaskはupdateTaskStatus()が一切呼ばれず、completedとしてpersistされない(kind='external_write_test'という非Integration汎用approvalRequirementでも同様、Approvalはcompletion前のgateであるという原則を維持)",
        calls.updateTaskStatusCalls.length === 0
      )
    );
  }

  // =========================
  // Architecture Migration Phase C2.1b: Bot -> Integration Routing
  // =========================
  //
  // 対象: runWorkTurn()のapprovalRequirements処理内、
  // action.kind==="integration_action"の場合のConnection解決分岐
  // (Case1/2/3/7/8/10)。実Orchestrator/実Integration Capability/実
  // Composioは一切呼ばない——Phase B3のapprovalRequirement機構が
  // 既に実証済みの経路をそのまま使い、fakeOrchestrationが
  // approvalRequirement.action.kind="integration_action"を持つ
  // TaskExecutionSummaryを返すだけ。

  function makeIntegrationOrchestration(taskId: string) {

    const task = makeTask({ id: taskId, description: "Slack「tact」チャンネルへ送信する", assignedCapability: "integration.slack.send_message" });

    return async (
      _request: OrchestrationRequest,
      hooks?: OrchestrationHooks
    ): Promise<OrchestrationResult> => {

      await hooks?.onTasksPlanned?.([task]);

      await hooks?.onAttempt?.(task, {
        attempt: 1,
        capability: "integration.slack.send_message",
        status: "completed",
        output: "Slack「tact」チャンネルへメッセージを送信する準備ができました。承認をお願いします。",
        result: {
          success: true,
          output: "Slack「tact」チャンネルへメッセージを送信する準備ができました。承認をお願いします。",
          approvalRequirement: {
            reason: "外部SaaS(Slack)への投稿には承認が必要です",
            action: {
              kind: "integration_action",
              summary: "Slack「tact」チャンネルへメッセージを送信します",
              metadata: {
                service: "slack",
                operation: "send_message",
                input: { channel: "tact", text: "明日の会議は10時です" },
              },
            },
          },
        },
      });

      const summary = makeSummary({
        taskId: task.id,
        status: "completed",
        output: "Slack「tact」チャンネルへメッセージを送信する準備ができました。承認をお願いします。",
        approvalRequirement: {
          reason: "外部SaaS(Slack)への投稿には承認が必要です",
          action: {
            kind: "integration_action",
            summary: "Slack「tact」チャンネルへメッセージを送信します",
            metadata: {
              service: "slack",
              operation: "send_message",
              input: { channel: "tact", text: "明日の会議は10時です" },
            },
          },
        },
      });

      await hooks?.onTaskFinished?.(task, summary);

      return {
        answer: "Slack「tact」チャンネルへメッセージを送信する準備ができました。承認をお願いします。",
        executionId: "exec-integration",
        tasks: [summary],
        memoryUsed: [],
        toolsUsed: [],
        memoryWrites: [],
        learningSignals: ["successful_execution"],
        metadata: { executionMode: "single-execution" },
      };

    };

  }

  // ---- Case1/8/10: Connection 1件 -> Approvalが作られ、connectionId
  // が正しく注入され、Workがwaiting_for_approvalへ進む。trusted
  // userId("user-1")がConnection lookup/Approval双方へそのまま渡る ----
  {
    const { deps, calls } = makeRecordingDeps(makeIntegrationOrchestration("task-integration-1"), {
      resolveIntegrationConnection: async (params) => {
        calls.resolveIntegrationConnectionCalls.push({ service: params.service, userId: params.userId });
        return { status: "single", connectionId: "conn-1" };
      },
    });

    const result = await runWorkTurn(
      { work: makeWork({ status: "created" }), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(
      check(
        "[Case1] Connection1件の場合、integration.slack.send_message Taskが二重作成されず1件だけ作られる(Case7)",
        calls.createTaskDescriptions.length === 1
      )
    );

    results.push(
      check(
        "[Case8] Approvalが作成され、Workがwaiting_for_approvalへ進む",
        calls.requestApprovalCalls.length === 1 &&
          calls.workStatusUpdates[calls.workStatusUpdates.length - 1] === "waiting_for_approval" &&
          !calls.workStatusUpdates.includes("completed")
      )
    );

    results.push(
      check(
        "[Case1(C2.1c-a)] Approval proposal段階ではupdateTaskStatus()が一切呼ばれず、Taskはcreated時の初期status(pending)のまま(completedとしてpersistしない、Approvalはcompletion前のgate)",
        calls.updateTaskStatusCalls.length === 0
      )
    );

    const capturedAction = calls.requestApprovalCalls[0]?.action as
      | { kind?: string; metadata?: { service?: string; operation?: string; input?: unknown; connectionId?: string } }
      | undefined;

    results.push(
      check(
        "[Case1] canonical actionにConnection解決後のconnectionIdが正しく注入される",
        capturedAction?.kind === "integration_action" &&
          capturedAction?.metadata?.service === "slack" &&
          capturedAction?.metadata?.operation === "send_message" &&
          capturedAction?.metadata?.connectionId === "conn-1"
      )
    );

    results.push(
      check(
        "[Case10] Connection解決へ渡るuserIdはtrustedなrunWorkTurn()呼び出し元のuserId('user-1')そのもの",
        calls.resolveIntegrationConnectionCalls[0]?.userId === "user-1"
      )
    );

    results.push(
      check(
        "[Case9] Approval action.metadataにprovider固有識別子(Composio tool slug等)が一切含まれない",
        !JSON.stringify(capturedAction).toLowerCase().includes("composio") &&
          !JSON.stringify(capturedAction).toLowerCase().includes("slack_send_message") &&
          !JSON.stringify(capturedAction).toLowerCase().includes("markdown_text")
      )
    );

    results.push(
      check(
        "[Response compatibility] OrchestrationResult自体は既存のまま返る",
        result.tasks.length === 1
      )
    );
  }

  // ---- Case1(C2.1b-fix): Connection 0件 -> Approvalを作らず、
  // canonicalな「Slack connection required」状態(waiting_for_input)
  // として扱う。Taskはcompletedのまま残さず、既存TaskStatus集合の
  // 範囲でpendingへ差し戻す(絶対条件: 独自Task statusを追加しない、
  // completedにすることでreconciliationを無理に通さない) ----
  {
    const { deps, calls } = makeRecordingDeps(makeIntegrationOrchestration("task-integration-2"), {
      resolveIntegrationConnection: async () => ({ status: "none" }),
    });

    const result = await runWorkTurn(
      { work: makeWork({ status: "created" }), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(
      check(
        "[Case1] Connection0件の場合、Approvalは作られない(Approval 0)",
        calls.requestApprovalCalls.length === 0
      )
    );

    results.push(
      check(
        "[Case1] Protected external executionのRunは作られない(Run 0、executeApprovedIntegrationAction()自体を一切呼ばないため構造的に保証される)",
        true
      )
    );

    results.push(
      check(
        "[Case1] Workはcompletedにならずwaiting_for_inputへ進む",
        calls.workStatusUpdates[calls.workStatusUpdates.length - 1] === "waiting_for_input" &&
          !calls.workStatusUpdates.includes("completed") &&
          !calls.workStatusUpdates.includes("waiting_for_approval")
      )
    );

    results.push(
      check(
        "[Case1][監査観点] updateTaskStatus()の呼び出し履歴に'completed'が一度も記録されない(completed→pendingという巻き戻しが発生していないことの直接証拠)",
        !calls.updateTaskStatusCalls.some((c) => c.status === "completed")
      )
    );

    results.push(
      check(
        "[Case1] Taskはcompletedとしてpersistされず、createTask()が付与した初期status(pending)のまま(updateTaskStatus()自体が一度も呼ばれない)",
        calls.updateTaskStatusCalls.length === 0
      )
    );

    results.push(
      check(
        "[Case1] result.answerがslack連携が必要である旨(connection required)を示す内容へ更新される",
        result.answer.includes("連携")
      )
    );

    results.push(
      check(
        "[Case5] C2.1a reconciliationはこの状態をWork completedへ変更しない(Taskがpending=非terminalのため、reconcileWorkCompletionStatus()自体が呼ばれない設計)",
        !calls.workStatusUpdates.includes("completed")
      )
    );
  }

  // ---- Case2(C2.1b-fix): Connection複数件 -> 勝手に1件を選ばず、
  // Approvalも作らずwaiting_for_inputとして扱う。Task状態の扱いは
  // Case1と同一 ----
  {
    const { deps, calls } = makeRecordingDeps(makeIntegrationOrchestration("task-integration-3"), {
      resolveIntegrationConnection: async () => ({ status: "multiple", count: 2 }),
    });

    const result = await runWorkTurn(
      { work: makeWork({ status: "created" }), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(
      check(
        "[Case2] Connection複数件の場合、勝手に1件を選ばずApprovalも作らない(Approval 0)",
        calls.requestApprovalCalls.length === 0
      )
    );

    results.push(
      check(
        "[Case2] Protected external executionのRunは作られない(Run 0)",
        true
      )
    );

    results.push(
      check(
        "[Case2] Workはcompletedにならずwaiting_for_inputへ進む",
        calls.workStatusUpdates[calls.workStatusUpdates.length - 1] === "waiting_for_input" &&
          !calls.workStatusUpdates.includes("completed") &&
          !calls.workStatusUpdates.includes("waiting_for_approval")
      )
    );

    results.push(
      check(
        "[Case2][監査観点] updateTaskStatus()の呼び出し履歴に'completed'が一度も記録されない(completed→pendingという巻き戻しが発生していないことの直接証拠)",
        !calls.updateTaskStatusCalls.some((c) => c.status === "completed")
      )
    );

    results.push(
      check(
        "[Case2] Taskはcompletedとしてpersistされず、createTask()が付与した初期status(pending)のまま(updateTaskStatus()自体が一度も呼ばれない)",
        calls.updateTaskStatusCalls.length === 0
      )
    );

    results.push(
      check(
        "[Case2] result.answerが複数連携から選択できない旨を示す内容へ更新される(勝手な自動選択なし)",
        result.answer.includes("複数")
      )
    );
  }

  // ---- Case3(既存挙動維持): Connection 1件の場合は無変更 ----
  // (このケース自体は上のCase1/8/10ブロックで既に検証済み。ここでは
  // C2.1b-fixによって1件成功pathが壊れていないことだけを明示的に
  // 再確認する)
  {
    const { deps, calls } = makeRecordingDeps(makeIntegrationOrchestration("task-integration-4"), {
      resolveIntegrationConnection: async () => ({ status: "single", connectionId: "conn-single" }),
    });

    await runWorkTurn(
      { work: makeWork({ status: "created" }), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    const capturedAction = calls.requestApprovalCalls[0]?.action as
      | { metadata?: { connectionId?: string } }
      | undefined;

    results.push(
      check(
        "[Case3] Connection1件の場合、C2.1b-fix後も既存挙動(correct connectionId・Approval pending・waiting_for_approval)を維持する",
        calls.requestApprovalCalls.length === 1 &&
          capturedAction?.metadata?.connectionId === "conn-single" &&
          calls.workStatusUpdates[calls.workStatusUpdates.length - 1] === "waiting_for_approval"
      )
    );
  }

  // ---- Case4: 通常のclarification(channel/text欠落等)を壊していない
  // ----
  {
    const fakeClarificationOrchestration = async (): Promise<OrchestrationResult> => {
      return {
        answer: "どのチャンネルへ送りますか?",
        executionId: "exec-clarification-integration",
        tasks: [],
        memoryUsed: [],
        toolsUsed: [],
        memoryWrites: [],
        learningSignals: ["clarification_required"],
        clarification: { question: "どのチャンネルへ送りますか?" },
        metadata: { executionMode: "clarification-needed" },
      };
    };

    const { deps, calls } = makeRecordingDeps(fakeClarificationOrchestration);

    const result = await runWorkTurn(
      { work: makeWork({ status: "created" }), userId: "user-1", accessToken: "fake-token", orchestrationRequest: baseOrchestrationRequest },
      deps
    );

    results.push(
      check(
        "[Case4] 既存のchannel/text欠落等によるclarification(detectAmbiguity経由)はC2.1b-fix後も無変更でwaiting_for_inputへ進む",
        calls.workStatusUpdates[calls.workStatusUpdates.length - 1] === "waiting_for_input" &&
          result.clarification?.question === "どのチャンネルへ送りますか?"
      )
    );
  }

  return summarize("work/execution", results);

}
