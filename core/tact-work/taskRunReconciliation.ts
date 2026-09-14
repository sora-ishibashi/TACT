import {
  getWork,
  listTasksForWork,
  listRunsForTask,
  updateTaskStatus as defaultUpdateTaskStatus,
} from "./store";
import { reconcileWorkCompletionStatus as defaultReconcileWorkCompletionStatus } from "./completion";
import type { Run } from "./types";

// =========================
// TACT Work — Stranded Task/Run Projection Reconciliation
// (DUR-P1: Stranded Task State Integrity Fix)
// =========================
//
// 背景(Pre-Live Audit P1「Stranded Task」finding、docs/architecture/
// pre-live-full-audit.md): core/tact-integration/execution.tsの
// prepareRunForExecution()は、Run作成(claim)とTask.status="running"
// projection更新という2つの独立したDB writeから成る。同様に
// executeIntegrationActionCore()の完了時も、completeRun()/failRun()と
// updateTaskStatus(terminal)という同じ形の非atomicなペアを持つ。
// これらの間でprocess crash/timeoutが起きると、Task.statusとRunの
// 実体が一時的に食い違う——「Run = execution attemptのsource of
// truth、Task.status = そのprojection」という位置づけ(DUR-P1指示
// Step4)のもとでは、Runの実体を正としてTask.statusを事後的に
// 修復できればよい。
//
// 設計方針(絶対条件、Step4「cron/pollerは不要、on-demand
// deterministic recoveryで十分」): このfileは、指定された1件のTaskに
// 対してだけ判定・修復を行う、副作用最小のpure operationのみを持つ。
// scheduler/pollerは実装しない(core/tact-runtime/reconciliation.tsの
// 「manual/on-demandで呼ばれる、単一対象に対するreconciliationのみ」
// という既存設計思想をそのまま踏襲する)。
//
// Audit Event: 新しいevent_typeは追加しない。tact_audit_eventsの
// event_type CHECK制約(supabase/migrations/
// 20260912000000_create_tact_audit_events.sql)は既存14値の閉じた
// enumであり、追加にはmigrationが必要——core/tact-work/resume.tsの
// Step6と同じ理由で、このPhaseでは見送る(run.completed/run.failedは
// 本来の実行経路(executeIntegrationActionCore())で既にemit済みの
// はずであり、ここで再emitすると二重emissionになるため、そもそも
// 再emitすべきではない)。
//
// TACT Runs境界(Step9、docs/architecture/tact-runs-boundary.md):
// execution claim/Run lifecycleの実体はTACT Runs candidateとして
// 位置づけられるが、ARCH-RUNS-1を理由に大規模module移動はしない
// (絶対条件)——このfileもcore/tact-work/配下に既存のcompletion.ts/
// resume.tsと並べて置く。

export type StrandedTaskProjectionOutcome =
  | { status: "not_found" }
  // 複数のRunが同時にrunning状態(state F)——どちらが正か機械的に
  // 判定できないため、独自にルールを拡張せず何もしない(絶対条件:
  // 不明点は独自解釈で拡張しない)。
  | { status: "not_applicable"; reason: string }
  // Task.statusは既にRunの実体と一致している(修復不要)。
  | { status: "no_drift" }
  // Task.statusを、最新Runの実体に合わせて修復した。
  | { status: "projected"; taskStatus: "running" | "completed" | "failed" };

export interface ReconcileStrandedTaskProjectionDeps {

  getWork: typeof getWork;

  listTasksForWork: typeof listTasksForWork;

  listRunsForTask: typeof listRunsForTask;

  updateTaskStatus: typeof defaultUpdateTaskStatus;

  reconcileWorkCompletionStatus: typeof defaultReconcileWorkCompletionStatus;

}

const defaultDeps: ReconcileStrandedTaskProjectionDeps = {
  getWork,
  listTasksForWork,
  listRunsForTask,
  updateTaskStatus: defaultUpdateTaskStatus,
  reconcileWorkCompletionStatus: defaultReconcileWorkCompletionStatus,
};

