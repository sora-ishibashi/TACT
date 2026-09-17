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
  getEventWait,
  getExternalEvent,
} from "./store";
// TIME-P1a FIX1: waitUntilを、このfileが扱うApproval/Clarification
// 解決by resumeの最後のgateとして追加する。時間はgateを追加するだけで
// あり、Approval/Clarification/active Run保護のいずれもbypassしない
// (このfileの既存チェックが全て通過した後にだけ評価される)。
import { isWaitUntilSatisfied } from "./temporal";

// =========================
// Step4 — Resume Trigger Reason Model
// =========================
//
// 絶対条件: resume reason(なぜresumeが要求されたか)と、eligibility
// blocked reason(なぜresume不可か)を混同しない——別の型として独立
// させる(下記TaskResumeBlockedReasonCode/TaskResumeTerminalReasonCode
// と共通の語彙を持たせない)。Trigger.dev固有のreason(Waitpoint等)は
// 一切含めない。
// EVENT-P1a: "external_event_matched"を型としてのみ追加する
// (compile-safeな拡張、Architecture Audit Section11)。このphaseでは
// 一切のcallerがこの値を生成・消費しない——EventWaitのclaim/matching
// 実行(EVENT-P1c)が実装されて初めて、requestTaskResume()の呼び出し元
// がreasonとして渡すようになる。
export type TaskResumeTriggerReason =
  | "approval_resolved"
  | "clarification_resolved"
  | "manual_resume"
  | "runtime_recovered"
  | "external_event_matched";

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
  | "active_run_exists"
  // RUNS-P1b: waiting_for_retryは、Approval/Clarification解決
  // (このfileが扱うtrigger)とは別種のtrigger(直近のRun failureが
  // retryableだった)によるresumeを待つ状態であり、このfileの
  // resume対象ではない——混同を防ぐため、"pending"と同じ扱いに
  // フォールスルーさせず、専用のblocked reasonを明示する
  // (core/tact-work/taskRunReconciliation.tsの
  // evaluateTaskRetryEligibility()がこのTask用の別のeligibility判定を
  // 持つ)。
  | "task_waiting_for_retry"
  // EVENT-P1c(P1a Architecture Auditで明示されたgapのclose、
  // Section12): task.status==="waiting_for_event"は、"waiting_for_retry"
  // と同じ理由でこのfileのApproval/Clarification-driven resumeの対象
  // ではない——このfileがwaiting_for_eventを一般に"resumable"だと
  // 報告することは絶対に無い。唯一の例外(reason==="external_event_matched"
  // による正当なresume)は、この分岐に到達する前に、atomic claim
  // transaction(supabase/migrations/20261016010000_create_event_wait_
  // claim_functions.sqlのtact_claim_matched_event_wait())が既にTask を
  // waiting_for_event→pendingへ遷移させ終えている前提で動く——つまり
  // この関数が実際にwaiting_for_eventなTaskを見る時点で、それは
  // 「まだatomic claimが起きていない」ことを意味し、reasonが
  // external_event_matchedであってもblockするのが正しい(stale/不正な
  // resume intentを信用しない、絶対条件「Do not trust a stale resume
  // intent」)。
  | "task_waiting_for_event"
  // TIME-P1a FIX1: WorkTask.waitUntilが未来を指しているため、他の
  // 全条件(Approval/Clarification未解決なし・active Run無し等)を
  // 満たしていても、まだ時間的にresumeが許されていない。waitUntil
  // 未設定(null)の場合はこの理由に到達しない。
  | "temporal_gate_not_satisfied";

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

  // TIME-P1a FIX1: core/tact-work/taskRunReconciliation.tsの
  // TaskRetryEligibilityDeps.nowと同じ、注入可能な現在時刻(絶対条件:
  // 内部でnew Date()を直接呼ばない、決定論的なtestを可能にする)。
  now: () => Date;

}

