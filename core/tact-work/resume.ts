// =========================
// TACT Work — Task Resume Foundation (Fast Port P6a)
// =========================
//
// 目的(P6a指示): Approval/Clarificationで一度停止したTaskを、Human
// Interactionのresolutionそのものとは分離して、execution layerが
// 安全に再開できるcanonical resume foundationを作る。
//
// 絶対条件(最重要、この一行に集約される): resolved ≠ execution resumed。
// Human InteractionはDecision Owner(何を許可するか)。Runtimeは
// Decision Owner ではない(何をいつ実行するかを決めるのはTACT
// canonical codeであり、Runtime/Providerではない、P2-P5 Final
// Architecture Synthesis Section9「Resolution vs Resume Semantics」と
// 同じ設計原則)。このfileはその境界を、canonical pure functionとして
// 明文化する。
//
// このfileが「しない」こと(P6a scope、絶対条件):
//   - Provider実行(core/tact-integration/を一切importしない)
//   - Trigger dispatch(core/tact-runtime/providers/を一切importしない、
//     Trigger.dev固有概念——Waitpoint/Run handle等——はcanonical model
//     に一切登場しない)
//   - createRun(core/tact-work/store.tsのcreateRun/updateRunStatus系を
//     一切importしない、read-only listing関数だけを使う)
//   - Work/Task statusのmutation(全てread-only、既存の
//     approveApproval()/resolveClarification()が既に行うWork.status
//     遷移をそのまま信頼する——ここで新たに書き換えない)
//
// このfileが「する」こと:
//   - evaluateTaskResumeEligibility(): 現在の状態から「このTaskは今
//     resume可能か」を判定する純粋関数(pure、副作用のあるstore呼び出し
//     はread-onlyのlist/get系のみ)。
//   - requestTaskResume(): eligibility再確認・重複resume防止をした上で、
//     execution layer(将来のP6b)へ渡せるcanonical resume intentを
//     返すだけの操作。Provider/Trigger/createRunのいずれも呼ばない。
//
// Step1 audit(コード変更前に実施、この節はfindingsの記録):
//   - approveApproval()(core/tact-work/approval.ts)は、承認成功時に
//     Task.statusを一切変更しない(pendingのまま)。他に未解決pending
//     Approvalが無ければWork.statusだけを"running"へ戻す。
//   - resolveClarification()(core/tact-work/clarification.ts)も対称的に
//     同じ——Task.statusは変更せず、他に未解決pending Clarificationが
//     無ければWork.statusだけを"running"へ戻す。
//   - 暗黙resumeが実際に存在する箇所: Approvalだけ、
//     core/tact-bot/execution/trustedApprovalDecision.tsの
//     handleApprovalDecisionAsTrustedActor()が、
//     approveApproval()呼び出しと同一call stack内でshouldAttemptExecution()
//     判定を挟んだ上でexecuteApprovedIntegrationAction()を呼んでいる
//     ——つまり「resolved」と「resumed(execute)」が、Approvalに限り
//     Bot boundaryという1つの関数の中で暗黙に結合されている。
//     Clarificationには対応する暗黙resumeが存在しない
//     ——resolveClarification()自身のコメントが明記する通り、
//     「次のOrchestration/Execution Turンが別途判断する」という、
//     Workが再訪されるまで何もしない設計になっている。
//   - read integration実行(core/tact-conversation/orchestration.tsの
//     executeReadIntegrationActionWithRuntimeRouting())は、Approval
//     resolutionを経由しない(read-onlyのためrequiresApproval=false)。
//     このfileが対象とするのはApproval/Clarification経由で停止した
//     Taskの再開判断であり、read integrationのRuntime handoff自体
//     (P5c/P5d)には影響しない。
//   - 今回この監査結果自体は変更しない(Approval/Clarification/Bot
//     boundaryのいずれのfileも今回一切編集していない、絶対条件
//     「resolveApproval → requestTaskResume → Provider executionを
//     同一call stackで自動実行しない」を、単に「まだ何も配線しない」
//     ことで構造的に満たす)。
import {
  getWork,
  listTasksForWork,
  listRunsForTask,
  listApprovalsForWork,
  listClarificationsForWork,
} from "./store";

