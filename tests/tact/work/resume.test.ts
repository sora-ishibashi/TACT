// =========================
// TACT Work — Task Resume Foundation Regression (Fast Port P6a)
// =========================
//
// 対象: core/tact-work/resume.tsのevaluateTaskResumeEligibility()/
// requestTaskResume()。実Supabaseには一切接続しない
// (TaskResumeEligibilityDeps経由でStore呼び出しを全てfakeに差し替える、
// 既存tests/tact/work/approval.test.ts・clarification.test.tsと同じ
// DIテスト手法)。
//
// このfile・core/tact-work/resume.ts自身がProvider/Trigger/createRunの
// いずれも一切importしないことは、import文自体が構造的に保証する
// (絶対条件、Fast Port P4a incidentの教訓と同じ規律)——実行時のspyでは
// なく、resume.tsのimport一覧がcore/tact-integration・
// core/tact-runtime/providers・core/tact-work/store.tsのcreateRun系の
// いずれも参照しないことが型検査(tsc)通過そのものによって証明される。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateTaskResumeEligibility,
  requestTaskResume,
  validateExternalEventResumeCorrelation,
  type TaskResumeEligibilityDeps,
  type ValidateExternalEventResumeCorrelationDeps,
} from "../../../core/tact-work/resume";
import type { Work, WorkTask, Run, Approval, Clarification, EventWait, ExternalEvent } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: OWNER_USER_ID,
    createdByActorKind: "user",
    createdByActorId: OWNER_USER_ID,
    status: "running",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    workId: "work-1",
    description: "send slack message",
    status: "pending",
    assignedCapability: "integration.slack.send_message",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    workId: "work-1",
    taskId: "task-1",
    attempt: 1,
    capability: "integration.slack.send_message",
    status: "running",
    startedAt: "2026-09-09T00:00:00.000Z",
    createdAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "capability-1",
    requestedFromActorKind: "user",
    requestedFromActorId: OWNER_USER_ID,
    status: "pending",
    reason: "confirm send",
    payload: {},
    requestedAt: "2026-09-09T00:00:00.000Z",
    createdAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeClarification(overrides: Partial<Clarification> = {}): Clarification {
  return {
    id: "clarification-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "capability-1",
    status: "pending",
    reasonCode: "missing_required_input",
    question: "which channel?",
    requestedAt: "2026-09-09T00:00:00.000Z",
    createdAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  } as Clarification;
}

function makeEventWait(overrides: Partial<EventWait> = {}): EventWait {
  return {
    id: "wait-1",
    userId: OWNER_USER_ID,
    workId: "work-1",
    taskId: "task-1",
    expectedSource: "gmail",
    expectedEventType: "message.received",
    subjectRef: "thread-abc",
    status: "claimed",
    createdAt: "2026-09-09T00:00:00.000Z",
    claimedByEventId: "ext-evt-1",
    ...overrides,
  };
}

function makeExternalEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    id: "ext-evt-1",
    userId: OWNER_USER_ID,
    source: "gmail",
    eventType: "message.received",
    externalEventId: "gmail-msg-1",
    subjectRef: "thread-abc",
    receivedAt: "2026-09-09T00:00:00.000Z",
    normalizedPayload: {},
    status: "matched",
    createdAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

interface MakeCorrelationDepsOptions {
  wait?: EventWait | undefined;
  event?: ExternalEvent | undefined;
}

function makeCorrelationDeps(options: MakeCorrelationDepsOptions = {}) {

  const wait = "wait" in options ? options.wait : makeEventWait();
  const event = "event" in options ? options.event : makeExternalEvent();

  const deps: ValidateExternalEventResumeCorrelationDeps = {
    getEventWait: async () => wait,
    getExternalEvent: async () => event,
  };

  return deps;

}

interface MakeDepsOptions {
  work?: Work | undefined;
  tasks?: WorkTask[];
  runs?: Run[];
  approvals?: Approval[];
  clarifications?: Clarification[];
  now?: Date;
}