const defaultDeps: TaskResumeEligibilityDeps = {
  getWork,
  listTasksForWork,
  listRunsForTask,
  listApprovalsForWork,
  listClarificationsForWork,
  now: () => new Date(),
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

  // RUNS-P1b: task.status==="waiting_for_retry"は、Run failure
  // retryabilityというこのfileが扱わない別種のtriggerによる状態
  // ——"pending"と同じ扱いにフォールスルーさせない(このfileの
  // Approval/Clarification-driven resumeが、意図せずretry-waiting
  // Taskへ介入しないようにする)。
  if (task.status === "waiting_for_retry") {
    return { status: "blocked", reasonCode: "task_waiting_for_retry" };
  }

  // EVENT-P1c(Section12): waiting_for_eventも同様にフォールスルー
  // させない。Section13「Manual Resume」絶対条件もこの1分岐だけで
  // 満たされる——reasonに関わらず(manual_resume/runtime_recovered/
  // external_event_matchedのいずれであっても)、Task.statusが実際に
  // waiting_for_eventのままである限りblockする。
  if (task.status === "waiting_for_event") {
    return { status: "blocked", reasonCode: "task_waiting_for_event" };
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

  // TIME-P1a FIX1(最後のgate、Approval/Clarification/active Run
  // 保護のいずれも通過した後にだけ評価する): task.waitUntil未設定
  // (null)の場合、isWaitUntilSatisfied()はtrueを返す(gateなし)。
  if (!isWaitUntilSatisfied(deps.now(), task.waitUntil)) {
    return { status: "blocked", reasonCode: "temporal_gate_not_satisfied" };
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

  // EVENT-P1c(Section11「Resume Intent」絶対条件): reason===
  // "external_event_matched"の場合のみ意味を持つ、durable correlationの
  // pointer。TaskResumeIntent自身は依然として実行権限を運ばない
  // (このIDだけでは何も起こせない、下記validateExternalEventResume
  // Correlation()がexecutePreparedTaskResume()側で改めてEventWait/
  // ExternalEventの現在状態を再取得・再検証する——intentに書かれた
  // 値をそのまま信用しない、「stale resume intentを信用しない」絶対
  // 条件)。
  eventWaitId?: string;

  externalEventId?: string;

  // eligibility確認を実際に行った時刻(ISO8601)。execution layer
  // 側が「この判断がどれだけ新しいか」を将来判断材料にできるよう
  // 残すだけで、有効期限のcanonical判定はP6aでは行わない。
  eligibleAt: string;

}

// EVENT-P1c(Section11): 汎用eligibility判定(TaskResumeEligibility
// BlockedReasonCode)とは別の型として独立させる——このfileの既存規律
// (resume reasonとblocked reasonを混同しない)と同じ理由で、
// 「event correlationがなぜ拒否されたか」を専用のreason code群として
// 表現する。
export type ExternalEventResumeCorrelationBlockedReasonCode =
  | "event_correlation_missing"
  | "event_wait_not_found"
  | "event_wait_wrong_task"
  | "event_wait_not_claimed"
  | "event_wait_claim_mismatch"
  | "external_event_not_found"
  | "external_event_wrong_owner"
  | "external_event_not_matched";

export type TaskResumeRequestOutcome =
  | { status: "prepared"; intent: TaskResumeIntent }
  | {
      status: "blocked";
      reasonCode: TaskResumeEligibilityBlockedReasonCode | ExternalEventResumeCorrelationBlockedReasonCode;
    }
  | { status: "already_terminal"; reasonCode: TaskResumeTerminalReasonCode };

export interface RequestTaskResumeParams {

  workId: string;

  userId: string;

  accessToken: string;

  taskId: string;

  reason: TaskResumeTriggerReason;

  // EVENT-P1c: reason==="external_event_matched"のときのみ必須
  // (省略した場合、下記validateExternalEventResumeCorrelation()が
  // "event_correlation_missing"としてblockする——silent bypassを防ぐ)。
  eventWaitId?: string;

  externalEventId?: string;

}

export interface ValidateExternalEventResumeCorrelationDeps {

  getEventWait: typeof getEventWait;

  getExternalEvent: typeof getExternalEvent;

}

const defaultValidateExternalEventResumeCorrelationDeps: ValidateExternalEventResumeCorrelationDeps = {
  getEventWait,
  getExternalEvent,
};

export type ValidateExternalEventResumeCorrelationResult =
  | { ok: true }
  | { ok: false; reasonCode: ExternalEventResumeCorrelationBlockedReasonCode };

// EVENT-P1c(Section11絶対条件、最重要): reason==="external_event_matched"
// によるresumeは、汎用eligibility判定(waiting_for_event→pendingへの
// 遷移が既にatomic claim transactionで起きていることの確認)だけでは
// 不十分——「どのEventWait/ExternalEventによってpendingになったのか」
// というdurable correlationそのものを、この呼び出し自身が毎回
// 再検証する(prepared intentに書かれたeventWaitId/externalEventIdを
// 単なるlookup keyとしてのみ使い、その正しさ・現在の状態は一切信用
// しない——他のeligibility判定と同じ「stale intentを信用しない」
// 設計原則)。requestTaskResume()・executePreparedTaskResume()の
// 両方から呼ばれる(Section11「At BOTH」)、単一のcanonical実装。
export async function validateExternalEventResumeCorrelation(
  params: {
    workId: string;
    userId: string;
    accessToken: string;
    taskId: string;
    eventWaitId?: string;
    externalEventId?: string;
  },
  deps: ValidateExternalEventResumeCorrelationDeps = defaultValidateExternalEventResumeCorrelationDeps
): Promise<ValidateExternalEventResumeCorrelationResult> {

  const { workId, userId, accessToken, taskId, eventWaitId, externalEventId } = params;

  if (!eventWaitId || !externalEventId) {
    return { ok: false, reasonCode: "event_correlation_missing" };
  }

  const wait = await deps.getEventWait(workId, userId, accessToken, eventWaitId);

  if (!wait) {
    return { ok: false, reasonCode: "event_wait_not_found" };
  }

  if (wait.taskId !== taskId || wait.workId !== workId) {
    return { ok: false, reasonCode: "event_wait_wrong_task" };
  }

  if (wait.status !== "claimed") {
    return { ok: false, reasonCode: "event_wait_not_claimed" };
  }

  if (wait.claimedByEventId !== externalEventId) {
    return { ok: false, reasonCode: "event_wait_claim_mismatch" };
  }

  const event = await deps.getExternalEvent(userId, accessToken, externalEventId);

  if (!event) {
    return { ok: false, reasonCode: "external_event_not_found" };
  }

  if (event.userId !== userId) {
    return { ok: false, reasonCode: "external_event_wrong_owner" };
  }

  if (event.status !== "matched") {
    return { ok: false, reasonCode: "external_event_not_matched" };
  }

  return { ok: true };

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
  deps: TaskResumeEligibilityDeps = defaultDeps,
  // EVENT-P1c: evaluateTaskResumeEligibility()自身は一切使わない、
  // reason==="external_event_matched"専用の追加deps。既存の
  // TaskResumeEligibilityDeps自体は変更しない(既存呼び出し元・
  // 既存testのfixtureへ無関係なripple effectを起こさないため、
  // 新しいoptional第3引数として独立させる)。
  correlationDeps: ValidateExternalEventResumeCorrelationDeps = defaultValidateExternalEventResumeCorrelationDeps
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

  // EVENT-P1c(Section11「At BOTH: requestTaskResume() and
  // executePreparedTaskResume()」): 汎用eligibilityが"eligible"を
  // 返しても、reasonがexternal_event_matchedの場合はdurable
  // correlationの再検証を追加で必ず通す。
  if (params.reason === "external_event_matched") {

    const correlation = await validateExternalEventResumeCorrelation(params, correlationDeps);

    if (!correlation.ok) {
      return { status: "blocked", reasonCode: correlation.reasonCode };
    }

  }

  return {
    status: "prepared",
    intent: {
      workId: params.workId,
      taskId: params.taskId,
      reason: params.reason,
      // 絶対条件(既存test [14]「intentはcanonical pointerのみを持つ」
      // の意味をそのまま維持): reason!=="external_event_matched"の
      // 呼び出しでは、eventWaitId/externalEventIdをkey自体として持たない
      // (値をundefinedのまま代入すると、Object.keys()にはkey名が残って
      // しまうため、conditional spreadでkey自体の有無を制御する)。
      ...(params.eventWaitId !== undefined ? { eventWaitId: params.eventWaitId } : {}),
      ...(params.externalEventId !== undefined ? { externalEventId: params.externalEventId } : {}),
      eligibleAt: new Date().toISOString(),
    },
  };

}
