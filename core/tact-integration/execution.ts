import {
  getWork,
  getApproval,
  listRunsForTask,
  createRun,
  completeRun,
  failRun,
  updateTaskStatus,
} from "../tact-work/store";
import { reconcileWorkCompletionStatus as defaultReconcileWorkCompletionStatus } from "../tact-work/completion";
import { executeIntegrationAction as defaultExecuteIntegrationAction } from "./gateway";
import { getConnection as defaultGetConnection } from "./connection";
import type { Approval, ApprovalStatus, Run, WorkStatus } from "../tact-work/types";
import type { IntegrationAction, IntegrationService } from "./types";

// =========================
// TACT Integration — Execution Boundary (Architecture Migration Phase C1)
// =========================
//
// 唯一の正式なProtected Action実行境界。Bot/Webからは直接Composio
// Adapter/Integration Gatewayを呼ばせず、必ずこの
// executeApprovedIntegrationAction()を経由させる(絶対条件、
// Phase C1指示Section17)。
//
// 責務(Section17の順序通り):
//   1. Work ownership確認 (getWork)
//   2. Approval ownership確認 (getApproval、Work経由のownership defense
//      をそのまま利用)
//   3. Approval status == approved確認
//   4. Workの実行可能state確認 (running)
//   5. Connection ownership確認 (getConnection)
//   6. action取得 (Approval.payloadから)
//   7. Integration Gatewayへdispatch
//   8. Run lifecycle記録
//   9. result返却
//
// Run semantics(絶対条件、Section18): Approval待機自体はRunでは
// ない。このboundaryが呼ばれ、実際にComposioへdispatchする直前に
// なって初めてRunを作る。
//
// Execution deduplication(絶対条件、Section21): 同じapprovalIdに
// 対して既に成功済みのRunが存在する場合、Composioを再度呼ばない
// (double click/network retry/duplicate resume requestへの対策)。
// 新しいdistributed transaction systemは作らず、既存のRun.externalRef
// (jsonb、スキーマ変更不要)へapprovalIdを記録して照合するだけに
// とどめる。
//
// Protected-write retry safety(絶対条件、Section20): このboundary
// 自身も、Integration Gateway呼び出しの失敗に対して自動retryを一切
// 行わない(1回だけ呼ぶ)。失敗時は既存のRun.status="failed"へ
// 落とすだけで、新しい"unknown"相当のstatusは追加しない。

export interface ExecuteApprovedIntegrationActionDeps {

  getWork: typeof getWork;

  getApproval: typeof getApproval;

  getConnection: typeof defaultGetConnection;

  listRunsForTask: typeof listRunsForTask;

  createRun: typeof createRun;

  completeRun: typeof completeRun;

  failRun: typeof failRun;

  updateTaskStatus: typeof updateTaskStatus;

  executeIntegrationAction: typeof defaultExecuteIntegrationAction;

  // Architecture Migration Phase C2.1a(Work Completion Reconciliation、
  // architecture debt A解消)。Task状態確定後にWork全体の集約判定を
  // 行う共有責務。失敗してもこのboundaryの戻り値(既に確定した
  // Run/Task状態)には影響させない(下記reconcileAfterTaskUpdate()
  // 参照)。
  reconcileWorkCompletionStatus: typeof defaultReconcileWorkCompletionStatus;

}

const defaultDeps: ExecuteApprovedIntegrationActionDeps = {
  getWork,
  getApproval,
  getConnection: defaultGetConnection,
  listRunsForTask,
  createRun,
  completeRun,
  failRun,
  updateTaskStatus,
  executeIntegrationAction: defaultExecuteIntegrationAction,
  reconcileWorkCompletionStatus: defaultReconcileWorkCompletionStatus,
};

// 絶対条件(Phase C2.1a指示、最重要): reconciliation自体が失敗しても、
// 既に確定した外部side effect(Composio/Slack実行結果)やRun/Task状態を
// 「実行失敗」「retry可能」に見せかけてはいけない。Run.status/Task.
// statusは既にcompleteRun()/failRun()/updateTaskStatus()で確定済みで
// あり、reconciliationはその後の「Work全体の集計」でしかない。この
// 関数は例外を外へ伝播させず、失敗時はconsole.warnで内部ログに残す
// だけにとどめる(既存core/codeAgent/store.ts等と同じ「非致命的な
// 副次処理はconsole.warnでbest-effort化する」既存パターンを踏襲)。
async function reconcileAfterTaskUpdate(
  deps: ExecuteApprovedIntegrationActionDeps,
  workId: string,
  userId: string,
  accessToken: string
): Promise<void> {

  try {

    await deps.reconcileWorkCompletionStatus(workId, userId, accessToken);

  } catch (error) {

    console.warn(
      "[tact-integration/execution] reconcileWorkCompletionStatus() failed after protected action execution; " +
      "Run/Task状態は既に確定済みのため、この内部集計の失敗によってexternal side effectの成否判定は変更しない。",
      error
    );

  }

}

export type IntegrationActionExecutionOutcome =
  | { status: "not_found" }
  | { status: "approval_not_approved"; approvalStatus: ApprovalStatus }
  | { status: "work_not_runnable"; workStatus: WorkStatus }
  | { status: "connection_unavailable" }
  | { status: "invalid_action"; reason: string }
  | { status: "already_executed"; run: Run }
  | { status: "completed"; run: Run }
  | { status: "failed"; run: Run };

