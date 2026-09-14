import {
  reconcileWorkCompletionStatus,
  type ReconcileWorkCompletionStatusDeps,
} from "../../../core/tact-work/completion";
import { findLatestRun } from "../../../core/tact-work/taskRunReconciliation";
import type { Approval, Run, Work, WorkTask, WorkStatus } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

const NOW = "2026-09-14T00:00:00.000Z";

function work(id: string, status: WorkStatus = "running"): Work {
  return {
    id,
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function task(id: string, workId: string, status: WorkTask["status"]): WorkTask {
  return {
    id,
    workId,
    description: id,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function approval(workId: string, status: Approval["status"]): Approval {
  return {
    id: `approval-${workId}`,
    workId,
    taskId: null,
    requestedByActorKind: "ai",
    requestedByActorId: "tact",
    requestedFromActorKind: "user",
    requestedFromActorId: "user-1",
    status,
    reason: "protected action",
    payload: {},
    requestedAt: NOW,
    createdAt: NOW,
  };
}

function makeRun(id: string, taskId: string, attempt: number): Run {
  return {
    id,
    workId: "work-a",
    taskId,
    attempt,
    capability: "communication.write",
    status: attempt === 1 ? "failed" : "completed",
    startedAt: NOW,
    createdAt: NOW,
  };
}

function completionHarness(
  works: Work[],
  tasks: WorkTask[],
  approvals: Approval[] = []
): {
  deps: ReconcileWorkCompletionStatusDeps;
  workStatusUpdates: { workId: string; status: WorkStatus }[];
  taskLoads: string[];
} {
  const workStatusUpdates: { workId: string; status: WorkStatus }[] = [];
  const taskLoads: string[] = [];

  return {
    workStatusUpdates,
    taskLoads,
    deps: {
      getWork: async (workId) => works.find((candidate) => candidate.id === workId),
      listTasksForWork: async (workId) => {
        taskLoads.push(workId);
        return tasks.filter((candidate) => candidate.workId === workId);
      },
      listApprovalsForWork: async (workId) =>
        approvals.filter((candidate) => candidate.workId === workId),
      updateWorkStatus: async (workId, _userId, _accessToken, status) => {
        workStatusUpdates.push({ workId, status });
      },
    },
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  {
    const harness = completionHarness(
      [work("work-a")],
      [
        task("task-a", "work-a", "completed"),
        task("task-b", "work-a", "pending"),
        task("task-c", "work-a", "completed"),
      ]
    );

    const outcome = await reconcileWorkCompletionStatus("work-a", "user-1", "token", harness.deps);

    results.push(check(
      "[WORK-P2 contract] incomplete required Task prevents Work completion even when the last Task completed",
      outcome.status === "no_change" &&
        outcome.reason === "tasks_not_all_terminal" &&
        harness.workStatusUpdates.length === 0
    ));
  }

  {
    const harness = completionHarness(
      [work("work-a")],
      [
        task("task-a", "work-a", "completed"),
        task("task-b", "work-a", "completed"),
        task("task-c", "work-a", "completed"),
      ]
    );

    const outcome = await reconcileWorkCompletionStatus("work-a", "user-1", "token", harness.deps);

    results.push(check(
      "[WORK-P2 contract] all successful Tasks deterministically complete their Work",
      outcome.status === "reconciled" &&
        outcome.workStatus === "completed" &&
        harness.workStatusUpdates.length === 1 &&
        harness.workStatusUpdates[0]?.workId === "work-a" &&
        harness.workStatusUpdates[0]?.status === "completed"
    ));
  }

  {
    const harness = completionHarness(
      [work("work-a")],
      [
        task("task-a", "work-a", "completed"),
        task("task-b", "work-a", "failed"),
        task("task-c", "work-a", "completed"),
      ]
    );

    const outcome = await reconcileWorkCompletionStatus("work-a", "user-1", "token", harness.deps);

    results.push(check(
      "[WORK-P2 contract] a failed Task cannot produce false successful Work completion",
      outcome.status === "reconciled" &&
        outcome.workStatus === "failed" &&
        harness.workStatusUpdates.length === 1 &&
        harness.workStatusUpdates[0]?.status === "failed"
    ));
  }

  {
    const harness = completionHarness(
      [work("work-a"), work("work-b")],
      [
        task("task-a-1", "work-a", "completed"),
        task("task-a-2", "work-a", "completed"),
        task("task-b-1", "work-b", "pending"),
      ]
    );

    const outcome = await reconcileWorkCompletionStatus("work-a", "user-1", "token", harness.deps);

    results.push(check(
      "[WORK-P2 contract] Tasks from another Work never affect completion or mutate that Work",
      outcome.status === "reconciled" &&
        outcome.workStatus === "completed" &&
        harness.taskLoads.join(",") === "work-a" &&
        harness.workStatusUpdates.length === 1 &&
        harness.workStatusUpdates[0]?.workId === "work-a"
    ));
  }

  {
    const harness = completionHarness(
      [work("work-a")],
      [task("task-a", "work-a", "completed")],
      [approval("work-a", "pending")]
    );

    const outcome = await reconcileWorkCompletionStatus("work-a", "user-1", "token", harness.deps);

    results.push(check(
      "[WORK-P2 contract] pending Approval blocks completed protected Task from completing Work",
      outcome.status === "no_change" &&
        outcome.reason === "pending_approval_exists" &&
        harness.workStatusUpdates.length === 0
    ));
  }

  {
    const classicWork = work("work-a");
    const harness = completionHarness(
      [classicWork],
      [task("task-a", "work-a", "completed")]
    );

    const outcome = await reconcileWorkCompletionStatus("work-a", "user-1", "token", harness.deps);

    results.push(check(
      "[WORK-P2 contract] legacy single-Task Work completion remains compatible",
      outcome.status === "reconciled" &&
        outcome.workStatus === "completed" &&
        harness.workStatusUpdates[0]?.status === "completed"
    ));
  }

  {
    const firstAttempt = makeRun("run-1", "task-a", 1);
    const retryAttempt = makeRun("run-2", "task-a", 2);
    const latest = findLatestRun([retryAttempt, firstAttempt]);

    results.push(check(
      "[WORK-P2 contract] one Task retains distinct retry Runs and selects the highest attempt independent of list order",
      firstAttempt.taskId === retryAttempt.taskId &&
        firstAttempt.id !== retryAttempt.id &&
        latest?.id === "run-2" &&
        latest.attempt === 2
    ));
  }

  return summarize("work/workP2Contract", results);
}
