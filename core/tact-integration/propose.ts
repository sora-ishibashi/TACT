import { createTask } from "../tact-work/store";
import { requestApproval } from "../tact-work/approval";
import type { ActorReference, Approval } from "../tact-work/types";
import type { IntegrationAction } from "./types";

// =========================
// TACT Integration — Propose (Architecture Migration Phase C1)
// =========================
//
// Protected side effectの正しい順序(Phase C1絶対条件、Section15):
//
//   1. Slack send proposalを作る (このfile)
//   2. Approvalをrequest (このfile、core/tact-work/approval.tsを再利用)
//   3. Work -> waiting_for_approval (requestApproval()自体が行う)
//   4. Human approve (core/tact-work/approval.tsのapproveApproval())
//   5. Work -> running (同上)
//   6. approved Approvalからprotected actionを取得 (execution.ts)
//   7. Integration Gatewayへ渡す (execution.ts)
//   8. Run作成 (execution.ts)
//   9. Composio execute (execution.ts → gateway.ts → providers/composio)
//   10. Run complete / fail (execution.ts)
//
// このfileはこのうち1〜2だけを担う。Composio(や他のProvider)への
// 呼び出しはここでは一切発生しない——「Composio executeの結果として
// 初めてapprovalRequirementが判明する」設計を明示的に禁止する
// (Phase C1絶対条件、外部write実行後に初めてApproval requirementが
// 判明する設計は禁止)。
//
// Approval.taskIdを常に設定する(絶対条件): 後続のexecution
// boundary(execution.ts)がRunを作るためには必ずWorkTaskが必要
// (tact_tasks.task_idはNOT NULL)。scope="action"のApprovalであっても、
// 実行の入れ物としてTaskを1件作っておくことで、「taskIdが無い
// Approvalを実行時にどう扱うか」という曖昧さを構造的に無くす。

export interface ProposeIntegrationActionParams {

  workId: string;

  // TACT Canonical Connection.id(core/tact-integration/connection.ts)。
  connectionId: string;

  action: IntegrationAction;

  // 人間が読める短い要約(Approval.reason / BotRequestApprovalAction
  // 双方の表示に使われる)。
  summary: string;

  reason: string;

  // このactionを提案した主体。Capability実行結果由来なら
  // {kind:"ai", id:<capability名>}、将来Work Router由来なら
  // {kind:"system", id:"work-router"}等、呼び出し元が決める
  // (このfile自体は判断しない)。
  requestedByActor: ActorReference;

}

export interface ProposeIntegrationActionDeps {

  createTask: typeof createTask;

  requestApproval: typeof requestApproval;

}

const defaultDeps: ProposeIntegrationActionDeps = {
  createTask,
  requestApproval,
};

export async function proposeIntegrationAction(
  params: ProposeIntegrationActionParams,
  userId: string,
  accessToken: string,
  deps: ProposeIntegrationActionDeps = defaultDeps
): Promise<Approval | undefined> {

  const task = await deps.createTask(
    params.workId,
    userId,
    accessToken,
    {
      description: params.summary,
      // Capability Registryへ実際に登録された名前ではなく、
      // 「このTaskがどのIntegration actionのためのものか」を示す
      // 記述的な文字列(Orchestratorのdecompose対象にはならない、
      // Work Model上の記録用途のみ)。
      assignedCapability: `integration.${params.action.service}.${params.action.operation}`,
    }
  );

  if (!task) {
    // Work ownershipが解決できない(他user所有のworkId等)。
    return undefined;
  }

  return deps.requestApproval(
    {
      workId: params.workId,
      taskId: task.id,
      scope: "action",
      requestedByActor: params.requestedByActor,
      requestedFromActor: { kind: "user", id: userId },
      reason: params.reason,
      action: {
        kind: "integration_action",
        summary: params.summary,
        // Phase C1指示Section16: Approval payload/action descriptorを
        // 再利用し、承認後に同じprotected actionを安全に実行できる
        // だけの情報(service/operation/input/connectionId)だけを
        // 保存する。secret/token/Composio credentialは一切含めない
        // (このmetadata自体がProvider非依存のCanonical Action
        // そのものであり、Composio固有の値は含まれ得ない)。
        metadata: {
          service: params.action.service,
          operation: params.action.operation,
          input: params.action.input,
          connectionId: params.connectionId,
        },
      },
    },
    userId,
    accessToken
  );

}
