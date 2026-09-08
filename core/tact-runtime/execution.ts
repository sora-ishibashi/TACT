// =========================
// TACT Runtime — Trusted Runtime Execution Boundary
// (Fast Port P5c: Route One Non-Side-Effecting Integration Read
// Through Trigger.dev)
// =========================
//
// Trigger.dev task(trigger/integrationRead.ts)から呼ばれる、唯一の
// trusted entrypoint。責務(ユーザー指示 Step P5c回答、最重要):
//   - Supabase server-side credentialはTrigger.dev自身のEnvironment
//     Secret(このprocessのenv)からのみ解決する。payload自体には
//     credentialを一切含めない。
//   - 汎用store APIをTrigger taskから直接乱用させない——この狭い
//     entrypointだけを公開する。
//   - Run/Work/Task/action correlationを必ず再検証する(payloadの
//     主張を信用しない、trustedConversationTurn.tsと同じ設計原則)。
//   - 将来はshort-lived scoped execution tokenへ置換可能な境界を
//     維持する(credential解決を関数1つに閉じ込めているため、
//     将来この関数の中身だけを差し替えられる)。
//
// core/database/supabaseServiceRole.tsのallowlist comment(このfile
// を追加済み)が示す通り、TACT内でservice role keyを扱うことが
// 許可された数少ないfileの1つ。
import { getServiceRoleKey } from "../database/supabaseServiceRole";
import {
  executeRuntimeIntegrationRead,
  type ExecuteRuntimeIntegrationReadParams,
} from "../tact-integration/execution";
import type { IntegrationActionExecutionOutcome } from "../tact-integration/execution";

export interface RuntimeIntegrationReadTaskPayload {
  userId: string;
  workId: string;
  taskId: string;
  runId: string;
  action: {
    service: string;
    operation: string;
    connectionId: string;
  };
}

// Trigger.dev taskへ返す、safeに正規化された結果。
// IntegrationActionExecutionOutcomeをそのまま返さない——Trigger.dev
// task自身の戻り値はTrigger.devのdashboard/API(runs.retrieve()等)へ
// 永続化されるため、raw Run object(result/error文字列全文等)を
// そのまま外へ出さない、最小限のstatusだけに正規化する
// (絶対条件、Step14 Result transportの精神をここにも適用)。
export type RuntimeIntegrationReadTaskResult =
  | { ok: true; status: "completed" }
  | { ok: false; status: "failed" | "not_found" | "invalid" };

function normalizeOutcome(outcome: IntegrationActionExecutionOutcome): RuntimeIntegrationReadTaskResult {

  switch (outcome.status) {

    case "completed":
      return { ok: true, status: "completed" };

    case "failed":
      return { ok: false, status: "failed" };

    case "not_found":
    case "already_executed":
      return { ok: false, status: "not_found" };

    default:
      // work_not_runnable/connection_unavailable/invalid_action/
      // task_not_executable/approval_integrity_failed(read pathには
      // 到達しないがtypeとしては存在する)は、Trigger.dev task側から
      // 見ればいずれも「実行できなかった」で一律扱う(絶対条件:
      // 内部reason詳細をこの境界の外へ出さない、既存Bot boundary
      // (receiveApprovalDecision.ts)と同じ規律)。
      return { ok: false, status: "invalid" };

  }

}

// service role credentialが未設定の環境(dev/test等)向けの安全な
// fail closed outcome。例外を投げない——Trigger.dev task側が
// normalized resultとして扱えるようにする。
function serviceRoleUnavailableResult(): RuntimeIntegrationReadTaskResult {
  return { ok: false, status: "invalid" };
}

export async function executeRuntimeIntegrationReadTask(
  payload: RuntimeIntegrationReadTaskPayload
): Promise<RuntimeIntegrationReadTaskResult> {

  const serviceRoleKey = getServiceRoleKey();

  if (!serviceRoleKey) {

    console.warn(
      "[tact-runtime/execution] executeRuntimeIntegrationReadTask(): " +
      "SUPABASE_SERVICE_ROLE_KEYが未設定のため実行できません(secretを" +
      "ログには出力しない、設定有無のみを警告する)。"
    );

    return serviceRoleUnavailableResult();

  }

  // 絶対条件(Step19、二重ゲート): このfile自身はcore/tact-integration/
  // types.tsのIntegrationServiceをimportしない(provider-neutralな
  // payload型のまま受け取る)。ここでliteral値と比較することで、
  // 以降executeRuntimeIntegrationRead()(側でもisRuntimeEligible
  // IntegrationAction()により再チェックされる)へ渡すactionの
  // serviceを安全に絞り込む——"slack"以外は即座にinvalidとして拒否する。
  if (payload.action.service !== "slack") {
    return { ok: false, status: "invalid" };
  }

  const params: ExecuteRuntimeIntegrationReadParams = {
    workId: payload.workId,
    userId: payload.userId,
    accessToken: serviceRoleKey,
    taskId: payload.taskId,
    runId: payload.runId,
    connectionId: payload.action.connectionId,
    action: { service: payload.action.service, operation: payload.action.operation, input: {} },
  };

  const outcome = await executeRuntimeIntegrationRead(params);

  return normalizeOutcome(outcome);

}