// =========================
// Step4 — Resume Trigger Reason Model
// =========================
//
// 絶対条件: resume reason(なぜresumeが要求されたか)と、eligibility
// blocked reason(なぜresume不可か)を混同しない——別の型として独立
// させる(下記TaskResumeBlockedReasonCode/TaskResumeTerminalReasonCode
// と共通の語彙を持たせない)。Trigger.dev固有のreason(Waitpoint等)は
// 一切含めない。
export type TaskResumeTriggerReason =
  | "approval_resolved"
  | "clarification_resolved"
  | "manual_resume"
  | "runtime_recovered";

// =========================
// Step2 — Canonical Resume Eligibility
// =========================
//
// 「今このTaskをresumeしてよいか」を、副作用の無いread-only queryだけ
// から判定する。Policy再評価(evaluatePolicyDecision())は意図的に
// P6aのscope外とする——執行境界(core/tact-integration/execution.ts
// step5.5)が既にdispatch直前でlive recheckを行っており、この
// eligibility layerで重複evaluate するとPolicy判断の権威点が2箇所に
// 分散する。P6bで実際にexecution layerへ接続する際に、この関数の
// 直後でPolicyを再評価する設計を検討する(DEFER、今回は評価しない)。
export type TaskResumeEligibilityBlockedReasonCode =
  | "work_not_found"
  | "task_not_found"
  | "task_already_running"
  | "capability_not_assigned"
  | "pending_approval_exists"
  | "approval_rejected"
  | "approval_cancelled"
  | "approval_expired"
  | "pending_clarification_exists"
  | "clarification_cancelled"
  | "clarification_expired"
  | "active_run_exists";

export type TaskResumeTerminalReasonCode =
  | "task_completed"
  | "task_failed"
  | "task_cancelled"
  | "run_already_completed";

export type TaskResumeEligibility =
  | { status: "eligible" }
  | { status: "blocked"; reasonCode: TaskResumeEligibilityBlockedReasonCode }
  | { status: "already_terminal"; reasonCode: TaskResumeTerminalReasonCode };

export interface EvaluateTaskResumeEligibilityParams {

  workId: string;

  userId: string;

  accessToken: string;

  taskId: string;

}

export interface TaskResumeEligibilityDeps {

  getWork: typeof getWork;

  listTasksForWork: typeof listTasksForWork;

  listRunsForTask: typeof listRunsForTask;

  listApprovalsForWork: typeof listApprovalsForWork;

  listClarificationsForWork: typeof listClarificationsForWork;

}

const defaultDeps: TaskResumeEligibilityDeps = {
  getWork,
  listTasksForWork,
  listRunsForTask,
  listApprovalsForWork,
  listClarificationsForWork,
};