// attempt番号が最大のRun(=最新のexecution attempt)を返す純粋関数
// (DB接続なしにunit testできるようにするため)。
export function findLatestRun(runs: Run[]): Run | undefined {

  return runs.reduce<Run | undefined>((latest, run) => {

    if (!latest || run.attempt > latest.attempt) {
      return run;
    }

    return latest;

  }, undefined);

}

// =========================
// computeNextAttemptNumber (RUNS-P1)
// =========================
//
// Repository Reality Audit(RUNS-P1実装前)で判明した事実: 「あるTaskの
// 次のattempt番号は何か」という計算は、既にcore/tact-integration/
// execution.tsのprepareRunForExecution()内に
// `existingRuns.reduce((max, run) => Math.max(max, run.attempt), 0) + 1`
// として実装済みだった(DUR-P1、Run claimをTask.status projectionより
// 先に行う設計の一部)。この関数はその既存ロジックをそのまま
// (計算内容を一切変更せず)独立したpure functionへ切り出しただけ
// ——挙動変更は無い。
//
// 絶対条件(attempt allocationの安全性、RUNS-P1 Section8): 常にTask
// スコープで計算する(呼び出し元がそのTaskのRunだけを渡す前提、Work
// 全体のglobal counterにしない)。同時に2箇所から呼ばれて同じ
// (task_id, attempt)を計算してしまうrace自体は、この関数だけでは
// 防げない——最終的な排他は既存DB unique index
// (idx_tact_runs_task_id_attempt、supabase/migrations/
// 20260905000000_create_tact_work_tables.sqlで既に存在、この関数は
// 一切変更しない)がcreateRun()呼び出し時に保証する(片方が
// application-level throwまたはPostgres unique_violationで安全に
// 失敗する、core/tact-conversation/orchestration.tsの
// isConcurrentRunClaimError()が既にこれを検出・正規化している)。
export function computeNextAttemptNumber(runs: readonly Run[]): number {

  return runs.reduce((max, run) => Math.max(max, run.attempt), 0) + 1;

}

// =========================
// isRetryableIntegrationFailure (RUNS-P1)
// =========================
//
// Repository Reality Audit finding(最重要): core/tact-integration/
// types.tsのIntegrationExecutionError.retryableは、「将来、Provider側で
// backend-honored idempotency keyが提供された時点で、呼び出し元
// (上位layer/人間)がこの値を判断材料として使うための情報にとどめる」
// という明示的な設計意図を既に持っていた値だが、実際には
// executeIntegrationActionCore()のfailRun()呼び出しでmessageだけが
// 抽出され、code/retryable自体はRunへ一切永続化されていなかった
// (RUNS-P1でexternalRef.errorCode/externalRef.errorRetryableとして
// 保存するよう修正——同じcommitのcore/tact-integration/execution.ts
// 変更を参照)。
//
// この関数は、そうして保存されたRunから「この特定のfailureは
// (将来のretry判断のための情報として)retryableと分類されていたか」を
// 読み取るだけの、read-only・side-effect-freeな分類ヘルパーである。
//
// 絶対条件(RUNS-P1 Section9/11、最重要): この関数の戻り値がtrueで
// あっても、それ自体はいかなるretry実行もauthorizeしない——単なる
// 判断材料(judgment material)にとどまる。Task.statusをterminalから
// 非terminalへ戻す操作、新しいRunを作る操作のいずれもこの関数は
// 一切行わない(そのような操作は既存の「terminal stateから非terminalへ
// 戻る非単調な遷移をTask status historyへ持ち込まない」という
// core/tact-work/execution.tsの既存絶対条件と衝突するため、RUNS-P1の
// scopeから意図的に除外した——完了報告のKnown Limitations参照)。
//
// 絶対条件(fail closed): externalRef自体が無い(RUNS-P1以前に作られた
// 既存Run、または非Integration Capabilityが作ったRun)・
// errorRetryableが真偽値でない場合はundefinedを返す——「retryableでは
// ない」と「わからない」を混同しない(既存パターン、
// resolveTaskCapabilities()のfail closed設計と同じ精神)。
export function isRetryableIntegrationFailure(
  run: Pick<Run, "status" | "externalRef">
): boolean | undefined {

  if (run.status !== "failed") {
    return undefined;
  }

  const externalRef = run.externalRef;

  if (typeof externalRef !== "object" || externalRef === null) {
    return undefined;
  }

  const retryable = (externalRef as Record<string, unknown>).errorRetryable;

  return typeof retryable === "boolean" ? retryable : undefined;

}

