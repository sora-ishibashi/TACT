// =========================
// Trigger.dev Task — Integration Read (slack.list_channels)
// (Fast Port P5c: Route One Non-Side-Effecting Integration Read
// Through Trigger.dev)
// =========================
//
// このtaskはTACT canonical stateを一切所有しない(絶対条件、
// Canonical invariants 1-20)。責務は最小限(Step5):
//   1. payload shapeのvalidation
//   2. execution correlationの確認(schemaVersion/kindのみ、実際の
//      Work/Task/Run/action correlation再検証はcore/tact-runtime/
//      execution.tsのexecuteRuntimeIntegrationReadTask()が行う)
//   3. TACT-owned trusted execution function(同上)の呼び出し
//   4. normalized resultの返却
//
// このtaskがやらないこと(Step5絶対条件): createRun・Work/Task
// update・Approval判断・Clarification解決・直接Audit書き込み・
// 任意providerの選択・runtime retryによるside effect実行。
//
// allowlist(Step19絶対条件、二重ゲート): service==="slack" &&
// operation==="list_channels"以外は即座に拒否する
// (core/tact-integration/execution.tsのisRuntimeEligibleIntegrationAction()
// でも再チェックされるが、このtask自身もgeneral-purpose remote
// executorにならないよう独立して確認する)。
//
// retry設定(Step14/15絶対条件): まず1回のhandoffを証明することが
// P5cの目的であり、side-effectful操作の無条件retryは危険なため、
// maxAttempts:1(自動retryなし)を明示する。将来Trigger.dev内部retryを
// 使う場合はidempotency key設計とセットで再検討する(P5d debt)。
import { task } from "@trigger.dev/sdk";
import { executeRuntimeIntegrationReadTask } from "../core/tact-runtime/execution";
import { isRuntimeEligibleIntegrationAction } from "../core/tact-integration/execution";

interface IntegrationReadTaskPayload {
  schemaVersion: number;
  kind: string;
  userId: string;
  workId: string;
  taskId: string;
  runId: string;
  correlationId?: string | null;
  action: {
    service: string;
    operation: string;
    connectionId: string;
  };
}

export const tactIntegrationAction = task({

  id: "tact-integration-action",

  retry: { maxAttempts: 1 },

  run: async (payload: IntegrationReadTaskPayload) => {

    if (payload.schemaVersion !== 1 || payload.kind !== "integration_action") {
      return { ok: false, status: "invalid" as const };
    }

    if (!isRuntimeEligibleIntegrationAction(payload.action.service, payload.action.operation)) {
      return { ok: false, status: "invalid" as const };
    }

    return executeRuntimeIntegrationReadTask({
      userId: payload.userId,
      workId: payload.workId,
      taskId: payload.taskId,
      runId: payload.runId,
      action: payload.action,
    });

  },

});