// Approval.payload(core/tact-work/approval.tsのtoApprovalPayload()が
// {scope, action: {kind, summary, metadata: {service, operation,
// input, connectionId}}, ...metadata}という形で組み立てたもの)から、
// 実行に必要なCanonical Actionを安全に取り出す。想定外の形式でも
// 例外を投げず、undefinedを返すだけにとどめる(防御的)。
function extractIntegrationActionFromApproval(
  approval: Approval
): { action: IntegrationAction; connectionId: string } | undefined {

  const payload = approval.payload;
  const rawAction = payload?.action;

  if (!rawAction || typeof rawAction !== "object") {
    return undefined;
  }

  const metadata = (rawAction as { metadata?: unknown }).metadata;

  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const { service, operation, input, connectionId } = metadata as Record<string, unknown>;

  if (
    typeof service !== "string" ||
    typeof operation !== "string" ||
    typeof connectionId !== "string" ||
    !input ||
    typeof input !== "object"
  ) {
    return undefined;
  }

  return {
    action: {
      service: service as IntegrationService,
      operation,
      input: input as Record<string, unknown>,
    },
    connectionId,
  };

}

function findAlreadyExecutedRun(runs: Run[], approvalId: string): Run | undefined {

  return runs.find(
    (run) =>
      run.status === "completed" &&
      typeof run.externalRef === "object" &&
      run.externalRef !== null &&
      (run.externalRef as Record<string, unknown>).approvalId === approvalId
  );

}

export async function executeApprovedIntegrationAction(
  workId: string,
  userId: string,
  accessToken: string,
  approvalId: string,
  deps: ExecuteApprovedIntegrationActionDeps = defaultDeps
): Promise<IntegrationActionExecutionOutcome> {

  // 1. Work ownership確認
  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { status: "not_found" };
  }

  // 2. Approval ownership確認(getApproval()自体がWork ownershipを
  // 再確認する、既存のWorkOwnershipDeps)
  const approval = await deps.getApproval(workId, userId, accessToken, approvalId);

  if (!approval || !approval.taskId) {
    return { status: "not_found" };
  }

  // 3. Approval status == approved確認
  if (approval.status !== "approved") {
    return { status: "approval_not_approved", approvalStatus: approval.status };
  }

  // 4. Workの実行可能state確認。approveApproval()はWorkに他の
  // pending Approvalが残っていなければ"running"へ戻す
  // (core/tact-work/approval.ts)。それ以外の状態(waiting_for_approval
  // のまま=他のApprovalが残っている、または既にterminal)からは
  // 実行させない。
  if (work.status !== "running") {
    return { status: "work_not_runnable", workStatus: work.status };
  }

  // 6. action取得(Connection ownership確認より先に、まず形式検証)
  const extracted = extractIntegrationActionFromApproval(approval);

  if (!extracted) {
    return { status: "invalid_action", reason: "Approval.payloadからintegration actionを復元できません" };
  }

  // 5. Connection ownership確認
  const connection = await deps.getConnection(extracted.connectionId, userId, accessToken);

  if (!connection || connection.status !== "active") {
    return { status: "connection_unavailable" };
  }

  const taskId = approval.taskId;

  // Execution deduplication(絶対条件、Section21): 既にこのapprovalId
  // で成功済みのRunがあれば、Composioを再度呼ばずそれを返す。
  const existingRuns = await deps.listRunsForTask(workId, userId, accessToken, taskId);
  const alreadyExecuted = findAlreadyExecutedRun(existingRuns, approvalId);

  if (alreadyExecuted) {
    return { status: "already_executed", run: alreadyExecuted };
  }

  const nextAttempt =
    existingRuns.reduce((max, run) => Math.max(max, run.attempt), 0) + 1;

  await deps.updateTaskStatus(workId, userId, accessToken, taskId, "running");

  const run = await deps.createRun(
    workId,
    userId,
    accessToken,
    taskId,
    {
      attempt: nextAttempt,
      capability: `integration.${extracted.action.service}.${extracted.action.operation}`,
      provider: connection.provider,
    }
  );

  if (!run) {
    return { status: "not_found" };
  }

  // 7. Integration Gatewayへdispatch、9. Composio execute
  // (絶対条件Section20: 1回だけ呼ぶ、自動retryしない)
  const result = await deps.executeIntegrationAction({
    userId,
    workId,
    taskId,
    approvalId,
    connectionId: connection.id,
    providerConnectionRef: connection.providerConnectionRef,
    action: extracted.action,
  });

  // 8. Run lifecycle記録
  if (result.status === "completed") {

    await deps.completeRun(workId, userId, accessToken, run.id, {
      result: { success: true, output: JSON.stringify(result.output ?? null) },
      externalRef: { approvalId, providerExecutionRef: result.providerExecutionRef ?? null },
    });

    await deps.updateTaskStatus(workId, userId, accessToken, taskId, "completed");

    // Architecture Migration Phase C2.1a: Run/Taskが確定した後に
    // Work全体の集約判定を行う。この呼び出し自体が失敗しても、既に
    // 確定した"completed"という結果は変更しない(reconcileAfter
    // TaskUpdate()参照)。
    await reconcileAfterTaskUpdate(deps, workId, userId, accessToken);

    return {
      status: "completed",
      run: { ...run, status: "completed", externalRef: { approvalId, providerExecutionRef: result.providerExecutionRef ?? null } },
    };

  }

  await deps.failRun(workId, userId, accessToken, run.id, {
    error: result.error.message,
    externalRef: { approvalId, providerExecutionRef: result.providerExecutionRef ?? null },
  });

  await deps.updateTaskStatus(workId, userId, accessToken, taskId, "failed");

  // Architecture Migration Phase C2.1a: 失敗時も同様に、Run/Taskが
  // 確定した後にWork全体の集約判定を行う。
  await reconcileAfterTaskUpdate(deps, workId, userId, accessToken);

  return {
    status: "failed",
    run: { ...run, status: "failed", error: result.error.message, externalRef: { approvalId, providerExecutionRef: result.providerExecutionRef ?? null } },
  };

}
