import {
  getWork,
  getApproval,
  listTasksForWork,
  listRunsForTask,
  createRun,
  completeRun,
  failRun,
  updateTaskStatus,
} from "../tact-work/store";
import { reconcileWorkCompletionStatus as defaultReconcileWorkCompletionStatus } from "../tact-work/completion";
import { executeIntegrationAction as defaultExecuteIntegrationAction } from "./gateway";
import { getConnection as defaultGetConnection } from "./connection";
import { resolveIntegrationActionPolicy } from "./policy";
import {
  buildApprovalSubject,
  verifyApprovalIntegrity,
  type ApprovalIntegrityCheck,
} from "../tact-work/approvalIntegrity";
import type { Approval, ApprovalStatus, Run, TaskStatus, WorkStatus } from "../tact-work/types";
import type { Connection, IntegrationAction, IntegrationService } from "./types";

// =========================
// TACT Integration — Execution Boundary
// (Architecture Migration Phase C1 / C2.2)
// =========================
//
// 唯一の正式なProtected Action実行境界。Bot/Webからは直接Composio
// Adapter/Integration Gatewayを呼ばせず、必ずこの
// executeApprovedIntegrationAction()(write)・executeReadIntegrationAction()
// (read、Phase C2.2新規)を経由させる(絶対条件、Phase C1指示Section17
// をread側にも継承)。
//
// write責務(Section17の順序通り、変更なし):
//   1. Work ownership確認 (getWork)
//   2. Approval ownership確認 (getApproval、Work経由のownership defense
//      をそのまま利用)
//   3. Approval status == approved確認
//   4. Workの実行可能state確認 (running)
//   5. action取得 (Approval.payloadから)
//   5.5. policy再検証 (Phase C2.2新規、defense-in-depth——未知/read
//        actionをApproval経由で実行させない)
//   6. Connection ownership確認 (getConnection)
//   6.5. Execution dedup確認 (Section21、既存completed Runの有無)
//   6.6. Task state precondition確認 (Phase C2.1c-a-fix)
//   7. Integration Gatewayへdispatch (generic core、下記)
//   8. Run lifecycle記録 (generic core、下記)
//   9. result返却
//
// read責務(Phase C2.2新規): Approvalを一切経由しない。呼び出し元
// (core/tact-work/execution.ts、resolveIntegrationConnection()で
// Connectionを解決済み)からcanonical action + connectionIdを直接
// 受け取り、この境界自身が改めてpolicy(riskClass==="read")・Work
// ownership・Connection ownershipを再検証してから実行する(絶対条件
// Section10: callerが「これはreadです」と言ったことを信用しない)。
//
// Run semantics(絶対条件、Section18、read/write共通): Approval待機
// 自体はRunではない。この境界が呼ばれ、実際にComposioへdispatchする
// 直前になって初めてRunを作る。
//
// Execution deduplication(絶対条件、Section21、write専用):
// 同じapprovalIdに対して既に成功済みのRunが存在する場合、Composioを
// 再度呼ばない。readはApproval(approvalId)を持たないため、この
// dedupの対象ではない——read側の安全性はTask precondition
// (pending以外からの新規実行を拒否する、generic coreが共通で持つ)
// とWork execution層(呼び出し元)が1 Turn内で同じTaskへ二重に
// read実行をキューしない設計で担保する。
//
// Protected-write retry safety(絶対条件、Section20、read/write共通):
// この境界自身も、Integration Gateway呼び出しの失敗に対して自動retry
// を一切行わない(1回だけ呼ぶ)。失敗時は既存のRun.status="failed"へ
// 落とすだけで、新しい"unknown"相当のstatusは追加しない。

export interface ExecuteApprovedIntegrationActionDeps {

  getWork: typeof getWork;

  getApproval: typeof getApproval;

  getConnection: typeof defaultGetConnection;

  // Architecture Migration Phase C2.1c-a-fix: 新規external execution
  // を開始する前に、Taskの現在stateがpendingであることを確認する
  // ためだけに使う(既存store APIの再利用、新しいDB queryを追加
  // しない)。単一Task取得APIがcore/tact-work/store.tsに存在しない
  // ため、listTasksForWork()から対象taskIdを絞り込む
  // (core/tact-work/completion.tsのreconcileWorkCompletionStatus()と
  // 同じ既存パターン)。
  listTasksForWork: typeof listTasksForWork;

