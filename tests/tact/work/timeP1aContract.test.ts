// Independent TIME-P1a temporal contract verification.
//
// This suite deliberately targets boundaries and safety composition that are
// not covered by the implementation's foundation tests. It uses only the
// public Work temporal seams and injected dependencies; no provider, approval,
// scheduler, or database is contacted.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  setTaskWaitUntil,
  setWorkDeadline,
} from "../../../core/tact-work/store";
import { evaluateTaskRetryEligibility, type TaskRetryEligibilityDeps } from "../../../core/tact-work/taskRunReconciliation";
import {
  isDeadlineExceeded,
  isRetryTimeSatisfied,
  isWaitUntilSatisfied,
} from "../../../core/tact-work/temporal";
import type { Run, Work, WorkTask } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "time-contract-user";
const RETRY_AT = "2026-10-10T12:00:00.000Z";
const RETRY_PARAMS = {
  workId: "work-time-contract",
  userId: OWNER_USER_ID,
  accessToken: "time-contract-token",
  taskId: "task-time-contract",
};

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: RETRY_PARAMS.taskId,
    workId: RETRY_PARAMS.workId,
    description: "retry only when eligible",
    status: "waiting_for_retry",
    assignedCapability: "integration.gmail.send_message",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  } as WorkTask;
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-time-contract",
    workId: RETRY_PARAMS.workId,
    taskId: RETRY_PARAMS.taskId,
    attempt: 1,
    status: "failed",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    externalRef: { errorCode: "temporary_failure", errorRetryable: true },
    ...overrides,
  } as Run;
}

function retryDeps(
  now: string,
  task: WorkTask = makeTask({ nextRetryAt: RETRY_AT }),
  runs: Run[] = [makeRun()]
): TaskRetryEligibilityDeps {
  return {
    getWork: async () => ({
      id: RETRY_PARAMS.workId,
      userId: OWNER_USER_ID,
      createdByActorKind: "user",
      createdByActorId: OWNER_USER_ID,
      status: "running",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    } as Work),
    listTasksForWork: async () => [task],
    listRunsForTask: async () => runs,
    now: () => new Date(now),
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // Exact retry boundary must be open; this exercises the injected clock at
  // the actual eligibility integration rather than only the pure helper.
  {
    const eligibility = await evaluateTaskRetryEligibility(
      RETRY_PARAMS,
      retryDeps(RETRY_AT)
    );
    results.push(check(
      "[TIME-P1a independent] nextRetryAt is eligible exactly at T",
      eligibility.status === "eligible"
    ));
  }

  // An open temporal gate cannot override the retry lifecycle state or an
  // already-active attempt.
  {
    const past = "2026-10-10T12:00:00.001Z";
    const wrongState = await evaluateTaskRetryEligibility(
      RETRY_PARAMS,
      retryDeps(past, makeTask({ status: "pending", nextRetryAt: RETRY_AT }))
    );
    const activeRun = await evaluateTaskRetryEligibility(
      RETRY_PARAMS,
      retryDeps(past, makeTask({ nextRetryAt: RETRY_AT }), [makeRun({ status: "running" })])
    );
    results.push(check(
      "[TIME-P1a independent] a passed retry time cannot override state or an active Run",
      wrongState.status === "blocked" && wrongState.reasonCode === "task_not_waiting_for_retry" &&
        activeRun.status === "blocked" && activeRun.reasonCode === "active_run_exists"
    ));
  }

  // A passed retry time cannot turn an uncertain external WRITE outcome into a
  // retryable one: RUNS-P1 remains fail-closed on missing retryability.
  {
    const eligibility = await evaluateTaskRetryEligibility(
      RETRY_PARAMS,
      retryDeps("2026-10-10T12:00:00.001Z", makeTask({ nextRetryAt: RETRY_AT }), [
        makeRun({ externalRef: { errorCode: "external_write_outcome_uncertain" } }),
      ])
    );
    results.push(check(
      "[TIME-P1a independent] time cannot make an uncertain external write retryable",
      eligibility.status === "blocked" && eligibility.reasonCode === "latest_failure_not_retryable"
    ));
  }

  // Persistence validation must accept absolute Z and offset timestamps, and
  // reject an ISO-looking local timestamp before ownership/DB work begins.
  {
    let acceptedCalls = 0;
    let rejectedCalls = 0;
    const offsetDeadline = await setWorkDeadline(
      RETRY_PARAMS.workId, OWNER_USER_ID, RETRY_PARAMS.accessToken,
      "2026-10-10T21:00:00+09:00",
      { getWork: async () => { acceptedCalls++; return undefined; } }
    );
    const zWaitUntil = await setTaskWaitUntil(
      RETRY_PARAMS.workId, OWNER_USER_ID, RETRY_PARAMS.accessToken, RETRY_PARAMS.taskId,
      RETRY_AT,
      { getWork: async () => { acceptedCalls++; return undefined; } }
    );
    const ambiguous = await setWorkDeadline(
      RETRY_PARAMS.workId, OWNER_USER_ID, RETRY_PARAMS.accessToken,
      "2026-10-10T12:00:00",
      { getWork: async () => { rejectedCalls++; return undefined; } }
    );
    results.push(check(
      "[TIME-P1a independent] explicit offsets/Z are accepted and local ISO time is rejected before DB access",
      offsetDeadline.status === "not_found" && zWaitUntil.status === "not_found" && acceptedCalls === 2 &&
        ambiguous.status === "invalid_timestamp" && rejectedCalls === 0
    ));
  }

  // Equivalent absolute instants and separate Task/Work values are evaluated
  // from the passed data only; one object's gate cannot bleed into another.
  {
    const now = new Date(RETRY_AT);
    results.push(check(
      "[TIME-P1a independent] equivalent offsets and temporal values remain isolated",
      isWaitUntilSatisfied(now, "2026-10-10T21:00:00+09:00") &&
        isRetryTimeSatisfied(now, "2026-10-10T12:00:00.000Z") &&
        !isRetryTimeSatisfied(now, "2026-10-10T12:00:00.001Z") &&
        isDeadlineExceeded(now, "2026-10-10T12:00:00.000Z") &&
        !isDeadlineExceeded(now, "2026-10-10T12:00:00.001Z")
    ));
  }

  // The evaluator is an eligibility read: it must not contain scheduling or
  // execution calls which could make time itself an authorization boundary.
  {
    const source = readFileSync(
      join(__dirname, "..", "..", "..", "core", "tact-work", "taskRunReconciliation.ts"),
      "utf-8"
    );
    const evaluator = source.slice(
      source.indexOf("export async function evaluateTaskRetryEligibility"),
      source.indexOf("// =========================", source.indexOf("export async function evaluateTaskRetryEligibility"))
    );
    results.push(check(
      "[TIME-P1a independent] retry temporal evaluation contains no scheduler or execution action",
      !/setTimeout\s*\(|setInterval\s*\(|schedule\s*\(|createRun\s*\(|execute[A-Za-z]*\s*\(/.test(evaluator)
    ));
  }

  return summarize("work/timeP1aContract", results);
}
