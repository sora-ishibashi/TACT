// =========================
// TACT Runtime — Reconciliation Foundation
// (Fast Port P5d: Runtime Reconciliation / Idempotency Hardening)
// =========================
//
// 責務(Step9/Step12、絶対条件): manual/on-demandで呼ばれる、単一の
// TACT Runに対するreconciliation。lookup・reference recovery・
// canonical state repairのみを行う——Provider呼び出しの再実行・
// Trigger.dev task bodyの再実行は一切行わない(絶対条件Step15)。
//
// 絶対条件(Step19、最重要): ReconciliationDeps型自体に
// executeIntegrationAction相当のfield(Provider実行を呼び出す手段)が
// 一切存在しない——「provider side effectを再実行しない」という制約
// を、Provider呼び出し手段の不在という型レベルの事実で裏付ける
// (isRuntimeEligibleIntegrationAction()はcore/tact-integration/
// execution.tsから再利用する純粋predicateにすぎず、この関数自体は
// core/tact-integration/gateway.ts=Provider実行を一切呼び出さない)。
//
// cron/scheduler/worker pollerは一切実装しない(Step39絶対条件)——
// この関数は明示的に1回呼ばれるだけの純粋なon-demand operationである。
//
// 戦略選定(Step10): 比較した4案のうち、official Trigger.dev
// idempotency primitive(TriggerOptions.idempotencyKey——同じkeyで
// trigger()を再度呼ぶと、既にexecutionが存在すればnew executionを
// 作らずそのhandleを返す、installed types + 公式docs確認済み)を
// 採用する(Option A、優先順位のうち最上位)。この方式は「1
// idempotency keyにつき高々1つのexecution」というTrigger.dev自身の
// 保証に支えられた決定論的point lookupであり、Option B
// (tags/metadataによるrun.list()検索)のような「0/1/2+件」という
// 曖昧な検索結果を構造的に生じさせない——Step13の多重match問題は、
// この戦略を選んだことで最初から発生しない(この点をFinal Reportで
// 明示する)。新しいSupabase table(Option D)は不要だった。
import {
  getWork,
  listRunsForTask,
  attachRunExternalRef as defaultAttachRunExternalRef,
  failRun as defaultFailRun,
  updateTaskStatus as defaultUpdateTaskStatus,
} from "../tact-work/store";
import { emitAuditSafely as defaultEmitAuditSafely } from "../tact-work/audit";
import { isRuntimeEligibleIntegrationAction } from "../tact-integration/execution";
import { toRunExternalRefFields, readRuntimeExecutionHandle } from "./types";
import type { Run } from "../tact-work/types";
import type { RuntimeAdapter } from "./types";

export interface ReconciliationDeps {
  getWork: typeof getWork;
  listRunsForTask: typeof listRunsForTask;
  attachRunExternalRef: typeof defaultAttachRunExternalRef;
  failRun: typeof defaultFailRun;
  updateTaskStatus: typeof defaultUpdateTaskStatus;
  emitAuditEvent: typeof defaultEmitAuditSafely;
}

const defaultDeps: ReconciliationDeps = {
  getWork,
  listRunsForTask,
  attachRunExternalRef: defaultAttachRunExternalRef,
  failRun: defaultFailRun,
  updateTaskStatus: defaultUpdateTaskStatus,
  emitAuditEvent: defaultEmitAuditSafely,
};

export interface ReconcileRuntimeExecutionParams {
  workId: string;
  userId: string;
  accessToken: string;
  taskId: string;
  runId: string;
  action: { service: string; operation: string; connectionId: string };
}

// =========================
// ReconciliationOutcome (Step12/Step13)
// =========================
//
// 絶対条件(Step13): 「0 matches」「1 match」「2+ matches」という
// 検索的な語彙をそのまま持ち込まない——採用した戦略(idempotency
// keyによるpoint lookup)はこの多重match問題を構造的に生じさせない
// ため。代わりにこのfile自身の責務(lookup→recovery→repair)に
// 素直な語彙を使う。
export type ReconciliationOutcome =
  | { status: "not_found" }
  // Runは既にterminal(completed/failed)——reconcile対象外
  // (Step6の「dispatch前にexisting Runを確認」を、on-demand
  // reconciliationの入口チェックとしてここで再利用する)。
  | { status: "not_applicable" }
  // Run.externalRefに既にruntimeProvider/runtimeExecutionIdが
  // 存在する——何もする必要がない。
  | { status: "already_attached" }
  // 再dispatch(=idempotency keyによる同一execution参照)によって
  // handleを復元し、attachRunExternalRef()まで成功した。
  | { status: "recovered"; run: Run }
  // 再dispatchもambiguous(outcomeKnown===false)だった——依然
  // unknownのまま、Runはrunningを維持する(絶対条件17)。
  | { status: "still_unknown" }
  // 再dispatchがdefinite failureを返した——この時点で初めて安全に
  // Runをfailedへ確定できる(provider side effectの再実行ではない、
  // Trigger.dev自身のdispatch層の話でしかない)。
  | { status: "confirmed_failed"; run: Run };