export async function evaluateTaskResumeEligibility(
  params: EvaluateTaskResumeEligibilityParams,
  deps: TaskResumeEligibilityDeps = defaultDeps
): Promise<TaskResumeEligibility> {

  const { workId, userId, accessToken, taskId } = params;

  // Work存在確認(所有者スコープ、既存getWork()のRLS+明示filterへ
  // そのまま委ねる、caller supplied ownershipを信用しない既存規律)。
  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { status: "blocked", reasonCode: "work_not_found" };
  }

  // Task存在確認 + Work/Task correlation確認(fail closed、絶対条件
  // Step2「wrong Work/Task correlation」)。
  const tasks = await deps.listTasksForWork(workId, userId, accessToken);
  const task = tasks.find((candidate) => candidate.id === taskId && candidate.workId === workId);

  if (!task) {
    return { status: "blocked", reasonCode: "task_not_found" };
  }

  // Task terminal判定を最優先で行う(絶対条件Step2「Task terminalでは
  // ない」)。completed/failed/cancelledはこの時点で確定情報として
  // 扱い、以降のApproval/Clarification/Run検査より優先する
  // (rejectApproval()が既にTask.statusをfailedへ進めているため、
  // 「rejected Approvalが存在する」状態の大半はここで既にtask_failed
  // として捕捉される)。
  if (task.status === "completed") {
    return { status: "already_terminal", reasonCode: "task_completed" };
  }

  if (task.status === "failed") {
    return { status: "already_terminal", reasonCode: "task_failed" };
  }

  if (task.status === "cancelled") {
    return { status: "already_terminal", reasonCode: "task_cancelled" };
  }

  // Task.status==="running"は「既に実行中」であり、resumeの対象では
  // ない(絶対条件Step2「active/running Runの存在」、二重resume防止)。
  if (task.status === "running") {
    return { status: "blocked", reasonCode: "task_already_running" };
  }

  // ここまで到達した時点でtask.status==="pending"のみ。

  // capability/actionがresume対象か(絶対条件Step2)。assignedCapability
  // が無いTaskは、そもそも再開すべき具体的なactionを持たない
  // (Planner未割当、または割当前のTask)。
  if (!task.assignedCapability) {
    return { status: "blocked", reasonCode: "capability_not_assigned" };
  }

  // Approval確認(このTaskへ紐づくものだけを見る、Work全体ではなく
  // taskId一致で絞り込む——他Taskのpending Approvalに影響されない)。
  const approvals = (await deps.listApprovalsForWork(workId, userId, accessToken))
    .filter((approval) => approval.taskId === taskId);

  if (approvals.some((approval) => approval.status === "pending")) {
    return { status: "blocked", reasonCode: "pending_approval_exists" };
  }

  if (approvals.some((approval) => approval.status === "rejected")) {
    return { status: "blocked", reasonCode: "approval_rejected" };
  }

  if (approvals.some((approval) => approval.status === "cancelled")) {
    return { status: "blocked", reasonCode: "approval_cancelled" };
  }

  if (approvals.some((approval) => approval.status === "expired")) {
    return { status: "blocked", reasonCode: "approval_expired" };
  }

  // Clarification確認(Approvalと対称、taskId一致で絞り込む)。
  const clarifications = (await deps.listClarificationsForWork(workId, userId, accessToken))
    .filter((clarification) => clarification.taskId === taskId);

  if (clarifications.some((clarification) => clarification.status === "pending")) {
    return { status: "blocked", reasonCode: "pending_clarification_exists" };
  }

  if (clarifications.some((clarification) => clarification.status === "cancelled")) {
    return { status: "blocked", reasonCode: "clarification_cancelled" };
  }

  if (clarifications.some((clarification) => clarification.status === "expired")) {
    return { status: "blocked", reasonCode: "clarification_expired" };
  }

  // Run確認(絶対条件Step2「completed Runのdedup」「active/running Run
  // の存在」)。Task.status自体は既にpendingであることを確認済みだが、
  // Run側に既にcompleted/runningの記録が残っている場合(Task.status
  // 更新とRun作成/完了のタイミングずれ等)は、Task.statusの判定だけに
  // 頼らずRunの実体からも二重resumeを防ぐ(defense-in-depth、
  // Retry=new Runという既存不変条件を壊さないための追加確認)。
  const runs = await deps.listRunsForTask(workId, userId, accessToken, taskId);

  if (runs.some((run) => run.status === "completed")) {
    return { status: "already_terminal", reasonCode: "run_already_completed" };
  }

  if (runs.some((run) => run.status === "running")) {
    return { status: "blocked", reasonCode: "active_run_exists" };
  }

  return { status: "eligible" };

}

