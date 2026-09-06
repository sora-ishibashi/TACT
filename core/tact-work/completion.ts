import {
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

}

const defaultDeps: ReconcileWorkCompletionStatusDeps = {
  listTasksForWork,
  listApprovalsForWork,
  updateWorkStatus,
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
    await deps.updateWorkStatus(workId, userId, accessToken, "completed");
    return { status: "reconciled", workStatus: "completed" };
  }

  // 全Taskがterminalで、failedもcompletedも無い = 全件cancelled。
  return { status: "undetermined", reason: "all_tasks_cancelled_no_existing_precedent" };

}
