import {
  getWork,
  listTasksForWork,
  listApprovalsForWork,
  updateWorkStatus,
} from "./store";
import type { TaskStatus } from "./types";

// =========================
// TACT Work — Work Completion Reconciliation
// (Architecture Migration Phase C2.1a)
// =========================
//
// 背景(Phase C1.5 Live Acceptanceで発見されたarchitecture debt A):
// Work completion judgment(「Workを completed/failed へ確定する」判断)
// は、これまでcore/tact-work/execution.tsのrunWorkTurn()内部だけに
// インラインで存在しており、Orchestrator経由の1 Turn分の
// OrchestrationResult.tasksだけを見て判定していた。core/tact-integration/
// execution.tsのexecuteApprovedIntegrationAction()はTaskのstatusを
// 更新するだけでこの判定へ一切到達できず、Integration経由の実行後は
// Workがrunningに残り続けていた。
//
// このfileは、その判定ロジックを「Workが所有するTask全体」を見る
// 形で汎用化し、runWorkTurn()・executeApprovedIntegrationAction()の
// 両方から呼べる共有責務としてcore/tact-work側(TACT-owned)へ切り出す。
// core/tact-work/store.tsは既存方針通り「DB primitiveだけを持つ層」
// のままにし、この集約判断(business rule)は独立したfileへ置く
// (core/tact-work/approval.tsが同じ理由でstore.tsの外に置かれている
// のと同じ設計判断)。
//
// 絶対条件(Phase C2.1a指示): 単純な「Task 1件 completed → Work
// completed」というルールにしない。Workが所有する全Taskを見て、
// 全Taskがterminalに達した場合のみWork全体を確定させる。

// TaskのTerminal状態(これ以上statusが変わらない状態)。
// pending/runningが1件でも残っていれば、Work全体もまだ未確定のまま
// とする。
const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export interface ReconcileWorkCompletionStatusDeps {

  listTasksForWork: typeof listTasksForWork;

  listApprovalsForWork: typeof listApprovalsForWork;

  updateWorkStatus: typeof updateWorkStatus;

  // Architecture audit finding F-02 fix: needed only to read the durable
  // semantic signal (Work.requestType) before writing "completed" — see the
  // comment on the "completed" branch below. Every existing call site of
  // this function already has a validated userId/accessToken for this Work
  // in scope, so this adds no new trust boundary.
  getWork: typeof getWork;

}

const defaultDeps: ReconcileWorkCompletionStatusDeps = {
  listTasksForWork,
  listApprovalsForWork,
  updateWorkStatus,
  getWork,
};

// 呼び出し元(runWorkTurn()・executeApprovedIntegrationAction())が
// 「今回の集約判定がどう終わったか」を観測できるよう、判定結果を
// discriminated unionで返す(例外を投げない——このfile自体がDBエラー
// 以外の理由で失敗することは無い設計とし、DBエラーは呼び出し元が
// 個別に扱う)。
export type WorkCompletionReconciliationOutcome =
  // Workが所有するTaskが1件も無い(まだTaskが作られていない等)。
  | { status: "no_change"; reason: "no_tasks" }
  // pending/runningのTaskが残っている。Workはまだ完了と確定できない。
  | { status: "no_change"; reason: "tasks_not_all_terminal" }
  // 全Taskはterminalだが、未解決(pending)のApprovalがまだ残っている
  // (Phase B3のapprovalRequirement pattern — 提案attempt自体は
  // completedとして記録されるが、Approval自体はpendingのまま、という
  // 既存のcanonical semanticsに対応するため。Task一覧だけでは
  // この状態を検出できない)。
  | { status: "no_change"; reason: "pending_approval_exists" }
  // Architecture audit finding F-02(GMAIL-P1 Completion Ownership Audit)
  // fix: 全Taskがterminalでfailedも無い(=素直に読めばcompletedにしたい)
  // が、このWorkが durable semantic delegated Work(Work.requestType!=null、
  // core/tact-work/intake.tsが作成時に一度だけ設定する持続的signal)で
  // あり、かつまだWork.resultDeliveredAt(最終的な利用者向け結果が
  // 記録されたことを示す既存canonical delivery boundary、
  // markWorkResultDelivered()参照)が未設定の場合。この関数はここでは
  // Workを一切変更しない——最終的な完了確定は、delivery後に呼ばれる
  // core/tact-work/delegatedCompletion.tsのfinalizeDelegatedWorkAfterDelivery()
  // /finalizeSemanticWorkAfterProtectedWrite()が、このsame関数を
  // もう一度呼ぶことで行う(新しい評価器を作らない、既存の
  // reconcileWorkCompletionStatus()自身をそのまま再利用する)。
  | { status: "no_change"; reason: "awaiting_semantic_delivery" }
  // 全Taskがterminalで、1件以上failedがある → Work全体をfailedへ確定。
  | { status: "reconciled"; workStatus: "failed" }
  // 全Taskがterminalで、failedは無く1件以上completedがある → Work
  // 全体をcompletedへ確定。
  | { status: "reconciled"; workStatus: "completed" }
  // 全Taskがterminalだが、completedが1件も無く全件cancelled
  // (=実際に成功したTaskが無い)。既存のrunWorkTurn()インライン
  // ロジックは「failedが無ければcompleted」という2値判定しか
  // 持たず、この組み合わせに対する既存のcanonical判断が repository
  // 上に存在しない(Work.status="cancelled"へ遷移させている既存
  // 呼び出しが1件も無いことを確認済み)。ここで独自にルールを
  // 作らず、Work statusは変更しないまま呼び出し元へ「未確定」で
  // あることを明示的に伝える(絶対条件: 勝手にルールを作らない)。
  | { status: "undetermined"; reason: "all_tasks_cancelled_no_existing_precedent" };

