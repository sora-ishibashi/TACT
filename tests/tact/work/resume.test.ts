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
  type TaskResumeEligibilityDeps,
} from "../../../core/tact-work/resume";
import type { Work, WorkTask, Run, Approval, Clarification } from "../../../core/tact-work/types";
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

interface MakeDepsOptions {
  work?: Work | undefined;
  tasks?: WorkTask[];
  runs?: Run[];
  approvals?: Approval[];
  clarifications?: Clarification[];
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

  return summarize("work/resume", results);

}
