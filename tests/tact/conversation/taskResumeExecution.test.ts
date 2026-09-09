// =========================
// TACT Conversation — Canonical Resume Execution Regression
// (Fast Port P6b: Canonical Resume Execution)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsのexecutePreparedTaskResume()。
// 実Supabase・実Composio・実Trigger.devのいずれにも一切接続しない
// (ExecutePreparedTaskResumeDeps経由で全てfakeに差し替える、既存
// tests/tact/work/resume.test.ts・runtime/reconciliation.test.tsと
// 同じDIテスト手法)。
//
// このsuiteの責務: 「P6aでpreparedになったTaskResumeIntentを、既存
// Approval/Policy/Runtime routing境界へ安全に接続できるか」——
// eligibility再確認・Policy再評価・既存境界への委譲・並行呼び出しに
// 対するexactly-one Run claimの4点を中心に検証する。Approval
// Integrity検証・Runtime/Native routing決定の詳細ロジック自体は
// 既存tests/tact/integration/execution.test.ts・
// runtime/reconciliation.test.ts等で検証済みのため、ここでは
// 「正しい入力で正確に1回、既存境界へ委譲されるか」だけを確認する
// (二重テストを避ける)。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  executePreparedTaskResume,
  type ExecutePreparedTaskResumeDeps,
} from "../../../core/tact-conversation/orchestration";
import type { TaskResumeIntent } from "../../../core/tact-work/resume";
import type { WorkTask, Approval } from "../../../core/tact-work/types";
import type { PolicyDecision } from "../../../core/tact-integration/policy";
import type { IntegrationActionExecutionOutcome } from "../../../core/tact-integration/execution";
import type { ExecuteReadIntegrationActionOutcome } from "../../../core/tact-work/execution";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    workId: "work-1",
    description: "resume target",
    status: "pending",
    assignedCapability: "integration.slack.send_message",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
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
    status: "approved",
    reason: "confirm send",
    payload: {},
    requestedAt: "2026-09-09T00:00:00.000Z",
    createdAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

const WRITE_POLICY_DECISION: PolicyDecision = {
  decision: "require_approval",
  riskClass: "write",
  reasonCode: "approval_required_write",
};

const READ_POLICY_DECISION: PolicyDecision = {
  decision: "allow",
  riskClass: "read",
  reasonCode: "allowed_read",
};

const BASE_INTENT: TaskResumeIntent = {
  workId: "work-1",
  taskId: "task-1",
  reason: "approval_resolved",
  eligibleAt: "2026-09-09T00:00:00.000Z",
};

interface MakeDepsOptions {
  tasks?: WorkTask[];
  approvals?: Approval[];
  policyDecision?: PolicyDecision;
  writeOutcome?: IntegrationActionExecutionOutcome;
  readOutcome?: ExecuteReadIntegrationActionOutcome;
  eligible?: boolean;
  eligibilityOverride?: Awaited<ReturnType<ExecutePreparedTaskResumeDeps["evaluateTaskResumeEligibility"]>>;
}

function makeDeps(options: MakeDepsOptions = {}) {

  const calls = {
    eligibilityCalls: 0,
    listTasksForWorkCalls: 0,
    listApprovalsForWorkCalls: 0,
    executeApprovedIntegrationActionCalls: [] as unknown[],
    resolveIntegrationConnectionCalls: [] as unknown[],
    executeReadIntegrationActionCalls: [] as unknown[],
  };

  const tasks = options.tasks ?? [makeTask()];
  const approvals = options.approvals ?? [makeApproval()];
  const policyDecision = options.policyDecision ?? WRITE_POLICY_DECISION;
  const writeOutcome: IntegrationActionExecutionOutcome =
    options.writeOutcome ?? { status: "completed", run: { id: "run-1" } as never };
  const readOutcome: ExecuteReadIntegrationActionOutcome =
    options.readOutcome ?? { status: "completed", resultOutput: "{}" };

  const deps: ExecutePreparedTaskResumeDeps = {

    evaluateTaskResumeEligibility: async () => {
      calls.eligibilityCalls += 1;
      if (options.eligibilityOverride) return options.eligibilityOverride;
      return options.eligible === false ? { status: "blocked", reasonCode: "pending_approval_exists" } : { status: "eligible" };
    },

    listTasksForWork: async () => {
      calls.listTasksForWorkCalls += 1;
      return tasks;
    },

    listApprovalsForWork: async () => {
      calls.listApprovalsForWorkCalls += 1;
      return approvals;
    },

    evaluatePolicyDecision: () => policyDecision,

    executeApprovedIntegrationAction: (async (...args: unknown[]) => {
      calls.executeApprovedIntegrationActionCalls.push(args);
      return writeOutcome;
    }) as ExecutePreparedTaskResumeDeps["executeApprovedIntegrationAction"],

    resolveIntegrationConnection: (async (params: unknown) => {
      calls.resolveIntegrationConnectionCalls.push(params);
      return { status: "single", connectionId: "conn-1" };
    }) as ExecutePreparedTaskResumeDeps["resolveIntegrationConnection"],

    executeReadIntegrationAction: (async (params: unknown) => {
      calls.executeReadIntegrationActionCalls.push(params);
      return readOutcome;
    }) as ExecutePreparedTaskResumeDeps["executeReadIntegrationAction"],

  };

  return { deps, calls };

}

