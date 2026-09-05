// =========================
// TACT Work — DB row ↔ domain mapping Regression
// (Architecture Migration Phase B1)
// =========================
//
// 対象: core/tact-work/store.tsのtoWork()/toWorkTask()/
// toTaskDependency()/toRun()/toApproval()(いずれも純粋関数、DB
// アクセスなし)。core/tact-conversation/store.tsの既存test
// (tactConversationMapping.test.ts)と同じ方針: このファイル自体は
// 実Supabase接続を行わない(LLM/Search API呼び出しも0件)。Stage1
// RLS・FK制約を含めた実DB上でのふるまいの検証は、別途一時スクリプト
// で実施する(tests/tact/の決定論的Harnessには含めない)。

import {
  toWork,
  toWorkTask,
  toTaskDependency,
  toRun,
  toApproval,
  type WorkRow,
  type WorkTaskRow,
  type TaskDependencyRow,
  type RunRow,
  type ApprovalRow,
} from "../../../core/tact-work/store";
import {
  WORK_STATUSES,
  TASK_STATUSES,
  RUN_STATUSES,
  APPROVAL_STATUSES,
} from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: toWork() — 基本フィールド変換 ----
  {
    const row: WorkRow = {
      id: "work-1",
      user_id: "user-1",
      organization_id: null,
      created_by_actor_kind: "user",
      created_by_actor_id: "user-1",
      title: "競合分析",
      objective: null,
      status: "created",
      primary_conversation_id: "conv-1",
      started_at: null,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      cost_summary: null,
      metadata: null,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    };

    const work = toWork(row);

    results.push(
      check(
        "[Test1] toWork(): 基本フィールドがsnake_case -> camelCaseへ変換される",
        work.id === "work-1" &&
          work.userId === "user-1" &&
          work.createdByActorKind === "user" &&
          work.createdByActorId === "user-1" &&
          work.primaryConversationId === "conv-1"
      )
    );

    results.push(
      check(
        "[Test1] toWork(): Work.id !== Conversation.id(独立したEntity)",
        work.id !== work.primaryConversationId
      )
    );
  }

  // ---- Test2: toWork() — 全WorkStatusが正しく往復する ----
  for (const status of WORK_STATUSES) {

    const row: WorkRow = {
      id: `work-${status}`,
      user_id: "user-1",
      organization_id: null,
      created_by_actor_kind: "system",
      created_by_actor_id: "scheduler",
      title: null,
      objective: null,
      status,
      primary_conversation_id: null,
      started_at: null,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      cost_summary: null,
      metadata: null,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    };

    const work = toWork(row);

    results.push(
      check(
        `[Test2] toWork(): status="${status}"が正しく往復する`,
        work.status === status
      )
    );

  }

  // ---- Test3: toWorkTask() — Taskは所属Workを保持する ----
  {
    const row: WorkTaskRow = {
      id: "task-1",
      work_id: "work-1",
      parent_task_id: null,
      description: "競合3社を調査する",
      status: "pending",
      assigned_capability: "research",
      table_schema: null,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    };

    const task = toWorkTask(row);

    results.push(
      check(
        "[Test3] toWorkTask(): workIdを保持する(Task belongs to Work)",
        task.workId === "work-1"
      )
    );

    results.push(
      check(
        "[Test3] toWorkTask(): assignedCapabilityを保持するが、assignedProvider/assignedModelに相当するfieldを持たない",
        task.assignedCapability === "research" &&
          !("assignedProvider" in task) &&
          !("assignedModel" in task)
      )
    );
  }

  // ---- Test4: toWorkTask() — 全TaskStatusが正しく往復する ----
  for (const status of TASK_STATUSES) {

    const row: WorkTaskRow = {
      id: `task-${status}`,
      work_id: "work-1",
      parent_task_id: null,
      description: "テスト",
      status,
      assigned_capability: null,
      table_schema: null,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    };

    const task = toWorkTask(row);

    results.push(
      check(
        `[Test4] toWorkTask(): status="${status}"が正しく往復する`,
        task.status === status
      )
    );

  }

  // ---- Test5: toTaskDependency() ----
  {
    const row: TaskDependencyRow = {
      task_id: "task-2",
      depends_on_task_id: "task-1",
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const dependency = toTaskDependency(row);

    results.push(
      check(
        "[Test5] toTaskDependency(): taskId/dependsOnTaskIdが正しく変換される",
        dependency.taskId === "task-2" && dependency.dependsOnTaskId === "task-1"
      )
    );
  }

  // ---- Test6: toRun() — RunはTask/Workの両方を保持する ----
  {
    const row: RunRow = {
      id: "run-1",
      work_id: "work-1",
      task_id: "task-1",
      attempt: 1,
      capability: "research",
      provider: "openai",
      model: "gpt-4o-mini",
      status: "completed",
      started_at: "2026-09-05T00:00:00.000Z",
      completed_at: "2026-09-05T00:01:00.000Z",
      error: null,
      cost: { tokens: 100, estimatedUSD: 0.001 },
      external_ref: null,
      result: { success: true, output: "回答" },
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const run = toRun(row);

    results.push(
      check(
        "[Test6] toRun(): workId/taskIdの両方を保持する(Run belongs to Task + Work)",
        run.workId === "work-1" && run.taskId === "task-1"
      )
    );

    results.push(
      check(
        "[Test6] toRun(): attempt/provider/model/cost/resultが正しく変換される",
        run.attempt === 1 &&
          run.provider === "openai" &&
          run.model === "gpt-4o-mini" &&
          run.cost?.tokens === 100 &&
          run.result?.success === true
      )
    );
  }

  // ---- Test7: toRun() — 全RunStatusが正しく往復する(cancelledは無い) ----
  for (const status of RUN_STATUSES) {

    const row: RunRow = {
      id: `run-${status}`,
      work_id: "work-1",
      task_id: "task-1",
      attempt: 1,
      capability: "research",
      provider: null,
      model: null,
      status,
      started_at: "2026-09-05T00:00:00.000Z",
      completed_at: null,
      error: null,
      cost: null,
      external_ref: null,
      result: null,
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const run = toRun(row);

    results.push(
      check(
        `[Test7] toRun(): status="${status}"が正しく往復する`,
        run.status === status
      )
    );

  }

  // ---- Test8: toApproval() — ApprovalはWorkに属する ----
  {
    const row: ApprovalRow = {
      id: "approval-1",
      work_id: "work-1",
      task_id: "task-1",
      requested_by_actor_kind: "ai",
      requested_by_actor_id: "tact-research",
      requested_from_actor_kind: "user",
      requested_from_actor_id: "user-1",
      status: "pending",
      reason: "外部SaaSへの書き込み前確認",
      payload: { type: "slack_post", preview: "..." },
      requested_at: "2026-09-05T00:00:00.000Z",
      responded_at: null,
      response: null,
      expires_at: null,
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const approval = toApproval(row);

    results.push(
      check(
        "[Test8] toApproval(): workIdを保持する(Approval belongs to Work)",
        approval.workId === "work-1"
      )
    );

    results.push(
      check(
        "[Test8] toApproval(): 型付きActor参照(requestedBy/requestedFrom)が正しく変換される",
        approval.requestedByActorKind === "ai" &&
          approval.requestedByActorId === "tact-research" &&
          approval.requestedFromActorKind === "user" &&
          approval.requestedFromActorId === "user-1"
      )
    );
  }

  // ---- Test9: toApproval() — 全ApprovalStatusが正しく往復する ----
  for (const status of APPROVAL_STATUSES) {

    const row: ApprovalRow = {
      id: `approval-${status}`,
      work_id: "work-1",
      task_id: null,
      requested_by_actor_kind: "system",
      requested_by_actor_id: "scheduler",
      requested_from_actor_kind: "user",
      requested_from_actor_id: "user-1",
      status,
      reason: "テスト",
      payload: {},
      requested_at: "2026-09-05T00:00:00.000Z",
      responded_at: null,
      response: null,
      expires_at: null,
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const approval = toApproval(row);

    results.push(
      check(
        `[Test9] toApproval(): status="${status}"が正しく往復する`,
        approval.status === status
      )
    );

  }

  return summarize("work/mapping", results);

}
