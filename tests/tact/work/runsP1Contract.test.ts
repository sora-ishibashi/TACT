import { reconcileWorkCompletionStatus } from "../../../core/tact-work/completion";
import {
  evaluateStrandedTaskProjection,
  reconcileStrandedTaskProjection,
  type ReconcileStrandedTaskProjectionDeps,
} from "../../../core/tact-work/taskRunReconciliation";
import type { Run, TaskStatus, Work, WorkTask, WorkStatus } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

const NOW = "2026-09-14T00:00:00.000Z";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    workId: "work-1",
    taskId: "task-b",
    attempt: 1,
    capability: "communication.read",
    status: "running",
    startedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function makeTask(id: string, status: TaskStatus): WorkTask {
  return {
    id,
    workId: "work-1",
    description: id,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeWork(status: WorkStatus = "running"): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  {
    const failedFirstAttempt = makeRun({
      id: "run-1",
      attempt: 1,
      status: "failed",
      error: "temporary read failure",
    });
    const recoveredSecondAttempt = makeRun({
      id: "run-2",
      attempt: 2,
      status: "completed",
      result: { success: true, output: "fresh result" },
    });
    const historyBeforeProjection = JSON.stringify([failedFirstAttempt, recoveredSecondAttempt]);

    const outcome = evaluateStrandedTaskProjection(
      "pending",
      [recoveredSecondAttempt, failedFirstAttempt]
    );

    results.push(check(
      "[RUNS-P1 contract] a later successful Run recovers the Task without rewriting failed attempt history",
      outcome.status === "projected" &&
        outcome.taskStatus === "completed" &&
        failedFirstAttempt.id !== recoveredSecondAttempt.id &&
        failedFirstAttempt.status === "failed" &&
        failedFirstAttempt.error === "temporary read failure" &&
        JSON.stringify([failedFirstAttempt, recoveredSecondAttempt]) === historyBeforeProjection
    ));
  }

  {
    const staleSuccessfulAttempt = makeRun({
      id: "run-1",
      attempt: 1,
      status: "completed",
      result: { success: true, output: "stale result" },
    });
    const authoritativeFailedAttempt = makeRun({
      id: "run-2",
      attempt: 2,
      status: "failed",
      error: "new attempt failed",
    });

    const outcome = evaluateStrandedTaskProjection(
      "pending",
      [authoritativeFailedAttempt, staleSuccessfulAttempt]
    );

    results.push(check(
      "[RUNS-P1 contract] a latest failed Run cannot be masked by a stale successful Run",
      outcome.status === "projected" &&
        outcome.taskStatus === "failed" &&
        staleSuccessfulAttempt.status === "completed" &&
        authoritativeFailedAttempt.status === "failed"
    ));
  }

  {
    let work = makeWork();
    let tasks = [makeTask("task-a", "completed"), makeTask("task-b", "pending")];
    const runsForTaskB = [
      makeRun({ id: "run-1", attempt: 1, status: "failed", error: "transient" }),
      makeRun({ id: "run-2", attempt: 2, status: "completed", result: { success: true, output: "recovered" } }),
    ];
    const workStatusUpdates: WorkStatus[] = [];

    const deps: ReconcileStrandedTaskProjectionDeps = {
      getWork: async () => work,
      listTasksForWork: async () => tasks,
      listRunsForTask: async (_workId, _userId, _accessToken, taskId) =>
        taskId === "task-b" ? runsForTaskB : [],
      updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
        tasks = tasks.map((task) => task.id === taskId ? { ...task, status } : task);
      },
      reconcileWorkCompletionStatus: async (workId, userId, accessToken) =>
        reconcileWorkCompletionStatus(workId, userId, accessToken, {
          getWork: async () => work,
          listTasksForWork: async () => tasks,
          listApprovalsForWork: async () => [],
          updateWorkStatus: async (_id, _user, _token, status) => {
            workStatusUpdates.push(status);
            work = { ...work, status };
          },
        }),
    };

    const outcome = await reconcileStrandedTaskProjection(
      "work-1",
      "user-1",
      "token",
      "task-b",
      deps
    );

    results.push(check(
      "[RUNS-P1 contract] recovered final Task projects to completed and allows Work completion only after all Tasks succeed",
      outcome.status === "projected" &&
        outcome.taskStatus === "completed" &&
        tasks.every((task) => task.status === "completed") &&
        workStatusUpdates.length === 1 &&
        workStatusUpdates[0] === "completed" &&
        work.status === "completed" &&
        runsForTaskB[0]?.status === "failed" &&
        runsForTaskB[1]?.status === "completed"
    ));
  }

  return summarize("work/runsP1Contract", results);
}