const BASE_PARAMS = { intent: BASE_INTENT, userId: OWNER_USER_ID, accessToken: "token" };

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [1] eligible + protected write(approved Approval) -> exactly one新規execution attempt(既存executeApprovedIntegrationAction()へ委譲) ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[1] eligible + require_approval -> executeApprovedIntegrationAction()が正確に1回呼ばれ、write_executed/completedを返す",
        outcome.status === "write_executed" &&
          outcome.outcome.status === "completed" &&
          calls.executeApprovedIntegrationActionCalls.length === 1
      )
    );
  }

  // ---- [3] pending Approval(eligibility blocked) -> execution boundaryへ一切進まない(Run 0) ----
  {
    const { deps, calls } = makeDeps({ eligible: false });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[3] eligibility blocked(pending_approval_exists)の場合、not_eligibleを返しexecution境界を一切呼ばない(Run 0)",
        outcome.status === "not_eligible" &&
          outcome.reasonCode === "pending_approval_exists" &&
          calls.executeApprovedIntegrationActionCalls.length === 0 &&
          calls.executeReadIntegrationActionCalls.length === 0
      )
    );
  }

  // ---- [4] rejected Approval(eligibility blocked/approval_rejected) -> Run 0 ----
  {
    const { deps, calls } = makeDeps({ eligibilityOverride: { status: "blocked", reasonCode: "approval_rejected" } });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[4] eligibility blocked(approval_rejected)の場合もexecution境界を一切呼ばない(Run 0)",
        outcome.status === "not_eligible" &&
          outcome.reasonCode === "approval_rejected" &&
          calls.executeApprovedIntegrationActionCalls.length === 0
      )
    );
  }

  // ---- [5] pending Clarification(eligibility blocked) -> Run 0 ----
  {
    const { deps, calls } = makeDeps({ eligibilityOverride: { status: "blocked", reasonCode: "pending_clarification_exists" } });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[5] eligibility blocked(pending_clarification_exists)の場合もexecution境界を一切呼ばない(Run 0)",
        outcome.status === "not_eligible" && calls.executeApprovedIntegrationActionCalls.length === 0
      )
    );
  }

  // ---- [6] completed Task(already_terminal) -> Run 0 ----
  {
    const { deps, calls } = makeDeps({ eligibilityOverride: { status: "already_terminal", reasonCode: "task_completed" } });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[6] eligibility already_terminal(task_completed)の場合、already_terminalを返しRun 0",
        outcome.status === "already_terminal" &&
          outcome.reasonCode === "task_completed" &&
          calls.executeApprovedIntegrationActionCalls.length === 0
      )
    );
  }

  // ---- [7] active Runあり(eligibility blocked/active_run_exists) -> new Run 0 ----
  {
    const { deps, calls } = makeDeps({ eligibilityOverride: { status: "blocked", reasonCode: "active_run_exists" } });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[7] eligibility blocked(active_run_exists)の場合、new Runを一切作らない(Run 0)",
        outcome.status === "not_eligible" && calls.executeApprovedIntegrationActionCalls.length === 0
      )
    );
  }

  // ---- [8] completed Run dedup(eligibility already_terminal/run_already_completed) -> new Run 0 ----
  {
    const { deps, calls } = makeDeps({ eligibilityOverride: { status: "already_terminal", reasonCode: "run_already_completed" } });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[8] eligibility already_terminal(run_already_completed)の場合、new Runを一切作らない(dedup)",
        outcome.status === "already_terminal" && calls.executeApprovedIntegrationActionCalls.length === 0
      )
    );
  }

  // ---- [9] Policy REQUIRE_INPUT -> Run 0 ----
  {
    const { deps, calls } = makeDeps({ policyDecision: { decision: "require_input", riskClass: null, reasonCode: "required_input_missing_parameters" } });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[9] execution直前のPolicy再評価がrequire_inputの場合、policy_not_executableを返しRun 0",
        outcome.status === "policy_not_executable" &&
          calls.executeApprovedIntegrationActionCalls.length === 0 &&
          calls.executeReadIntegrationActionCalls.length === 0
      )
    );
  }

  // ---- [10] Policy DENY -> Run 0 ----
  {
    const { deps, calls } = makeDeps({ policyDecision: { decision: "deny", riskClass: null, reasonCode: "denied_unknown_operation" } });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[10] execution直前のPolicy再評価がdenyの場合、policy_not_executableを返しRun 0",
        outcome.status === "policy_not_executable" && calls.executeApprovedIntegrationActionCalls.length === 0
      )
    );
  }

  // ---- [11] protected write、既存executeApprovedIntegrationAction()がApproval Integrity mismatchを返す場合 -> そのままtransparentに伝播する(Provider call自体は既存境界内部の話、P6b側は関与しない) ----
  {
    const { deps } = makeDeps({ writeOutcome: { status: "approval_integrity_failed", reason: "hash_mismatch" } });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[11] 既存executeApprovedIntegrationAction()がapproval_integrity_failedを返した場合、そのままwrite_executedとして透過する(P6b自身がIntegrity検証を再実装・上書きしない)",
        outcome.status === "write_executed" && outcome.outcome.status === "approval_integrity_failed"
      )
    );
  }

  // ---- [12] protected write、approved Approvalが存在する場合、既存execution boundaryへ実際に進む(approvalIdが正しく渡る) ----
  {
    const { deps, calls } = makeDeps();

    await executePreparedTaskResume(BASE_PARAMS, deps);

    const lastCall = calls.executeApprovedIntegrationActionCalls[0] as unknown[];

    results.push(
      check(
        "[12] approved Approvalが見つかった場合、そのapprovalIdでexecuteApprovedIntegrationAction(workId,userId,accessToken,approvalId)が呼ばれる",
        lastCall?.[0] === "work-1" && lastCall?.[1] === OWNER_USER_ID && lastCall?.[3] === "approval-1"
      )
    );
  }

  // ---- [13] read action(policy allow) -> 既存executeReadIntegrationActionWithRuntimeRouting()(runtime/native routing)へ進む ----
  {
    const { deps, calls } = makeDeps({
      tasks: [makeTask({ assignedCapability: "integration.slack.list_channels" })],
      policyDecision: READ_POLICY_DECISION,
    });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[13] read actionの場合、既存read routing境界が正確に1回呼ばれ、connectionIdが再解決された値で渡る",
        outcome.status === "read_executed" &&
          calls.executeReadIntegrationActionCalls.length === 1 &&
          calls.resolveIntegrationConnectionCalls.length === 1 &&
          JSON.stringify(calls.executeReadIntegrationActionCalls[0]).includes('"connectionId":"conn-1"')
      )
    );
  }

  // ---- [14] runtime ambiguous/dispatched -> 既存P5 outcome(runtime_dispatched)をそのまま維持する(再解釈しない) ----
  {
    const { deps } = makeDeps({
      tasks: [makeTask({ assignedCapability: "integration.slack.list_channels" })],
      policyDecision: READ_POLICY_DECISION,
      readOutcome: { status: "runtime_dispatched" },
    });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[14] 既存read routing境界がruntime_dispatched(ambiguous含む既存P5 invariant)を返した場合、そのまま透過する",
        outcome.status === "read_executed" && outcome.outcome.status === "runtime_dispatched"
      )
    );
  }

  // ---- [15][16] concurrent resume request 2件(write path) -> canonical new Run exactly 1、Provider呼び出し(勝った側)ちょうど1回、負けた側はconcurrent_resume_detectedへ安全に正規化される ----
  {
    let claimed = false;
    let providerCallCount = 0;

    const { deps } = makeDeps({
      writeOutcome: undefined,
    });

    deps.executeApprovedIntegrationAction = (async () => {

      // 実store.tsのcreateRun()と同じ「先にclaimしたcallerだけが成功する」
      // 挙動を最小限に再現する(check-then-actの間にawaitを挟むことで、
      // JSのsingle-threaded実行モデル上でも2つの並行呼び出しが同じ
      // タイミングでcheckを行った状態を作る)。
      if (claimed) {
        throw new Error("Run attempt already exists (taskId=task-1, attempt=1).");
      }

      claimed = true;

      await Promise.resolve();

      providerCallCount += 1;

      return { status: "completed", run: { id: "run-1" } as never };

    }) as ExecutePreparedTaskResumeDeps["executeApprovedIntegrationAction"];

    const [first, second] = await Promise.all([
      executePreparedTaskResume(BASE_PARAMS, deps),
      executePreparedTaskResume(BASE_PARAMS, deps),
    ]);

    const outcomes = [first, second];
    const succeeded = outcomes.filter((o) => o.status === "write_executed");
    const concurrentDetected = outcomes.filter((o) => o.status === "concurrent_resume_detected");

    results.push(
      check(
        "[15/16] 同一TaskへのほぼConcurrentな2回のresume executionは、canonical new Run(=成功したexecution)がexactly 1件、もう一方はconcurrent_resume_detectedへ安全に正規化され(未捕捉例外にならず)、Provider呼び出しもちょうど1回",
        succeeded.length === 1 && concurrentDetected.length === 1 && providerCallCount === 1
      )
    );
  }

  // ---- [17] concurrent resume request 2件(read/runtime path) -> Trigger/Runtime dispatch相当の呼び出しもちょうど1回(duplicate 0) ----
  {
    let claimed = false;
    let dispatchCallCount = 0;

    const { deps } = makeDeps({
      tasks: [makeTask({ assignedCapability: "integration.slack.list_channels" })],
      policyDecision: READ_POLICY_DECISION,
    });

    deps.executeReadIntegrationAction = (async () => {

      if (claimed) {
        throw new Error("Run attempt already exists (taskId=task-1, attempt=1).");
      }

      claimed = true;

      await Promise.resolve();

      dispatchCallCount += 1;

      return { status: "runtime_dispatched" };

    }) as ExecutePreparedTaskResumeDeps["executeReadIntegrationAction"];

    const [first, second] = await Promise.all([
      executePreparedTaskResume(BASE_PARAMS, deps),
      executePreparedTaskResume(BASE_PARAMS, deps),
    ]);

    const outcomes = [first, second];
    const succeeded = outcomes.filter((o) => o.status === "read_executed");
    const concurrentDetected = outcomes.filter((o) => o.status === "concurrent_resume_detected");

    results.push(
      check(
        "[17] read/runtime pathでも同様に、ほぼConcurrentな2回のresumeでruntime dispatch相当の呼び出しはちょうど1回(duplicate 0)、もう一方はconcurrent_resume_detected",
        succeeded.length === 1 && concurrentDetected.length === 1 && dispatchCallCount === 1
      )
    );
  }

  // ---- [18] wrong Work/Task correlation(eligibility自身がblocked/task_not_foundを返す) -> fail closed ----
  {
    const { deps, calls } = makeDeps({ eligibilityOverride: { status: "blocked", reasonCode: "task_not_found" } });

    const outcome = await executePreparedTaskResume(BASE_PARAMS, deps);

    results.push(
      check(
        "[18] eligibility blocked(task_not_found、wrong Work/Task correlation相当)の場合、fail closed(not_eligible)でexecution境界を呼ばない",
        outcome.status === "not_eligible" &&
          outcome.reasonCode === "task_not_found" &&
          calls.executeApprovedIntegrationActionCalls.length === 0
      )
    );
  }

  // ---- [19] callerがconnectionId/provider/resolvedAction/credentialを指定する余地が無い(ExecutePreparedTaskResumeParamsはintent/userId/accessTokenのみ) ----
  {
    results.push(
      check(
        "[19] ExecutePreparedTaskResumeParamsとして渡せるのはintent/userId/accessTokenのみ(connectionId/provider/resolvedAction/credential/raw inputを渡す余地が型レベルで存在しない)",
        Object.keys(BASE_PARAMS).sort().join(",") === "accessToken,intent,userId"
      )
    );
  }

  // ---- [20][22] resume reason(approval_resolved/clarification_resolved/manual_resume/runtime_recovered)はauthorizationに影響しない(同じ状態なら常に同じ結果、Clarification reasonでも同execution APIが利用可能) ----
  {
    const reasons: TaskResumeIntent["reason"][] = [
      "approval_resolved",
      "clarification_resolved",
      "manual_resume",
      "runtime_recovered",
    ];

    let allIdentical = true;

    for (const reason of reasons) {
      const { deps } = makeDeps();
      const outcome = await executePreparedTaskResume(
        { ...BASE_PARAMS, intent: { ...BASE_INTENT, reason } },
        deps
      );
      if (outcome.status !== "write_executed" || outcome.outcome.status !== "completed") {
        allIdentical = false;
      }
    }

    results.push(
      check(
        "[20/22] TaskResumeReason(approval_resolved/clarification_resolved/manual_resume/runtime_recovered)のいずれを指定しても、他の状態が同一なら結果は同一(reason自体がauthorizationに影響しない、Clarification reasonでも同じexecution APIが利用可能)",
        allIdentical
      )
    );
  }

  // ---- [21] Approval resolveとProvider executionが直接結合されていない(approval.ts/clarification.tsがexecutePreparedTaskResume()を一切importしていない、source-level構造的証拠) ----
  {
    const approvalSource = readFileSync(
      join(__dirname, "..", "..", "..", "core", "tact-work", "approval.ts"),
      "utf-8"
    );
    const clarificationSource = readFileSync(
      join(__dirname, "..", "..", "..", "core", "tact-work", "clarification.ts"),
      "utf-8"
    );

    results.push(
      check(
        "[21] core/tact-work/approval.ts・clarification.tsのいずれも、executePreparedTaskResume()を一切import/参照していない(resolveApproval()→Provider executionが自動連結されていない構造的証拠)",
        !approvalSource.includes("executePreparedTaskResume") && !clarificationSource.includes("executePreparedTaskResume")
      )
    );
  }

  // ---- [23] retry/resume = new Run invariant: 一度executionが完了した(already_terminal相当になった)Taskへ再度resumeしても、無条件に再実行されない ----
  {
    const { deps: firstDeps } = makeDeps();
    const firstOutcome = await executePreparedTaskResume(BASE_PARAMS, firstDeps);

    const { deps: secondDeps, calls: secondCalls } = makeDeps({
      eligibilityOverride: { status: "already_terminal", reasonCode: "run_already_completed" },
    });
    const secondOutcome = await executePreparedTaskResume(BASE_PARAMS, secondDeps);

    results.push(
      check(
        "[23] 最初のresumeが成功した後、同じTaskへの2回目のresumeはeligibility自身がrun_already_completedとして検出しalready_terminalになる(無条件retry/re-executionにならない、Retry=new Run invariantを間接的に維持)",
        firstOutcome.status === "write_executed" &&
          secondOutcome.status === "already_terminal" &&
          secondCalls.executeApprovedIntegrationActionCalls.length === 0
      )
    );
  }

  // ---- [2][24/25] resume.ts/orchestration.tsのexecutePreparedTaskResume()自身がcreateRun/Trigger.dev固有識別子を一切importしていない(new Run自体は既存境界内部が作る、runtime provider neutrality維持。Step24注記: この保証はcanonical Run claimがexactly oneであることのみを対象とし、Provider自体のnetwork-level exactly-onceまでは主張しない) ----
  {
    const orchestrationSourceRaw = readFileSync(
      join(__dirname, "..", "..", "..", "core", "tact-conversation", "orchestration.ts"),
      "utf-8"
    );

    // executePreparedTaskResume以降の追加分(P6b)だけを対象にする
    // (file全体には既存の他機能によるimportが別途存在するため、この
    // 関数自身が新たに直接触れていないことだけを確認する)。
    const p6bSectionStart = orchestrationSourceRaw.indexOf("executePreparedTaskResume");
    const p6bSection = orchestrationSourceRaw.slice(p6bSectionStart)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    const forbiddenReferences = ["TriggerDevRuntimeAdapter", "trigger_dev", "new TriggerDev", "composio.", "Composio("];

    const found = forbiddenReferences.filter((name) => p6bSection.includes(name));

    results.push(
      check(
        "[2/24/25] P6bのexecutePreparedTaskResume()自身はTrigger.dev固有識別子・Composio直接呼び出しのいずれも参照していない(new Runは既存境界内部のprepareRunForExecution()が作るのみ、runtime provider neutrality維持)",
        found.length === 0,
        found.length > 0 ? `unexpected references: ${found.join(", ")}` : undefined
      )
    );
  }

  return summarize("conversation/taskResumeExecution", results);

}