export async function reconcileWorkCompletionStatus(
  workId: string,
  userId: string,
  accessToken: string,
  deps: ReconcileWorkCompletionStatusDeps = defaultDeps
): Promise<WorkCompletionReconciliationOutcome> {

  const tasks = await deps.listTasksForWork(workId, userId, accessToken);

  if (tasks.length === 0) {
    return { status: "no_change", reason: "no_tasks" };
  }

  if (!tasks.every((task) => isTerminalTaskStatus(task.status))) {
    return { status: "no_change", reason: "tasks_not_all_terminal" };
  }

  // Task一覧だけでは、Phase B3のapprovalRequirement pattern
  // (提案attempt自体はcompletedとして記録されつつ、Approval自体は
  // pendingのまま残るケース)を検出できないため、Approval一覧も
  // 確認する。
  const approvals = await deps.listApprovalsForWork(workId, userId, accessToken);

  if (approvals.some((approval) => approval.status === "pending")) {
    return { status: "no_change", reason: "pending_approval_exists" };
  }

  const anyFailed = tasks.some((task) => task.status === "failed");

  if (anyFailed) {
    await deps.updateWorkStatus(workId, userId, accessToken, "failed");
    return { status: "reconciled", workStatus: "failed" };
  }

  const anyCompleted = tasks.some((task) => task.status === "completed");

  if (anyCompleted) {

    // Architecture audit finding F-02 fix(GMAIL-P1 Completion Ownership
    // Audit、最重要): 「全Taskがterminalで1件以上completed」というTask
    // 集計だけで、無条件にWorkをcompletedへ確定させない。このWorkが
    // durable semantic delegated Work(subject/objective/requestType/
    // completionConditions/requiredCapabilitiesを持つ、core/tact-work/
    // intake.tsが作成時に一度だけ設定する)である場合、Task terminal化
    // だけでは「業務として完了した」ことにならない——最終的な利用者向け
    // 結果が実際に届けられた(Work.resultDeliveredAt、既存canonical
    // delivery boundary)ことが必要条件のまま残る(core/tact-work/
    // delegatedCompletion.tsのfinalizeDelegatedWorkAfterDelivery()が
    // 既にread/inspect側で確立していた不変条件を、write/act側の
    // Approval resume経路でも構造的に守れるようにするための修正)。
    //
    // 絶対条件(この修正が守る境界): この判定はWork.requestTypeという
    // 既存の永続列を読むだけであり、新しいWork status・新しいWork
    // model・新しいProvider固有分岐のいずれも追加しない。classic Work
    // (requestType未設定)は以下のgetWork()呼び出し後も即座にcompleted
    // へ確定する——挙動は一切変わらない。
    const work = await deps.getWork(workId, userId, accessToken);

    if (work?.requestType != null && !work.resultDeliveredAt) {
      return { status: "no_change", reason: "awaiting_semantic_delivery" };
    }

    await deps.updateWorkStatus(workId, userId, accessToken, "completed");
    return { status: "reconciled", workStatus: "completed" };
  }

  // 全Taskがterminalで、failedもcompletedも無い = 全件cancelled。
  return { status: "undetermined", reason: "all_tasks_cancelled_no_existing_precedent" };

}
