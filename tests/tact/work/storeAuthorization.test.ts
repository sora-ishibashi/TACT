// =========================
// TACT Work Store — Authorization / Guard Regression
// (Architecture Migration Phase B1)
// =========================
//
// 対象: core/tact-work/store.tsの
//   - isSelfDependency() / isDuplicateDependency() / isDuplicateAttempt()
//     (純粋関数、DBアクセスなし)
//   - createTask() / listTasksForWork() / createTaskDependency() /
//     createRun() / completeRun() / failRun() / listRunsForTask() /
//     createApproval() / getApproval() / updateApprovalStatus() /
//     listApprovalsForWork()
//     が、他userのWork(=deps.getWork()が解決できないWork)に対しては
//     子Entityへ一切到達せず、安全にundefined/[]を返すこと
//     (WorkOwnershipDeps経由のDependency Injection、
//     core/tact-bot/connector/conversationConnector.tsと同じ
//     テスト手法)。
//
// 絶対条件(既存規約と同じ): このファイル自体は実Supabase接続を
// 行わない。deps.getWork()を偽実装に差し替えることで、
// createRequestScopedClient()以降のDB呼び出しに一切到達しないこと
// を保証する(deps.getWork()がundefinedを返した時点で全関数が
// 早期returnするため、これらのtestは実際にネットワークへ到達
// しない)。DB側のPRIMARY KEY/UNIQUE index/CHECK制約(migration
// 自体)による実際の防止は、別途一時スクリプトで確認する。

import {
  isSelfDependency,
  isDuplicateDependency,
  isDuplicateAttempt,
  createTask,
  listTasksForWork,
  createTaskDependency,
  createRun,
  completeRun,
  failRun,
  listRunsForTask,
  createApproval,
  getApproval,
  updateApprovalStatus,
  listApprovalsForWork,
  type WorkOwnershipDeps,
} from "../../../core/tact-work/store";
import type { Work, TaskDependency, Run } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "running",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

// 他userのWorkを指定した場合(=このuserからは見えないWork)を模した
// 偽実装。getConversation()等の既存規約と同じく、「存在しない」と
// 「所有者不一致」を区別せず常にundefinedを返す。
const notFoundDeps: WorkOwnershipDeps = {
  getWork: async () => undefined,
};