// Fast Port P5d(Step6): 既存Runのexternal reference再取得(Work
// ownership確認込み)。listRunsForTask()を再利用するだけで、新しい
// 単発取得APIは追加しない(既存core/tact-integration/execution.tsの
// executeRuntimeIntegrationRead()と同じpattern)。
async function findExistingRun(
  params: ReconcileRuntimeExecutionParams,
  deps: ReconciliationDeps
): Promise<Run | undefined> {

  const work = await deps.getWork(params.workId, params.userId, params.accessToken);

  if (!work) {
    return undefined;
  }

  const runs = await deps.listRunsForTask(params.workId, params.userId, params.accessToken, params.taskId);

  return runs.find((candidate) => candidate.id === params.runId);

}

export async function reconcileRuntimeExecution(
  params: ReconcileRuntimeExecutionParams,
  runtimeAdapter: RuntimeAdapter,
  deps: ReconciliationDeps = defaultDeps
): Promise<ReconciliationOutcome> {

  // 絶対条件(Step19二重ゲート、defense-in-depth): reconciliation
  // 対象もread sliceのallowlistを再確認する(protected writeを
  // reconciliation経由で再startさせない)。
  if (!isRuntimeEligibleIntegrationAction(params.action.service, params.action.operation)) {
    return { status: "not_found" };
  }

  const run = await findExistingRun(params, deps);

  if (!run) {
    return { status: "not_found" };
  }

  if (run.status !== "running") {
    // 既に何らかの経路(Trigger task側のcomplete/fail、または別の
    // reconciliation実行)でterminalへ確定している——このRunは
    // reconcile対象外(Step6のexternalRef pre-checkと同じ精神)。
    return { status: "not_applicable" };
  }

  const existingHandle = readRuntimeExecutionHandle(run.externalRef);

  if (existingHandle && existingHandle.provider === runtimeAdapter.provider) {
    return { status: "already_attached" };
  }

  // Step10選定戦略: 同じrunIdからadapter内部で導出される同じ
  // idempotency keyを使ってstartExecution()を再度呼ぶ。Trigger.dev
  // 側で既に実行が存在すれば、新しいexecutionを作らずそのhandleが
  // そのまま返る(official primitive、絶対条件Step5/Step15: provider
  // side effectの再実行にはならない——Trigger.dev自身のdispatch層の
  // idempotent lookupでしかない)。
  const startOutcome = await runtimeAdapter.startExecution({
    kind: "integration_action",
    userId: params.userId,
    workId: params.workId,
    taskId: params.taskId,
    runId: run.id,
    action: params.action,
  });

  if (startOutcome.status === "started") {

    const externalRef: Record<string, unknown> = { ...toRunExternalRefFields(startOutcome.handle) };

    await deps.attachRunExternalRef(params.workId, params.userId, params.accessToken, run.id, externalRef);

    return { status: "recovered", run: { ...run, externalRef } };

  }

  if (!startOutcome.error.outcomeKnown) {
    return { status: "still_unknown" };
  }

  // 絶対条件(Step11と同じpattern、二重実装を避けるため最小限だけ
  // 再現する): definite failureが確定して初めて、ここでRunをfailed
  // へ閉じる。
  const safeErrorMessage = `Runtime dispatch failed: ${startOutcome.error.code}`;

  await deps.emitAuditEvent(
    {
      workId: params.workId,
      taskId: params.taskId,
      runId: run.id,
      category: "execution",
      eventType: "run.failed",
      reasonCode: startOutcome.error.code,
    },
    params.userId,
    params.accessToken
  );

  await deps.failRun(params.workId, params.userId, params.accessToken, run.id, { error: safeErrorMessage });

  await deps.updateTaskStatus(params.workId, params.userId, params.accessToken, params.taskId, "failed");

  return { status: "confirmed_failed", run: { ...run, status: "failed", error: safeErrorMessage } };

}
