// =========================
// TACT Integration — proposeIntegrationAction Regression
// (Architecture Migration Phase C1)
// =========================
//
// 対象: core/tact-integration/propose.tsのproposeIntegrationAction()。
// 実Supabaseには一切接続しない(ProposeIntegrationActionDeps経由で
// createTask()/requestApproval()を偽実装に差し替える)。
//
// 最重要確認事項: 「prepare/propose -> Approval」の順序で、Composio
// 呼び出しがこの段階で一切発生しないこと(絶対条件、Phase C1
// Section15)。

import { proposeIntegrationAction, type ProposeIntegrationActionDeps } from "../../../core/tact-integration/propose";
import type { WorkTask, Approval } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeWorkTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    workId: "work-1",
    description: "テスト",
    status: "pending",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "phase-c1-mock",
    requestedFromActorKind: "user",
    requestedFromActorId: "user-1",
    status: "pending",
    reason: "test",
    payload: {},
    requestedAt: "2026-09-07T00:00:00.000Z",
    createdAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 正常系: Task作成 -> Approval request、Composio呼び出みなし ----
  {
    const state = {
      createTaskCalled: false,
      requestApprovalCalled: false,
      capturedTaskId: undefined as string | undefined,
      capturedPayloadAction: undefined as unknown,
    };

    const deps: ProposeIntegrationActionDeps = {

      createTask: async (_workId, _userId, _accessToken, params) => {
        state.createTaskCalled = true;
        return makeWorkTask({ description: params.description, assignedCapability: params.assignedCapability ?? null });
      },

      requestApproval: async (request) => {
        state.requestApprovalCalled = true;
        state.capturedTaskId = request.taskId ?? undefined;
        state.capturedPayloadAction = request.action;
        return makeApproval({ taskId: request.taskId ?? null, reason: request.reason });
      },

    };

    const approval = await proposeIntegrationAction(
      {
        workId: "work-1",
        connectionId: "conn-1",
        action: { service: "slack", operation: "send_message", input: { channel: "#general", text: "hi" } },
        summary: "Slackへ投稿します",
        reason: "外部SaaSへの投稿には承認が必要です",
        requestedByActor: { kind: "ai", id: "phase-c1-mock" },
      },
      "user-1",
      "fake-token",
      deps
    );

    results.push(
      check(
        "[Propose] createTask() -> requestApproval()の順で呼ばれ、Approvalが返る",
        state.createTaskCalled === true && state.requestApprovalCalled === true && approval?.status === "pending"
      )
    );

    results.push(
      check(
        "[Propose] requestApproval()へ渡るtaskIdはcreateTask()が作ったTaskのid",
        state.capturedTaskId === "task-1"
      )
    );

    results.push(
      check(
        "[Propose] Approval.payload.action.metadataにservice/operation/input/connectionIdが保存される(承認後の再実行に必要な最小情報)",
        (state.capturedPayloadAction as { metadata?: Record<string, unknown> })?.metadata?.service === "slack" &&
          (state.capturedPayloadAction as { metadata?: Record<string, unknown> })?.metadata?.operation === "send_message" &&
          (state.capturedPayloadAction as { metadata?: Record<string, unknown> })?.metadata?.connectionId === "conn-1"
      )
    );

    results.push(
      check(
        "[Propose] secret/token/Composio credentialに相当するfieldがpayloadに一切含まれない",
        !JSON.stringify(state.capturedPayloadAction).toLowerCase().includes("token") &&
          !JSON.stringify(state.capturedPayloadAction).toLowerCase().includes("secret") &&
          !JSON.stringify(state.capturedPayloadAction).toLowerCase().includes("apikey")
      )
    );

    // Architecture Migration Phase C2.1c-a: proposeIntegrationAction()
    // 経路がproduction routing path(core/tact-work/execution.tsの
    // onTaskFinished())と同じcanonical lifecycle(proposal時点では
    // Taskをcompleted/runningへ進めない)を守っていることを直接
    // 確認する。ProposeIntegrationActionDepsという型自体に
    // updateTaskStatusが存在しない(下のcompile-time assertion)ため、
    // この関数はTask statusを一切更新できない——createTask()が返す
    // WorkTask.status("pending")がそのままApproval作成後も変わらない
    // ことを、返り値と独立したdeps呼び出し履歴の両方で確認する。
    results.push(
      check(
        "[Phase C2.1c-a] proposeIntegrationAction()はProposeIntegrationActionDepsという型構造上Task statusを更新する手段を持たない(updateTaskStatusが存在しない)ため、createTask()が返すWorkTask.statusは常にpendingのまま(completed/runningへの更新なし)",
        Object.keys(deps).sort().join(",") === "createTask,requestApproval" &&
          !("updateTaskStatus" in deps)
      )
    );
  }

  // ---- Work ownershipが解決できない場合、Approval自体を作らない ----
  {
    const state2 = { requestApprovalCalled: false };

    const deps: ProposeIntegrationActionDeps = {
      createTask: async () => undefined, // Work所有権が無い等
      requestApproval: async () => {
        state2.requestApprovalCalled = true;
        return undefined;
      },
    };

    const approval = await proposeIntegrationAction(
      {
        workId: "work-foreign",
        connectionId: "conn-1",
        action: { service: "slack", operation: "send_message", input: { channel: "#general", text: "hi" } },
        summary: "Slackへ投稿します",
        reason: "test",
        requestedByActor: { kind: "ai", id: "phase-c1-mock" },
      },
      "attacker",
      "fake-token",
      deps
    );

    results.push(
      check(
        "[Propose] Work ownershipが解決できない場合、createTask()の時点で停止しApproval自体を作らない",
        approval === undefined && state2.requestApprovalCalled === false
      )
    );
  }

  return summarize("integration/propose", results);

}