  listRunsForTask: typeof listRunsForTask;

  createRun: typeof createRun;

  completeRun: typeof completeRun;

  failRun: typeof failRun;

  updateTaskStatus: typeof updateTaskStatus;

  executeIntegrationAction: typeof defaultExecuteIntegrationAction;

  // Architecture Migration Phase C2.1a(Work Completion Reconciliation、
  // architecture debt A解消)。Task状態確定後にWork全体の集約判定を
  // 行う共有責務。失敗してもこの境界の戻り値(既に確定したRun/Task
  // 状態)には影響させない(下記reconcileAfterTaskUpdate()参照)。
  reconcileWorkCompletionStatus: typeof defaultReconcileWorkCompletionStatus;

}

const defaultDeps: ExecuteApprovedIntegrationActionDeps = {
  getWork,
  getApproval,
  getConnection: defaultGetConnection,
  listTasksForWork,
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

// Architecture Migration ARCH-P1c: verifyApprovalIntegrity()の5値
// (docs/architecture/approval-integrity.mdのStep8で明示された
// missing_subject/unsupported_version/stored_subject_invalid/
// hash_mismatch/subject_mismatchという語彙に対応)から"match"を除いた
// ものを、そのままこの境界のinternal reasonとして再利用する
// (絶対条件、Step5: canonicalization/hash判定logicをここで再実装
// しない)。current_subject_invalidは、execution時点でcurrent
// ApprovalSubject自体の構築(buildApprovalSubject())が失敗した場合
// 専用の、この境界だけが持つ追加reason(stored側の異常と区別する)。
// いずれもcanonical statusとしては単一のapproval_integrity_failedへ
// 折り畳む(絶対条件Step8: statusを増やしすぎない)——Bot向けmapper
// (core/tact-bot/gateway/receiveApprovalDecision.ts)はreasonの詳細を
// 一切参照しない。
export type ApprovalIntegrityFailureReason =
  | Exclude<ApprovalIntegrityCheck["result"], "match">
  | "current_subject_invalid";

export type IntegrationActionExecutionOutcome =
  | { status: "not_found" }
  | { status: "approval_not_approved"; approvalStatus: ApprovalStatus }
  | { status: "work_not_runnable"; workStatus: WorkStatus }
  | { status: "connection_unavailable" }
  | { status: "invalid_action"; reason: string }
  | { status: "already_executed"; run: Run }
  // Architecture Migration ARCH-P1c(docs/architecture/approval-integrity.md):
  // Approval取得時点で承認された内容(stored subject)と、execution
  // 直前に再構築したcurrent subjectが一致しない場合の安全な停止。
  // provider call 0・Run作成0(絶対条件、Run="1回のexecution attempt"
  // という定義上、Integrity Gateで止まった時点ではattempt自体が
  // 開始されていない)。Approval.statusは変更しない
  // ("承認された事実"と"現在executionに使えるか"は別概念、
  // 同docs Step9)。reasonは内部診断専用——Bot向けmessageへは
  // 一切出さない(絶対条件Step8)。
  | { status: "approval_integrity_failed"; reason: ApprovalIntegrityFailureReason }
  // Architecture Migration Phase C2.1c-a-fix: 新規external execution
  // を開始できるTask stateはpendingだけである、というcanonical
  // precondition invariantを、この境界自身に持たせる(既存の
  // work_not_runnableと同じ命名規則)。dedup確認(already_executed)を
  // 通過した後、Taskがpending以外(completed/failed/cancelled/
  // running)であればここで安全に停止する。
  | { status: "task_not_executable"; taskStatus: TaskStatus }
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

// Architecture Migration Phase C2.2: read/write共通のConnection
// ownership再検証(既存のgetConnection()呼び出しをそのまま使う、
// 新しいDB queryを追加しない)。connectionIdは呼び出し元
// (Approval.payload、またはcore/tact-work/execution.tsが解決済みの
// resolveIntegrationConnection()の結果)から渡されるだけの値であり、
// この境界自身がownership/activeであることを必ず再確認する
// (絶対条件: connectionIdという文字列を信用しない)。
async function validateConnectionForExecution(
  connectionId: string,
  userId: string,
  accessToken: string,
  deps: Pick<ExecuteApprovedIntegrationActionDeps, "getConnection">
): Promise<{ ok: true; connection: Connection } | { ok: false; outcome: IntegrationActionExecutionOutcome }> {

  const connection = await deps.getConnection(connectionId, userId, accessToken);

  if (!connection || connection.status !== "active") {
    return { ok: false, outcome: { status: "connection_unavailable" } };
  }

  return { ok: true, connection };

}

// =========================
// Generic execution core (Architecture Migration Phase C2.2)
// =========================
//
// write(executeApprovedIntegrationAction())・read
// (executeReadIntegrationAction())の両方が、Connection ownership
// 確認・(write側のみ)dedup確認より後に共通で辿る実行本体。
// approvalIdはwriteの場合のみ渡され、Run.externalRefへの記録
// (dedup照合用)にのみ使う——read実行はこのapprovalId概念自体を
// 持たない(絶対条件: readのためにfake Approvalを作らない)。
interface ExecuteIntegrationActionCoreParams {

  workId: string;

  userId: string;

  accessToken: string;

  taskId: string;

  connection: Connection;

  action: IntegrationAction;

  approvalId?: string;

  // 呼び出し元(write)が既にdedup確認のためlistRunsForTask()を実行
  // 済みの場合、そのまま渡すことで同じDB queryを2回呼ばずに済む
  // (read側は未指定のままでよく、この関数自身が取得する)。
  existingRunsForTask?: Run[];

}

async function executeIntegrationActionCore(
  params: ExecuteIntegrationActionCoreParams,
  deps: ExecuteApprovedIntegrationActionDeps
): Promise<IntegrationActionExecutionOutcome> {

  const { workId, userId, accessToken, taskId, connection, action, approvalId } = params;

  // Architecture Migration Phase C2.1c-a-fix(絶対条件、read/write共通):
  // 新規external executionを開始できるTask stateはpendingだけである。
  // 単一Task取得APIが無いため、既存listTasksForWork()を再利用する
  // (新しいDB queryを追加しない)。
  const tasksForWork = await deps.listTasksForWork(workId, userId, accessToken);
  const task = tasksForWork.find((t) => t.id === taskId);

  if (!task) {
    return { status: "not_found" };
  }

  if (task.status !== "pending") {
    return { status: "task_not_executable", taskStatus: task.status };
  }

  const existingRuns = params.existingRunsForTask ?? (await deps.listRunsForTask(workId, userId, accessToken, taskId));

  const nextAttempt = existingRuns.reduce((max, run) => Math.max(max, run.attempt), 0) + 1;

  await deps.updateTaskStatus(workId, userId, accessToken, taskId, "running");

  const run = await deps.createRun(
    workId,
    userId,
    accessToken,
    taskId,
    {
      attempt: nextAttempt,
      capability: `integration.${action.service}.${action.operation}`,
      provider: connection.provider,
    }
  );

  if (!run) {
    return { status: "not_found" };
  }

  // Integration Gatewayへdispatch(絶対条件Section20: 1回だけ呼ぶ、
  // 自動retryしない)。
  const result = await deps.executeIntegrationAction({
    userId,
    workId,
    taskId,
    approvalId: approvalId ?? null,
    connectionId: connection.id,
    providerConnectionRef: connection.providerConnectionRef,
    action,
  });

  const externalRef: Record<string, unknown> = approvalId
    ? { approvalId, providerExecutionRef: null }
    : { providerExecutionRef: null };

  if (result.status === "completed") {

    externalRef.providerExecutionRef = result.providerExecutionRef ?? null;

    const completedResult = { success: true, output: JSON.stringify(result.output ?? null) };

    await deps.completeRun(workId, userId, accessToken, run.id, {
      result: completedResult,
      externalRef,
    });

    await deps.updateTaskStatus(workId, userId, accessToken, taskId, "completed");

    await reconcileAfterTaskUpdate(deps, workId, userId, accessToken);

    return {
      status: "completed",
      // Architecture Migration Phase C2.2: completeRun()へ渡したresult
      // (JSON.stringify()済みのcanonical output)を、戻り値のRunにも
      // そのまま反映する(既存のcreateRun()直後のin-memory runには
      // resultが含まれないため)。read呼び出し元(core/tact-conversation/
      // orchestration.ts)がrun.result.outputからcanonical read result
      // を取り出せるようにするための最小限の追加(write path自体の
      // 既存動作・戻り値shapeは変えない、Run.resultは元々optionalな
      // 既存field)。
      run: { ...run, status: "completed", externalRef, result: completedResult },
    };

  }

  externalRef.providerExecutionRef = result.providerExecutionRef ?? null;

  await deps.failRun(workId, userId, accessToken, run.id, {
    error: result.error.message,
    externalRef,
  });

  await deps.updateTaskStatus(workId, userId, accessToken, taskId, "failed");

  await reconcileAfterTaskUpdate(deps, workId, userId, accessToken);

  return {
    status: "failed",
    run: { ...run, status: "failed", error: result.error.message, externalRef },
  };

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

  // 5. action取得(Connection ownership確認より先に、まず形式検証)
  const extracted = extractIntegrationActionFromApproval(approval);

  if (!extracted) {
    return { status: "invalid_action", reason: "Approval.payloadからintegration actionを復元できません" };
  }

  // 5.5. Architecture Migration Phase C2.2(絶対条件、Section11、
  // defense-in-depth): Approvalが承認されたという事実だけでは
  // providerへ流してよい理由にならない——policy allowlistを
  // ここでも再検証する。未知action、またはriskClass==="read"の
  // actionがこのApproval経由の境界へ渡ってきた場合(通常到達しない
  // ——onTaskFinished()はrequiresApproval===trueのactionしか
  // Approvalへ積まないため)は、providerへ一切流さず安全に拒否する。
  const policy = resolveIntegrationActionPolicy(extracted.action.service, extracted.action.operation);

  if (!policy || policy.riskClass === "read") {
    return {
      status: "invalid_action",
      reason: "この操作はApproval経由の実行対象として登録されていません",
    };
  }

  // 6. Connection ownership確認
  const connectionValidation = await validateConnectionForExecution(
    extracted.connectionId,
    userId,
    accessToken,
    deps
  );

  if (!connectionValidation.ok) {
    return connectionValidation.outcome;
  }

  const taskId = approval.taskId;

  // Execution deduplication(絶対条件、Section21): 既にこのapprovalId
  // で成功済みのRunがあれば、Composioを再度呼ばずそれを返す。
  const existingRuns = await deps.listRunsForTask(workId, userId, accessToken, taskId);
  const alreadyExecuted = findAlreadyExecutedRun(existingRuns, approvalId);

  if (alreadyExecuted) {

    // Architecture Migration ARCH-P1c(絶対条件、Step2/11): dedup
    // 判定はApproval Integrity検証より必ず先に行う。既にexternal side
    // effectが成功済みのApprovalについては、以後どれだけsubjectが
    // (将来のバグ等で)ずれて見えても、それは「既に起きた事実の報告」
    // でしかなく、Integrity検証の対象ではない——ここでmismatch
    // 判定へ進めてしまうと、成功済みのalready_executed応答を誤って
    // 上書きしてしまう(docs/architecture/approval-integrity.md
    // Step11 Case4の結論をそのまま実装する)。
    return { status: "already_executed", run: alreadyExecuted };

  }

  // 6.6. Architecture Migration ARCH-P1c: Approval Integrity検証
  // (docs/architecture/approval-integrity.md)。Provider dispatch・Run
  // 作成のいずれよりも前に、承認された時点のcanonical subject
  // (Approval.subject*列)と、execution直前に再構築したcurrent
  // subjectが一致することを確認する。
  //
  // 絶対条件(Step5): canonicalization/hash判定logic自体はcore/tact-work/
  // approvalIntegrity.tsのbuildApprovalSubject()/verifyApprovalIntegrity()
  // をそのまま再利用する——この境界・Provider Adapterのいずれにも
  // 判定logicを複製しない。
  //
  // riskClassSnapshot(絶対条件Step6): 「stored」側はApproval作成時点の
  // snapshot、「current」側は直前(5.5)で再評価済みのpolicy.riskClass
  // そのもの(再度policyを呼び直さない、同じ結果を再利用するだけ)。
  // Canonical action自体は同一でもriskClassが変化していれば
  // (例: write→destructive)、古いApprovalをそのまま使わせず
  // mismatchとして拒否する——現在のPolicyがDENY相当(このリスク
  // クラスの操作を許可しない)であれば、この5.5の時点で既に
  // invalid_actionへ倒れているため、Approvalが現在のPolicy DENYを
  // 上書きすることは無い。
  const currentSubjectResult = buildApprovalSubject({
    workId: work.id,
    taskId: approval.taskId,
    service: extracted.action.service,
    operation: extracted.action.operation,
    input: extracted.action.input,
    connectionId: extracted.connectionId,
    riskClassSnapshot: policy.riskClass,
  });

  if (!currentSubjectResult.ok) {

    // execution時点でcurrent subject自体を構築できない(通常到達
    // しない——Approval.payloadは作成時点で既に一度buildApprovalSubject()
    // を通過済みのはずだが、raw JSONBからの再抽出は型検証のみで
    // schema検証までは行わないため、防御的にfail closedする)。
    return { status: "approval_integrity_failed", reason: "current_subject_invalid" };

  }

  const integrityCheck = verifyApprovalIntegrity(
    {
      version: approval.subjectVersion ?? null,
      json: approval.subject ?? null,
      hash: approval.subjectHash ?? null,
    },
    currentSubjectResult.subject
  );

  if (integrityCheck.result !== "match") {

    // 絶対条件(Step4、Step10): subject evidence無し(ARCH-P1b以前の
    // legacy protected Approval含む)・改ざん・不一致のいずれでも
    // fail closedする。Run作成0・provider call 0
    // (executeIntegrationActionCore()より前でreturnするため構造的に
    // 保証される)。Approval.statusは一切変更しない(承認された事実と
    // 現在executionに使えるかは別概念、同docs Step9)。
    return { status: "approval_integrity_failed", reason: integrityCheck.result };

  }

  return executeIntegrationActionCore(
    {
      workId,
      userId,
      accessToken,
      taskId,
      connection: connectionValidation.connection,
      action: extracted.action,
      approvalId,
      existingRunsForTask: existingRuns,
    },
    deps
  );

}

// =========================
// executeReadIntegrationAction (Architecture Migration Phase C2.2)
// =========================
//
// Approval不要read用のcanonical public boundary。呼び出し元
// (core/tact-work/execution.tsのrunWorkTurn())が「これはreadです」
// と主張しても信用せず、この境界自身がpolicy(riskClass==="read")を
// 必ず再検証する(絶対条件Section10)。write/destructive/未知action
// が渡された場合は、provider呼び出し0・Run作成0のまま安全に拒否する
// (defense-in-depth)。
export interface ExecuteReadIntegrationActionParams {

  workId: string;

  userId: string;

  accessToken: string;

  taskId: string;

  // core/tact-work/execution.ts側のresolveIntegrationConnection()
  // (既存C2.1bの仕組み、single解決時のみ)が既に解決済みの値。
  connectionId: string;

  action: IntegrationAction;

}

export async function executeReadIntegrationAction(
  params: ExecuteReadIntegrationActionParams,
  deps: ExecuteApprovedIntegrationActionDeps = defaultDeps
): Promise<IntegrationActionExecutionOutcome> {

  const { workId, userId, accessToken, taskId, connectionId, action } = params;

  // 絶対条件(Section10、最重要): callerがreadだと言ったから信用する、
  // は禁止。policy allowlistを必ずここで再検証する。
  const policy = resolveIntegrationActionPolicy(action.service, action.operation);

  if (!policy || policy.riskClass !== "read") {
    return {
      status: "invalid_action",
      reason: "この操作はread実行境界の対象として登録されていません",
    };
  }

  // Work ownership + 実行可能state確認(write pathと同じ既存ガードを
  // read側にも独立して適用する——呼び出し元が検証済みのWorkを持って
  // いても、この境界自身が再確認する)。
  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { status: "not_found" };
  }

  if (work.status !== "running") {
    return { status: "work_not_runnable", workStatus: work.status };
  }

  const connectionValidation = await validateConnectionForExecution(
    connectionId,
    userId,
    accessToken,
    deps
  );

  if (!connectionValidation.ok) {
    return connectionValidation.outcome;
  }

  return executeIntegrationActionCore(
    {
      workId,
      userId,
      accessToken,
      taskId,
      connection: connectionValidation.connection,
      action,
      // approvalIdなし(read実行はApprovalを一切経由しない、絶対条件)。
    },
    deps
  );

}
