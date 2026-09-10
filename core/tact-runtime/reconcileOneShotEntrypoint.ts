// =========================
// TACT Runtime — One-Shot Reconciliation Entrypoint
// (Fast Port P5d: Add Minimal One-Shot Reconciliation Entrypoint)
// =========================
//
// 責務: core/tact-runtime/reconciliation.tsのreconcileRuntimeExecution()
// (実装済み・tests PASS)を、実際の1件のRunに対して安全にon-demand
// 呼び出すための最小限の合成レイヤ。このfile自身はreconciliationの
// 判断ロジックを一切持たない(lookup/recovery/repairの実体は既存
// reconcileRuntimeExecution()のまま——二重実装しない)。
//
// 絶対条件(今回の依頼Step2/Step6、最重要): callerがworkId/taskId/
// runIdを指定できるが、それ以外(userId/action/connectionId)は
// 一切信用しない——すべてserver側で認証済みのuserId・DBから再構成した
// 値だけを使う。
//   - userId: 呼び出し元(app/api/tact/runtime/reconcile/route.ts)が
//     getCurrentUserContext()で検証済みの値のみを渡す(この関数自体は
//     認証をしない、呼び出し元の責務)。
//   - work/task/runの所有者確認: getWork()/listTasksForWork()/
//     listRunsForTask()が全てowner-scoped(明示的.eq(user_id)+RLS
//     二重防御、既存store.tsの規約通り)。他user所有のWork/Task/Runを
//     指定された場合、ここで構造的にnot_foundになる(なりすまし不可)。
//   - action: サービス/オペレーションは絶対にcaller入力から取らず、
//     このfile内の定数(SLACK_LIST_CHANNELS)に固定する。Run.capability
//     列(prepareRunForExecution()が"integration.slack.list_channels"
//     として実際に永続化済み——core/tact-integration/execution.ts
//     参照)と一致するRunだけを対象にする、DBからの再構成による検証。
//   - connectionId: caller入力から一切取らず、Runの所有者自身の
//     既存Slack Connectionを毎回re-resolveする(1件のみ許可、0件/複数件
//     はfail closed)。resolveIntegrationConnectionViaTactIntegration()
//     と同じ判断だが、そちらはcore/tact-conversation/(合成ルート)
//     private実装のため、ここではlistConnectionsForUser()を直接
//     再利用するだけに留める(新しいConnection解決ロジックを増やさない)。
//
// 絶対条件(Step4): このfile自身はdispatchIntegrationReadToRuntime()・
// TriggerDevRuntimeAdapter.startExecution()・
// executeRuntimeIntegrationReadTask()・executeIntegrationActionCore()の
// いずれもimportしない——reconcileRuntimeExecution()を1回呼ぶだけ。
// Provider実行・新規Trigger dispatch・createRunはreconcileRuntime
// Execution()自身が型レベルで持たない(ReconciliationDeps参照)。
import { getWork, listTasksForWork, listRunsForTask } from "../tact-work/store";
import { listConnectionsForUser } from "../tact-integration/connection";
import { resolveRuntimeIntegrationReadAdapter } from "./enablement";
import { reconcileRuntimeExecution, type ReconciliationOutcome } from "./reconciliation";

// Fast Port P5c/P5dのRuntime read allowlistと同じ固定値
// (core/tact-integration/execution.tsのisRuntimeEligibleIntegrationAction()
// が唯一許可する組み合わせ)。このfile自身はそちらをimportせず、
// Run.capability列との照合という別の角度から同じ制約を再確認する
// (二重ゲート、既存Step19の精神を踏襲)。
const SLACK_LIST_CHANNELS_CAPABILITY = "integration.slack.list_channels";

export interface ReconcileOneShotIntegrationReadParams {

  // 認証済みuserIdのみ(呼び出し元が検証する、この関数は再検証しない)。
  userId: string;

  accessToken: string;

  // callerが明示指定する対象1件のポインタ。所有者確認・correlation
  // 確認はこの関数の内部で行う——「指定できれば何でも読める」設計には
  // しない。
  workId: string;

  taskId: string;

  runId: string;

}

export type ReconcileOneShotIntegrationReadResult =
  | { ok: true; outcome: ReconciliationOutcome }
  // 事前条件チェックで弾かれた場合(reconcileRuntimeExecution()自体は
  // 未呼び出し)。既存ReconciliationOutcomeのunionへ新しいmemberを
  // 混ぜない(Step5絶対条件)ため、この関数専用の別axisとして表現する。
  | { ok: false; reason: "not_found" | "not_eligible" | "connection_unresolved" | "runtime_unavailable" };