// 与えられたTask.statusと最新Runの実体から、修復すべきoutcomeを導出する
// 純粋関数(DBアクセス自体はreconcileStrandedTaskProjection()側で行う、
// core/tact-work/completion.tsと同じ「判定はpure、副作用は呼び出し元」
// という分離)。
export function evaluateStrandedTaskProjection(
  taskStatus: "pending" | "running" | "completed" | "failed" | "cancelled",
  runs: Run[]
): StrandedTaskProjectionOutcome {

  const runningRuns = runs.filter((run) => run.status === "running");

  if (runningRuns.length > 1) {
    return { status: "not_applicable", reason: "multiple_active_runs" };
  }

  const run = findLatestRun(runs);

  if (!run) {
    // Runがまだ1件も存在しない(Task開始前、またはRun作成前に
    // crashした場合——Task.statusは変更する必要が無い、state Aは
    // このfileが導入するprepareRunForExecution()の順序変更により
    // 構造的に発生しなくなった)。
    return { status: "not_applicable", reason: "no_runs" };
  }

  if (run.status === "running") {

    if (taskStatus === "pending") {
      // state B: Run running / Task pending。
      return { status: "projected", taskStatus: "running" };
    }

    return { status: "no_drift" };

  }

  const projectedStatus: "completed" | "failed" = run.status === "completed" ? "completed" : "failed";

  if (taskStatus === "running" || taskStatus === "pending") {
    // state C/D(Task running時にRunが先にterminal化)、state E
    // (Task pendingのままRunだけがterminal化)。いずれもRun側の
    // terminal statusをTaskへ反映する。
    return { status: "projected", taskStatus: projectedStatus };
  }

  return { status: "no_drift" };

}

export async function reconcileStrandedTaskProjection(
  workId: string,
  userId: string,
  accessToken: string,
  taskId: string,
  deps: ReconcileStrandedTaskProjectionDeps = defaultDeps
): Promise<StrandedTaskProjectionOutcome> {

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { status: "not_found" };
  }

  const tasks = await deps.listTasksForWork(workId, userId, accessToken);
  const task = tasks.find((candidate) => candidate.id === taskId);

  if (!task) {
    return { status: "not_found" };
  }

  const runs = await deps.listRunsForTask(workId, userId, accessToken, taskId);

  const evaluation = evaluateStrandedTaskProjection(task.status, runs);

  if (evaluation.status !== "projected") {
    return evaluation;
  }

  await deps.updateTaskStatus(workId, userId, accessToken, taskId, evaluation.taskStatus);

  if (evaluation.taskStatus === "completed" || evaluation.taskStatus === "failed") {

    // 既存executeIntegrationActionCore()のreconcileAfterTaskUpdate()と
    // 同じ理由: Work全体の集約判定失敗が、既に確定したTask projection
    // 修復の成否判定を変えてはいけない。
    try {

      await deps.reconcileWorkCompletionStatus(workId, userId, accessToken);

    } catch (error) {

      console.warn(
        "[tact-work/taskRunReconciliation] reconcileWorkCompletionStatus() failed after " +
        "stranded task projection repair; Task projection自体は既に確定済みのため、この" +
        "内部集計の失敗によって修復結果を変更しない。",
        error
      );

    }

  }

  return evaluation;

}