// =========================
// Step3 — Resume Intent / Request
// =========================
//
// Human Interaction resolutionとexecution再開の間に立つ、明示的な
// TACT-owned resume operation。「再開してよい」というcanonical判断
// までを行い、実際の再開(Provider呼び出し・Run作成・Trigger dispatch)
// はP6bのexecution layerの責務として残す(絶対条件、resolved≠resumed
// をここでも維持する——このoperation自身がexecutionを引き起こさない)。
//
// TaskResumeIntentは「実行してよい」という権限そのものを運ばない
// (絶対条件Step8-16「protected write authorization invariant維持」)
// ——workId/taskId/reason/eligibleAtという最小限のcanonical pointerと
// timestampだけを持つ、受け渡し用の平易なdata structureであり、
// credential・Runtime handle・provider referenceのいずれも含まない。
// 実際の実行権限は、既存のexecution boundary(core/tact-integration/
// execution.ts等)が、この関数とは独立に、都度自分自身の既存Policy
// recheck/Approval Integrity検証を通じてのみ持つ。
export interface TaskResumeIntent {

  workId: string;

  taskId: string;

  reason: TaskResumeTriggerReason;

  // eligibility確認を実際に行った時刻(ISO8601)。execution layer
  // 側が「この判断がどれだけ新しいか」を将来判断材料にできるよう
  // 残すだけで、有効期限のcanonical判定はP6aでは行わない。
  eligibleAt: string;

}

export type TaskResumeRequestOutcome =
  | { status: "prepared"; intent: TaskResumeIntent }
  | { status: "blocked"; reasonCode: TaskResumeEligibilityBlockedReasonCode }
  | { status: "already_terminal"; reasonCode: TaskResumeTerminalReasonCode };

export interface RequestTaskResumeParams {

  workId: string;

  userId: string;

  accessToken: string;

  taskId: string;

  reason: TaskResumeTriggerReason;

}

// Step6(Audit integration)についての判断: task.resume_requested/
// task.resume_eligible/task.resume_blockedをAudit Eventとして emitする
// 案を検討したが、既存tact_audit_eventsのevent_type CHECK制約
// (supabase/migrations/20260912000000_create_tact_audit_events.sql)は
// 既存14値の閉じたenumであり、新しいevent_typeを1つでも追加するには
// migrationでCHECK制約を変更する必要がある。P6aは「migrationは必要
// 最小限」「まずmigration 0で実現できるか評価する」という絶対条件の
// もとにあり、かつP6aの本質的成果(eligibility判定・resume intentの
// 型定義)はAudit記録が無くても完結するため、今回はAudit Event追加を
// 見送り、次フェーズ(P6b、実際にexecution layerへ接続する際に
// run.created等の既存event種別と合わせて設計する方が良い)へ明示的に
// DEFERする(Step6の「不要なら次フェーズへDEFER」という指示に対する
// 判断であり、実装漏れではない)。Audit未実装であっても、Audit
// failureがbusiness pathを壊さないという既存原則(emitAuditSafely()の
// 設計そのもの)に反する変更は一切行っていない。
export async function requestTaskResume(
  params: RequestTaskResumeParams,
  deps: TaskResumeEligibilityDeps = defaultDeps
): Promise<TaskResumeRequestOutcome> {

  // 絶対条件Step3-1: eligibility再確認。callerが以前確認した結果を
  // 信用せず、この呼び出し自身が毎回最新の状態を読み直す(Step5
  // 「同一入力に対してdeterministicな結果になる」ことの前提でもある
  // ——read-onlyな現在状態だけから導出されるため、複数回呼んでも
  // 状態が変化しない限り常に同じ結果になる)。
  const eligibility = await evaluateTaskResumeEligibility(params, deps);

  if (eligibility.status === "blocked") {
    return { status: "blocked", reasonCode: eligibility.reasonCode };
  }

  if (eligibility.status === "already_terminal") {
    return { status: "already_terminal", reasonCode: eligibility.reasonCode };
  }

  return {
    status: "prepared",
    intent: {
      workId: params.workId,
      taskId: params.taskId,
      reason: params.reason,
      eligibleAt: new Date().toISOString(),
    },
  };

}