export interface ReconcileOneShotIntegrationReadDeps {
  getWork: typeof getWork;
  listTasksForWork: typeof listTasksForWork;
  listRunsForTask: typeof listRunsForTask;
  listConnectionsForUser: typeof listConnectionsForUser;
  resolveRuntimeAdapter: typeof resolveRuntimeIntegrationReadAdapter;
  reconcileRuntimeExecution: typeof reconcileRuntimeExecution;
}

const defaultDeps: ReconcileOneShotIntegrationReadDeps = {
  getWork,
  listTasksForWork,
  listRunsForTask,
  listConnectionsForUser,
  resolveRuntimeAdapter: resolveRuntimeIntegrationReadAdapter,
  reconcileRuntimeExecution,
};

export async function reconcileOneShotIntegrationRead(
  params: ReconcileOneShotIntegrationReadParams,
  deps: ReconcileOneShotIntegrationReadDeps = defaultDeps
): Promise<ReconcileOneShotIntegrationReadResult> {

  const { userId, accessToken, workId, taskId, runId } = params;

  // 所有者確認その1: Work。getWork()自体がuser_id一致を要求する
  // (既存store.tsの規約、RLSとの二重防御)ため、他user所有のworkId
  // を指定された場合はここでundefinedになる。
  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { ok: false, reason: "not_found" };
  }

  // 所有者確認その2 + correlation確認: Task.workIdが指定workIdと
  // 一致するTaskだけを対象にする(callerがtaskIdだけ差し替えて別Workの
  // Taskを指すことを防ぐ)。
  const tasks = await deps.listTasksForWork(workId, userId, accessToken);
  const task = tasks.find((candidate) => candidate.id === taskId && candidate.workId === workId);

  if (!task) {
    return { ok: false, reason: "not_found" };
  }

  // 所有者確認その3 + correlation確認: Run.taskIdが指定taskIdと一致する
  // Runだけを対象にする。
  const runs = await deps.listRunsForTask(workId, userId, accessToken, taskId);
  const run = runs.find((candidate) => candidate.id === runId && candidate.taskId === taskId);

  if (!run) {
    return { ok: false, reason: "not_found" };
  }

  // action再構成(Step2絶対条件): callerの入力ではなく、Run自身が
  // 既に永続化済みのcapability列から「このRunは本当にslack.
  // list_channelsの試行だったか」を確認する。一致しないRun
  // (他のCapability・protected write等)は、たとえstatus==="running"
  // であっても対象外としてfail closedする。
  if (run.capability !== SLACK_LIST_CHANNELS_CAPABILITY) {
    return { ok: false, reason: "not_eligible" };
  }

  // connectionId再解決(Step2絶対条件): callerからconnectionIdを
  // 受け取らない。Run所有者自身の既存Slack Connectionを毎回re-resolve
  // する(0件/複数件はfail closed、既存resolveIntegrationConnection
  // Via TactIntegration()と同じ判断基準)。
  //
  // LIVE-1A False Multiple Connection Resolution(修正): 既存
  // resolveIntegrationConnectionViaTactIntegration()と全く同じ理由で、
  // resolution candidateはactive connectionだけに絞る——statusを
  // 指定しないと、pending/failed/revokedな過去のConnection行まで
  // 「複数件」として誤ってfail closedしてしまう(二重に異なる解決
  // semanticsを残さない、絶対条件)。
  const connections = await deps.listConnectionsForUser(userId, accessToken, "slack", "active");

  if (connections.length !== 1) {
    return { ok: false, reason: "connection_unresolved" };
  }

  // Runtime adapter resolution(Step3絶対条件): 既存の唯一のchokepoint
  // (resolveRuntimeIntegrationReadAdapter())を再利用する。
  // TriggerDevRuntimeAdapterを直接newしない・credential解決ロジックを
  // 複製しない。
  const resolution = deps.resolveRuntimeAdapter();

  if (resolution.status !== "enabled") {
    return { ok: false, reason: "runtime_unavailable" };
  }

  // Step4絶対条件: ここから先はreconcileRuntimeExecution()を1回
  // 呼ぶだけ。新規dispatch/Provider実行/createRunはこの関数もその先も
  // 一切行わない(reconcileRuntimeExecution()自身の型契約が保証する)。
  const outcome = await deps.reconcileRuntimeExecution(
    {
      workId,
      userId,
      accessToken,
      taskId,
      runId,
      action: { service: "slack", operation: "list_channels", connectionId: connections[0].id },
    },
    resolution.adapter
  );

  return { ok: true, outcome };

}