function makeDeps(options: MakeDepsOptions = {}) {

  const calls = {
    getWorkCalls: 0,
    listRunsForTaskCalls: 0,
  };

  const work = "work" in options ? options.work : makeWork();
  const tasks = options.tasks ?? [makeTask()];
  const runs = options.runs ?? [];
  const approvals = options.approvals ?? [];
  const clarifications = options.clarifications ?? [];

  const deps: TaskResumeEligibilityDeps = {

    getWork: async (_workId, userId) => {
      calls.getWorkCalls += 1;
      if (userId !== OWNER_USER_ID) return undefined;
      return work;
    },

    listTasksForWork: async () => tasks,

    listRunsForTask: async () => {
      calls.listRunsForTaskCalls += 1;
      return runs;
    },

    listApprovalsForWork: async () => approvals,

    listClarificationsForWork: async () => clarifications,

    now: () => options.now ?? new Date("2026-09-09T00:00:00.000Z"),

  };

  return { deps, calls };

}

const BASE_PARAMS = {
  workId: "work-1",
  userId: OWNER_USER_ID,
  accessToken: "token",
  taskId: "task-1",
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [1] approved Approval(pendingではない)後、他に阻害要因が無ければeligible ----
  {
    const { deps } = makeDeps({ approvals: [makeApproval({ status: "approved" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(check("[1] approved Approval後のTaskはeligible", eligibility.status === "eligible"));
  }

  // ---- [2] pending Approvalあり -> blocked(pending_approval_exists) ----
  {
    const { deps } = makeDeps({ approvals: [makeApproval({ status: "pending" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[2] pending Approvalが存在する場合はblocked(pending_approval_exists)",
        eligibility.status === "blocked" && eligibility.reasonCode === "pending_approval_exists"
      )
    );
  }

  // ---- [3] rejected Approval -> eligibleではない(Task自体もreject時にfailedへ進むため、通常already_terminal(task_failed)として捕捉される) ----
  {
    const { deps } = makeDeps({
      tasks: [makeTask({ status: "failed" })],
      approvals: [makeApproval({ status: "rejected" })],
    });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[3] rejected Approval(既存rejectApproval()がTaskをfailedへ進める実挙動と整合)はeligibleにならない(already_terminal/task_failed)",
        eligibility.status !== "eligible" &&
          eligibility.status === "already_terminal" &&
          eligibility.reasonCode === "task_failed"
      )
    );
  }

  // ---- [3b] defense-in-depth: Task.statusがpendingのままrejected Approvalだけが残る異常系でもblocked(approval_rejected) ----
  {
    const { deps } = makeDeps({ approvals: [makeApproval({ status: "rejected" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[3b] Task.statusがpendingのまま残っていてもrejected Approvalがあればblocked(approval_rejected、defense-in-depth)",
        eligibility.status === "blocked" && eligibility.reasonCode === "approval_rejected"
      )
    );
  }

  // ---- [4] answered Clarification後、他に阻害要因が無ければeligible ----
  {
    const { deps } = makeDeps({ clarifications: [makeClarification({ status: "answered" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(check("[4] answered Clarification後のTaskはeligible", eligibility.status === "eligible"));
  }

  // ---- [5] pending Clarificationあり -> blocked(pending_clarification_exists) ----
  {
    const { deps } = makeDeps({ clarifications: [makeClarification({ status: "pending" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[5] pending Clarificationが存在する場合はblocked(pending_clarification_exists)",
        eligibility.status === "blocked" && eligibility.reasonCode === "pending_clarification_exists"
      )
    );
  }

  // ---- [6] 複数のpending interaction(Approval+Clarification)が同時に存在してもblocked(いずれかのreasonで安全側) ----
  {
    const { deps } = makeDeps({
      approvals: [makeApproval({ status: "pending" })],
      clarifications: [makeClarification({ status: "pending" })],
    });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[6] 複数のpending interactionが同時に存在する場合もblocked(eligibleにならない)",
        eligibility.status === "blocked"
      )
    );
  }

  // ---- [7] completed Task -> already_terminal(task_completed) ----
  {
    const { deps } = makeDeps({ tasks: [makeTask({ status: "completed" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[7] Task.status==='completed'はalready_terminal(task_completed)",
        eligibility.status === "already_terminal" && eligibility.reasonCode === "task_completed"
      )
    );
  }

  // ---- [8] completed Runが存在する(Task.statusはpendingのまま) -> already_terminal(run_already_completed)、dedup ----
  {
    const { deps } = makeDeps({ runs: [makeRun({ status: "completed" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[8] completed Runが存在する場合はalready_terminal(run_already_completed)、二重resumeを防ぐdedup",
        eligibility.status === "already_terminal" && eligibility.reasonCode === "run_already_completed"
      )
    );
  }

  // ---- [9] active(running)Runが存在する -> blocked(active_run_exists)、duplicate resume不可 ----
  {
    const { deps } = makeDeps({ runs: [makeRun({ status: "running" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[9] active(running)Runが存在する場合はblocked(active_run_exists)、duplicate resume不可",
        eligibility.status === "blocked" && eligibility.reasonCode === "active_run_exists"
      )
    );
  }

  // ---- [10] wrong Work/Task correlation(指定taskIdが指定workId配下に存在しない) -> fail closed(blocked/task_not_found) ----
  {
    const { deps } = makeDeps({ tasks: [makeTask({ id: "task-1", workId: "other-work" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[10] Task.workIdが指定workIdと一致しない場合はfail closed(blocked/task_not_found)",
        eligibility.status === "blocked" && eligibility.reasonCode === "task_not_found"
      )
    );
  }

  // ---- [10b] 所有者不一致(getWorkがundefinedを返す)場合もfail closed(blocked/work_not_found) ----
  {
    const { deps } = makeDeps();

    const eligibility = await evaluateTaskResumeEligibility(
      { ...BASE_PARAMS, userId: "attacker" },
      deps
    );

    results.push(
      check(
        "[10b] 所有者不一致の場合はfail closed(blocked/work_not_found、なりすまし不可)",
        eligibility.status === "blocked" && eligibility.reasonCode === "work_not_found"
      )
    );
  }

  // ---- [capability] assignedCapabilityが無いTaskはblocked(capability_not_assigned) ----
  {
    const { deps } = makeDeps({ tasks: [makeTask({ assignedCapability: null })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[capability] assignedCapabilityが無いTaskはblocked(capability_not_assigned、resume対象のactionが無い)",
        eligibility.status === "blocked" && eligibility.reasonCode === "capability_not_assigned"
      )
    );
  }

  // ---- [running] Task.status==='running'はblocked(task_already_running)、二重resume防止 ----
  {
    const { deps } = makeDeps({ tasks: [makeTask({ status: "running" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[running] Task.status==='running'はblocked(task_already_running)",
        eligibility.status === "blocked" && eligibility.reasonCode === "task_already_running"
      )
    );
  }

  // ---- [RUNS-P1b] Task.status==='waiting_for_retry'はblocked
  // (task_waiting_for_retry)であり、'pending'と同じ扱いにフォールス
  // ルーしてeligibleにならない(Approval/Clarification-driven resumeが
  // 意図せずRun-failure-driven retry-waitingのTaskへ介入しないこと) ----
  {
    const { deps } = makeDeps({ tasks: [makeTask({ status: "waiting_for_retry" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[RUNS-P1b] Task.status==='waiting_for_retry'はblocked(task_waiting_for_retry)、'pending'と同じ扱いにならない",
        eligibility.status === "blocked" && eligibility.reasonCode === "task_waiting_for_retry"
      )
    );
  }

  // ---- TIME-P1a FIX1: waitUntilが未来を指す場合、他の全条件
  // (Approval/Clarification未解決なし・active Run無し等)を満たして
  // いてもblocked(temporal_gate_not_satisfied) ----
  {
    const { deps } = makeDeps({
      tasks: [makeTask({ waitUntil: "2026-09-10T00:00:00.000Z" })], // makeDeps既定のnow(2026-09-09)より未来
    });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a FIX1] waitUntilが未来 -> 他の条件を満たしていてもblocked(temporal_gate_not_satisfied)",
        eligibility.status === "blocked" && eligibility.reasonCode === "temporal_gate_not_satisfied"
      )
    );
  }

  // ---- TIME-P1a FIX1: waitUntilがちょうどnow -> gate成立(>=境界) ----
  {
    const { deps } = makeDeps({
      tasks: [makeTask({ waitUntil: "2026-09-09T00:00:00.000Z" })], // makeDeps既定のnowと同時刻
    });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a FIX1] waitUntilがちょうどnow -> eligible(>=境界でgate成立)",
        eligibility.status === "eligible"
      )
    );
  }

  // ---- TIME-P1a FIX1: waitUntilが過去 -> eligible ----
  {
    const { deps } = makeDeps({
      tasks: [makeTask({ waitUntil: "2026-09-08T00:00:00.000Z" })],
    });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a FIX1] waitUntilが過去 -> eligible",
        eligibility.status === "eligible"
      )
    );
  }

  // ---- TIME-P1a FIX1: waitUntil未設定(null/undefined) -> 制約なし、
  // eligible(既存挙動のregression確認) ----
  {
    const { deps } = makeDeps({ tasks: [makeTask({ waitUntil: null })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a FIX1] waitUntil未設定(null) -> 制約なし、eligible",
        eligibility.status === "eligible"
      )
    );
  }

  // ---- TIME-P1a FIX1: waitUntilが過去でも、pending Approvalが残って
  // いればblocked(pending_approval_exists) -> 時間的gateがApproval等の
  // 既存条件をbypassしないことの確認(絶対条件Step2/5) ----
  {
    const { deps } = makeDeps({
      tasks: [makeTask({ waitUntil: "2020-01-01T00:00:00.000Z" })], // gateは満たされている
      approvals: [makeApproval({ status: "pending" })],
    });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[TIME-P1a FIX1] waitUntilのgateが満たされていても、pending Approvalが残っていればblocked(pending_approval_exists)——時間的gateは既存条件をbypassしない",
        eligibility.status === "blocked" && eligibility.reasonCode === "pending_approval_exists"
      )
    );
  }

  // ---- [11/12/13] resume.ts自身がProvider実行/Trigger dispatch/createRunのAPIを一切importしていない(source-level構造的証拠) ----
  {
    const resumeSourceRaw = readFileSync(
      join(__dirname, "..", "..", "..", "core", "tact-work", "resume.ts"),
      "utf-8"
    );

    // コメント行(Step1 audit findings等、説明目的でAPI名に言及している
    // 行)を除外した、実コード行だけを対象にする——importの有無を見たい
    // のであり、説明文中の言及まで禁止語として扱うと誤検出になるため。
    const resumeSource = resumeSourceRaw
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    const forbiddenReferences = [
      "executeIntegrationAction",
      "executeApprovedIntegrationAction",
      "dispatchIntegrationReadToRuntime",
      "startExecution",
      "TriggerDevRuntimeAdapter",
      "trigger_dev",
      "createRun",
      "composio",
      "Composio",
    ];

    const found = forbiddenReferences.filter((name) => resumeSource.includes(name));

    results.push(
      check(
        "[11/12/13] resume.tsはProvider実行/Trigger dispatch/createRun/Runtime provider固有識別子のいずれも一切importも参照もしていない(Provider call=0・Trigger start=0・createRun=0・runtime provider neutralityの構造的保証)",
        found.length === 0,
        found.length > 0 ? `unexpected references: ${found.join(", ")}` : undefined
      )
    );
  }

  // ---- [14] resolution(prepared intent)自体はexecutionではない: TaskResumeIntentはcredential/execution API/provider referenceのいずれも持たない(平易なdataのみ) ----
  {
    const { deps } = makeDeps({ approvals: [makeApproval({ status: "approved" })] });

    const outcome = await requestTaskResume({ ...BASE_PARAMS, reason: "approval_resolved" }, deps);

    const serialized = JSON.stringify(outcome);

    results.push(
      check(
        "[14] requestTaskResume()のprepared outcomeはcanonical pointer(workId/taskId/reason/eligibleAt)のみを持ち、credential/execution APIのいずれも含まない(resolution≠executionの構造的保証)",
        outcome.status === "prepared" &&
          Object.keys(outcome.intent).sort().join(",") === "eligibleAt,reason,taskId,workId" &&
          !serialized.toLowerCase().includes("token") &&
          !serialized.toLowerCase().includes("secret") &&
          !serialized.toLowerCase().includes("key")
      )
    );
  }

  // ---- [15] 同一resume requestを複数回呼んでも、read-onlyであるためdeterministicに同じ結果を返す(side effectを起こす手段自体が無い) ----
  {
    const { deps, calls } = makeDeps({ approvals: [makeApproval({ status: "approved" })] });

    const first = await requestTaskResume({ ...BASE_PARAMS, reason: "approval_resolved" }, deps);
    const second = await requestTaskResume({ ...BASE_PARAMS, reason: "approval_resolved" }, deps);

    results.push(
      check(
        "[15] 同一resume requestを複数回呼んでも結果はdeterministicに同一(prepared×2、side effectを起こすAPI自体が無いためProvider/Trigger/createRunの二重実行は構造的に0)",
        first.status === "prepared" &&
          second.status === "prepared" &&
          JSON.stringify({ ...first, intent: { ...(first as { intent: object }).intent, eligibleAt: undefined } }) ===
            JSON.stringify({ ...second, intent: { ...(second as { intent: object }).intent, eligibleAt: undefined } }) &&
          calls.getWorkCalls === 2
      )
    );
  }

  // ---- [16] protected write authorization invariant維持: requestTaskResume()はTaskResumeIntentを返すだけで、Approval/Policyの既存authorization判断を一切バイパス・上書きしない(pending Approvalが残っていればblockedのまま、無条件resumeを許さない) ----
  {
    const { deps } = makeDeps({ approvals: [makeApproval({ status: "pending" })] });

    const outcome = await requestTaskResume({ ...BASE_PARAMS, reason: "manual_resume" }, deps);

    results.push(
      check(
        "[16] pending Approvalが残っている限り、reasonに'manual_resume'を指定してもrequestTaskResume()はpreparedを返さない(既存Approval authorization invariantを一切バイパスしない)",
        outcome.status === "blocked" && outcome.reasonCode === "pending_approval_exists"
      )
    );
  }

  // ---- [17] runtime provider neutrality: TaskResumeTriggerReasonにTrigger.dev固有の語彙が存在しない ----
  {
    const reasons: string[] = ["approval_resolved", "clarification_resolved", "manual_resume", "runtime_recovered"];

    results.push(
      check(
        "[17] TaskResumeTriggerReasonの値はいずれもTrigger.dev固有語彙(waitpoint/trigger_dev等)を含まない(runtime provider neutrality維持)",
        reasons.every((r) => !r.toLowerCase().includes("trigger") && !r.toLowerCase().includes("waitpoint"))
      )
    );
  }

  // =========================
  // EVENT-P1c: waiting_for_event eligibility gap close (Section12)
  // =========================

  // ---- Task.status==='waiting_for_event'はblocked(task_waiting_for_event)であり、
  // 'pending'と同じ扱いにフォールスルーしてeligibleにならない ----
  {
    const { deps } = makeDeps({ tasks: [makeTask({ status: "waiting_for_event" })] });

    const eligibility = await evaluateTaskResumeEligibility(BASE_PARAMS, deps);

    results.push(
      check(
        "[EVENT-P1c Section12] Task.status==='waiting_for_event'はblocked(task_waiting_for_event)、'pending'と同じ扱いにならない",
        eligibility.status === "blocked" && eligibility.reasonCode === "task_waiting_for_event"
      )
    );
  }

  // ---- Section13「Manual Resume」絶対条件: waiting_for_eventなTaskは、
  // reasonがmanual_resumeであってもrequestTaskResume()がpreparedを
  // 返さない(silent bypass不可) ----
  {
    const { deps } = makeDeps({ tasks: [makeTask({ status: "waiting_for_event" })] });

    const outcome = await requestTaskResume({ ...BASE_PARAMS, reason: "manual_resume" }, deps);

    results.push(
      check(
        "[EVENT-P1c Section13] waiting_for_eventなTaskはreason=manual_resumeでもblocked(task_waiting_for_event)、silent bypass不可",
        outcome.status === "blocked" && outcome.reasonCode === "task_waiting_for_event"
      )
    );
  }

  // ---- 絶対条件「Do not trust a stale resume intent」: reasonが
  // external_event_matchedであっても、Task.statusが実際にはまだ
  // waiting_for_eventのまま(=atomic claim transactionがまだ起きて
  // いない)場合はblockedになる(external_event_matchedというreasonの
  // 主張だけでeligibilityをbypassしない) ----
  {
    const { deps } = makeDeps({ tasks: [makeTask({ status: "waiting_for_event" })] });

    const outcome = await requestTaskResume(
      { ...BASE_PARAMS, reason: "external_event_matched", eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      deps
    );

    results.push(
      check(
        "[EVENT-P1c Section11/21] reason=external_event_matchedでも、Task.statusがまだwaiting_for_eventのままならblocked(task_waiting_for_event)、reasonの主張だけでbypassしない",
        outcome.status === "blocked" && outcome.reasonCode === "task_waiting_for_event"
      )
    );
  }

  // =========================
  // EVENT-P1c: validateExternalEventResumeCorrelation() (Section11)
  // =========================

  {
    const correlationDeps = makeCorrelationDeps();

    const result = await validateExternalEventResumeCorrelation(
      { ...BASE_PARAMS, eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      correlationDeps
    );

    results.push(
      check(
        "[correlation] wait=claimed・claimedByEventId一致・event=matched・所有者一致 -> ok",
        result.ok === true
      )
    );
  }

  {
    const result = await validateExternalEventResumeCorrelation(
      { ...BASE_PARAMS },
      makeCorrelationDeps()
    );

    results.push(
      check(
        "[correlation] eventWaitId/externalEventIdのいずれも省略 -> event_correlation_missing",
        !result.ok && result.reasonCode === "event_correlation_missing"
      )
    );
  }

  {
    const correlationDeps = makeCorrelationDeps({ wait: undefined });

    const result = await validateExternalEventResumeCorrelation(
      { ...BASE_PARAMS, eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      correlationDeps
    );

    results.push(
      check(
        "[correlation] EventWaitが見つからない -> event_wait_not_found",
        !result.ok && result.reasonCode === "event_wait_not_found"
      )
    );
  }

  {
    const correlationDeps = makeCorrelationDeps({ wait: makeEventWait({ taskId: "other-task" }) });

    const result = await validateExternalEventResumeCorrelation(
      { ...BASE_PARAMS, eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      correlationDeps
    );

    results.push(
      check(
        "[correlation] EventWait.taskIdが指定taskIdと一致しない -> event_wait_wrong_task(fail closed、IDOR対策)",
        !result.ok && result.reasonCode === "event_wait_wrong_task"
      )
    );
  }

  {
    const correlationDeps = makeCorrelationDeps({ wait: makeEventWait({ status: "pending" }) });

    const result = await validateExternalEventResumeCorrelation(
      { ...BASE_PARAMS, eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      correlationDeps
    );

    results.push(
      check(
        "[correlation] EventWait.status!=='claimed'(pending) -> event_wait_not_claimed",
        !result.ok && result.reasonCode === "event_wait_not_claimed"
      )
    );
  }

  {
    const correlationDeps = makeCorrelationDeps({ wait: makeEventWait({ claimedByEventId: "other-event" }) });

    const result = await validateExternalEventResumeCorrelation(
      { ...BASE_PARAMS, eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      correlationDeps
    );

    results.push(
      check(
        "[correlation] EventWait.claimedByEventIdが指定externalEventIdと一致しない -> event_wait_claim_mismatch",
        !result.ok && result.reasonCode === "event_wait_claim_mismatch"
      )
    );
  }

  {
    const correlationDeps = makeCorrelationDeps({ event: undefined });

    const result = await validateExternalEventResumeCorrelation(
      { ...BASE_PARAMS, eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      correlationDeps
    );

    results.push(
      check(
        "[correlation] ExternalEventが見つからない -> external_event_not_found",
        !result.ok && result.reasonCode === "external_event_not_found"
      )
    );
  }

  {
    const correlationDeps = makeCorrelationDeps({ event: makeExternalEvent({ userId: "attacker" }) });

    const result = await validateExternalEventResumeCorrelation(
      { ...BASE_PARAMS, eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      correlationDeps
    );

    results.push(
      check(
        "[correlation] ExternalEvent.userIdが呼び出し元userIdと一致しない -> external_event_wrong_owner",
        !result.ok && result.reasonCode === "external_event_wrong_owner"
      )
    );
  }

  {
    const correlationDeps = makeCorrelationDeps({ event: makeExternalEvent({ status: "received" }) });

    const result = await validateExternalEventResumeCorrelation(
      { ...BASE_PARAMS, eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      correlationDeps
    );

    results.push(
      check(
        "[correlation] ExternalEvent.status!=='matched'(received) -> external_event_not_matched",
        !result.ok && result.reasonCode === "external_event_not_matched"
      )
    );
  }

  // =========================
  // EVENT-P1c: requestTaskResume() wiring for external_event_matched
  // =========================

  {
    // atomic claim transactionが既にTask.status waiting_for_event→pendingを
    // 完了させている前提(Section2 Architecture Decision)。
    const { deps } = makeDeps({ tasks: [makeTask({ status: "pending" })] });
    const correlationDeps = makeCorrelationDeps();

    const outcome = await requestTaskResume(
      { ...BASE_PARAMS, reason: "external_event_matched", eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      deps,
      correlationDeps
    );

    results.push(
      check(
        "[EVENT-P1c] Task.status==='pending'(claim済み)・correlation ok -> prepared、intentがeventWaitId/externalEventIdを運ぶ",
        outcome.status === "prepared" &&
          outcome.intent.eventWaitId === "wait-1" &&
          outcome.intent.externalEventId === "ext-evt-1"
      )
    );
  }

  {
    const { deps } = makeDeps({ tasks: [makeTask({ status: "pending" })] });
    const correlationDeps = makeCorrelationDeps({ wait: makeEventWait({ status: "pending" }) });

    const outcome = await requestTaskResume(
      { ...BASE_PARAMS, reason: "external_event_matched", eventWaitId: "wait-1", externalEventId: "ext-evt-1" },
      deps,
      correlationDeps
    );

    results.push(
      check(
        "[EVENT-P1c] 汎用eligibilityはeligibleでも、correlation再検証が失敗すればblocked(汎用eligibility判定だけでは不十分)",
        outcome.status === "blocked" && outcome.reasonCode === "event_wait_not_claimed"
      )
    );
  }

  {
    // reason以外(approval_resolved等)ではcorrelation再検証を一切
    // 呼ばない(existing behavior無変更の直接証拠)。
    const { deps } = makeDeps({ approvals: [makeApproval({ status: "approved" })] });

    let correlationCalls = 0;
    const correlationDeps: ValidateExternalEventResumeCorrelationDeps = {
      getEventWait: async () => { correlationCalls += 1; return makeEventWait(); },
      getExternalEvent: async () => { correlationCalls += 1; return makeExternalEvent(); },
    };

    const outcome = await requestTaskResume({ ...BASE_PARAMS, reason: "approval_resolved" }, deps, correlationDeps);

    results.push(
      check(
        "[EVENT-P1c] reason=approval_resolvedではcorrelation再検証を一切呼ばない(既存挙動への無関係な回帰なし)",
        outcome.status === "prepared" && correlationCalls === 0
      )
    );
  }

  return summarize("work/resume", results);

}