const foundDeps: WorkOwnershipDeps = {
  getWork: async () => makeWork(),
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 純粋guard関数 ----

  results.push(
    check(
      "[Guard] isSelfDependency(): 同じtaskId同士はtrue",
      isSelfDependency("task-1", "task-1") === true
    )
  );

  results.push(
    check(
      "[Guard] isSelfDependency(): 異なるtaskId同士はfalse",
      isSelfDependency("task-1", "task-2") === false
    )
  );

  {
    const existing: TaskDependency[] = [
      { taskId: "task-2", dependsOnTaskId: "task-1", createdAt: "2026-09-05T00:00:00.000Z" },
    ];

    results.push(
      check(
        "[Guard] isDuplicateDependency(): 既存と同じ組み合わせはtrue",
        isDuplicateDependency(existing, { taskId: "task-2", dependsOnTaskId: "task-1" }) === true
      )
    );

    results.push(
      check(
        "[Guard] isDuplicateDependency(): 異なる組み合わせはfalse",
        isDuplicateDependency(existing, { taskId: "task-3", dependsOnTaskId: "task-1" }) === false
      )
    );
  }

  {
    const existing: Run[] = [
      {
        id: "run-1",
        workId: "work-1",
        taskId: "task-1",
        attempt: 1,
        capability: "research",
        status: "completed",
        startedAt: "2026-09-05T00:00:00.000Z",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    ];

    results.push(
      check(
        "[Guard] isDuplicateAttempt(): 既存と同じattemptはtrue",
        isDuplicateAttempt(existing, 1) === true
      )
    );

    results.push(
      check(
        "[Guard] isDuplicateAttempt(): 異なるattemptはfalse",
        isDuplicateAttempt(existing, 2) === false
      )
    );
  }

  // ---- cross-user Work / child entity access rejected(DI経由) ----

  {
    const task = await createTask(
      "work-1", "attacker-user", "fake-token",
      { description: "不正なTask作成" },
      notFoundDeps
    );
    results.push(
      check(
        "[cross-user] createTask(): 他userのWorkへは作成できずundefined",
        task === undefined
      )
    );
  }

  {
    const tasks = await listTasksForWork("work-1", "attacker-user", "fake-token", notFoundDeps);
    results.push(
      check(
        "[cross-user] listTasksForWork(): 他userのWorkは空配列",
        Array.isArray(tasks) && tasks.length === 0
      )
    );
  }

  {
    const run = await createRun(
      "work-1", "attacker-user", "fake-token", "task-1",
      { attempt: 1, capability: "research" },
      notFoundDeps
    );
    results.push(
      check(
        "[cross-user] createRun(): 他userのWorkへは作成できずundefined",
        run === undefined
      )
    );
  }

  {
    // completeRun/failRunは戻り値を持たないため、例外を投げず安全に
    // 早期returnすること自体を確認する(=実DB呼び出しに到達しない)。
    let threw = false;
    try {
      await completeRun("work-1", "attacker-user", "fake-token", "run-1", {}, notFoundDeps);
      await failRun("work-1", "attacker-user", "fake-token", "run-1", { error: "x" }, notFoundDeps);
    } catch {
      threw = true;
    }
    results.push(
      check(
        "[cross-user] completeRun()/failRun(): 他userのWorkに対しても例外を投げず安全に早期returnする",
        threw === false
      )
    );
  }

  {
    const runs = await listRunsForTask("work-1", "attacker-user", "fake-token", "task-1", notFoundDeps);
    results.push(
      check(
        "[cross-user] listRunsForTask(): 他userのWorkは空配列",
        Array.isArray(runs) && runs.length === 0
      )
    );
  }

  {
    const approval = await createApproval(
      "work-1", "attacker-user", "fake-token",
      {
        requestedByActorKind: "ai",
        requestedByActorId: "tact-research",
        requestedFromActorKind: "user",
        requestedFromActorId: "attacker-user",
        reason: "不正な承認依頼",
        payload: {},
      },
      notFoundDeps
    );
    results.push(
      check(
        "[cross-user] createApproval(): 他userのWorkへは作成できずundefined",
        approval === undefined
      )
    );
  }

  {
    const approval = await getApproval("work-1", "attacker-user", "fake-token", "approval-1", notFoundDeps);
    results.push(
      check(
        "[cross-user] getApproval(): 他userのWork配下のApprovalはundefined",
        approval === undefined
      )
    );
  }

  {
    let threw = false;
    try {
      await updateApprovalStatus("work-1", "attacker-user", "fake-token", "approval-1", "approved", undefined, notFoundDeps);
    } catch {
      threw = true;
    }
    results.push(
      check(
        "[cross-user] updateApprovalStatus(): 他userのWorkに対しても例外を投げず安全に早期returnする",
        threw === false
      )
    );
  }

  {
    const approvals = await listApprovalsForWork("work-1", "attacker-user", "fake-token", notFoundDeps);
    results.push(
      check(
        "[cross-user] listApprovalsForWork(): 他userのWorkは空配列",
        Array.isArray(approvals) && approvals.length === 0
      )
    );
  }

  // ---- self dependency rejected(所有者検証は通るが、DB到達前に拒否) ----

  {
    let threw = false;
    let message = "";
    try {
      await createTaskDependency("work-1", "user-1", "fake-token", "task-1", "task-1", foundDeps);
    } catch (error) {
      threw = true;
      message = error instanceof Error ? error.message : String(error);
    }
    results.push(
      check(
        "[self-dependency] createTaskDependency(): 同一taskId同士はDB到達前に例外を投げる",
        threw === true && message.includes("cannot depend on itself")
      )
    );
  }

  return summarize("work/storeAuthorization", results);

}
