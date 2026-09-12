// =========================
// TACT Bot — Trusted Approval Decision Boundary Regression
// (Architecture Migration Phase C2.1c-b / C2.1c-c, Fast Port P6b更新)
// =========================
//
// 対象: core/tact-bot/execution/trustedApprovalDecision.tsの
// handleApprovalDecisionAsTrustedActor()。
//
// 環境制約(core/tact-bot/execution/trustedConversationTurn.test.ts
// と同じ既存方針): このtest実行環境にはSUPABASE_SERVICE_ROLE_KEYが
// 設定されていない。
//
// Category A(Precondition/Test1-1〜1-3): mockを使わず実関数をそのまま
// 呼び出し、「未設定時は一切DBへアクセスせず安全にfallbackする」と
// いう分岐だけを確認する(pure/deterministic)。
//
// Category B(Case1〜7、Phase C2.1c-c新規、Fast Port P6bでrequestTaskResume/
// executePreparedTaskResume経由へ更新): approveApproval/rejectApproval/
// requestTaskResume/executePreparedTaskResume/getServiceRoleKeyを全て
// fake実装へ差し替え、live Supabase/Composio/providerへは一切到達
// せずにapprove後resumeの起動条件・reject時の非到達・unexpected
// exception時の安全なfallbackを検証する。
//
// Fast Port P6b: 以前このsuiteはexecuteApprovedIntegrationAction()を
// 直接fakeしていたが、trustedApprovalDecision.ts自身がP6bで
// requestTaskResume()→executePreparedTaskResume()という明示的な2段階
// (Step12: resolveApproval() ≠ executeProvider())へ変更されたため、
// このsuiteもそれに合わせて更新する(挙動として確認したい不変条件
// ——approve成功後にexactly 1回だけresumeへ進む、reject/非approved
// では0回、unexpected exceptionはexecution_errorへ安全に倒す——は
// P6b前後で変わらない)。

import "dotenv/config";
import {
  handleApprovalDecisionAsTrustedActor,
  type HandleApprovalDecisionAsTrustedActorDeps,
  type HandleApprovalDecisionAsTrustedActorParams,
} from "../../../core/tact-bot/execution/trustedApprovalDecision";
import { isServiceRoleConfigured } from "../../../core/database/supabaseServiceRole";
import type { ApprovalResolutionOutcome } from "../../../core/tact-work/approval";
import type { TaskResumeRequestOutcome } from "../../../core/tact-work/resume";
import type { Approval } from "../../../core/tact-work/types";
import type { IntegrationActionExecutionOutcome } from "../../../core/tact-integration/execution";
import type { TaskResumeExecutionOutcome } from "../../../core/tact-conversation/orchestration";
import { check, summarize, type CheckResult } from "../lib/check";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "integration.slack.send_message",
    requestedFromActorKind: "user",
    requestedFromActorId: "tact-user-1",
    status: "pending",
    reason: "test",
    payload: {},
    requestedAt: "2026-09-06T00:00:00.000Z",
    createdAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

function makeParams(overrides: Partial<HandleApprovalDecisionAsTrustedActorParams> = {}): HandleApprovalDecisionAsTrustedActorParams {
  return {
    tactUserId: "tact-user-1",
    workId: "work-1",
    approvalId: "approval-1",
    decision: "approve",
    ...overrides,
  };
}

const DEFAULT_PREPARED_RESUME: TaskResumeRequestOutcome = {
  status: "prepared",
  intent: { workId: "work-1", taskId: "task-1", reason: "approval_resolved", eligibleAt: "2026-09-06T00:00:00.000Z" },
};

// 絶対条件: このfakeなgetServiceRoleKeyがcallされても、実際のcredential
// 文字列(process.env.SUPABASE_SERVICE_ROLE_KEY)は一切使わない
// (live Supabaseへは到達しない——approveApproval/rejectApproval/
// requestTaskResume/executePreparedTaskResume自体を全てfakeへ
// 差し替えるため)。
function makeFakeDeps(options: {
  approveResult?: ApprovalResolutionOutcome;
  rejectResult?: ApprovalResolutionOutcome;
  resumeRequestResult?: TaskResumeRequestOutcome;
  resumeExecutionResult?: TaskResumeExecutionOutcome;
  resumeExecutionThrows?: unknown;
  finalizeSemanticWorkThrows?: unknown;
} = {}): {
  deps: HandleApprovalDecisionAsTrustedActorDeps;
  approveCalls: unknown[][];
  rejectCalls: unknown[][];
  resumeRequestCalls: unknown[][];
  resumeExecutionCalls: unknown[][];
  finalizeSemanticWorkCalls: unknown[][];
} {

  const approveCalls: unknown[][] = [];
  const rejectCalls: unknown[][] = [];
  const resumeRequestCalls: unknown[][] = [];
  const resumeExecutionCalls: unknown[][] = [];
  const finalizeSemanticWorkCalls: unknown[][] = [];

  const defaultWriteExecuted: TaskResumeExecutionOutcome = {
    status: "write_executed",
    outcome: { status: "completed", run: {} as never } as IntegrationActionExecutionOutcome,
  };

  const deps: HandleApprovalDecisionAsTrustedActorDeps = {
    getServiceRoleKey: () => "fake-service-role-key-for-test-only",

    approveApproval: async (...args: unknown[]) => {
      approveCalls.push(args);
      return (options.approveResult ??
        { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true }) as ApprovalResolutionOutcome;
    },

    rejectApproval: async (...args: unknown[]) => {
      rejectCalls.push(args);
      return (options.rejectResult ??
        { status: "rejected", approval: makeApproval({ status: "rejected" }) }) as ApprovalResolutionOutcome;
    },

    requestTaskResume: (async (...args: unknown[]) => {
      resumeRequestCalls.push(args);
      return options.resumeRequestResult ?? DEFAULT_PREPARED_RESUME;
    }) as HandleApprovalDecisionAsTrustedActorDeps["requestTaskResume"],

    executePreparedTaskResume: (async (...args: unknown[]) => {
      resumeExecutionCalls.push(args);
      if (options.resumeExecutionThrows !== undefined) {
        throw options.resumeExecutionThrows;
      }
      return options.resumeExecutionResult ?? defaultWriteExecuted;
    }) as HandleApprovalDecisionAsTrustedActorDeps["executePreparedTaskResume"],

    // Architecture audit finding F-02 fix regression coverage.
    finalizeSemanticWorkAfterProtectedWrite: async (...args: unknown[]) => {
      finalizeSemanticWorkCalls.push(args);
      if (options.finalizeSemanticWorkThrows !== undefined) {
        throw options.finalizeSemanticWorkThrows;
      }
    },
  };

  return { deps, approveCalls, rejectCalls, resumeRequestCalls, resumeExecutionCalls, finalizeSemanticWorkCalls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // Category A: service role未設定時の既存fallback(実関数、DI無し)
  // =========================

  results.push(
    check(
      "[Precondition] このtest環境ではSUPABASE_SERVICE_ROLE_KEYが未設定である(設定済みの場合、以下のtestは実Supabase書き込みを試みてしまうため、前提条件として確認する)",
      isServiceRoleConfigured() === false
    )
  );

  const approveResult = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }));

  results.push(
    check(
      "[Test1-1] service role未設定時、approve decisionはok:false・error:trusted_execution_not_configuredを返す(DBへ一切アクセスしない)",
      approveResult.ok === false && approveResult.error === "trusted_execution_not_configured"
    )
  );

  const rejectResult = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "reject", reason: "テスト" }));

  results.push(
    check(
      "[Test1-2] service role未設定時、reject decisionも同じく安全にfallbackする(引数に関わらず未設定なら常にDBへアクセスしない)",
      rejectResult.ok === false && rejectResult.error === "trusted_execution_not_configured"
    )
  );

  results.push(
    check(
      "[Test1-3] エラー結果にservice role key等の生Credentialが含まれない",
      !JSON.stringify(approveResult).toLowerCase().includes("bearer") &&
        !JSON.stringify(approveResult).includes(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "__unset__")
    )
  );

  // =========================
  // Category B(Phase C2.1c-c、Fast Port P6b更新): approve/reject/resume起動条件
  // =========================

  // ---- Case1: 新規approve成功 -> requestTaskResume→executePreparedTaskResumeが各exactly 1 -> completed ----
  {
    const { deps, approveCalls, resumeRequestCalls, resumeExecutionCalls, finalizeSemanticWorkCalls } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
    });

    const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);

    results.push(
      check(
        "[Case1] 新規approve成功: approveApprovalが1回、requestTaskResume→executePreparedTaskResumeが各正確に1回呼ばれ、completed outcomeが返る",
        approveCalls.length === 1 &&
          resumeRequestCalls.length === 1 &&
          resumeExecutionCalls.length === 1 &&
          result.ok === true &&
          result.approvalOutcome.status === "approved" &&
          result.executionOutcome?.status === "completed"
      )
    );

    results.push(
      check(
        "[Case1] requestTaskResume()へ渡る引数はtrusted tactUserId(=identity解決済みの値)・approveApproval結果由来のtaskId(reason:approval_resolved)であり、userIdの詐称余地が無い",
        (resumeRequestCalls[0]?.[0] as { workId?: string; userId?: string; taskId?: string; reason?: string })?.workId === "work-1" &&
          (resumeRequestCalls[0]?.[0] as { userId?: string })?.userId === "tact-user-1" &&
          (resumeRequestCalls[0]?.[0] as { taskId?: string })?.taskId === "task-1" &&
          (resumeRequestCalls[0]?.[0] as { reason?: string })?.reason === "approval_resolved"
      )
    );

    results.push(
      check(
        "[F-02] write_executed+completedの直後、finalizeSemanticWorkAfterProtectedWrite()がworkId/trusted tactUserIdで正確に1回呼ばれる(durable semantic delivery boundaryを進める起点)",
        finalizeSemanticWorkCalls.length === 1 &&
          finalizeSemanticWorkCalls[0]?.[0] === "work-1" &&
          finalizeSemanticWorkCalls[0]?.[1] === "tact-user-1"
      )
    );
  }

  // ---- Case2: canonical failed outcome -> そのまま返す、retry 0 ----
  {
    const { resumeExecutionCalls, finalizeSemanticWorkCalls, deps } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
      resumeExecutionResult: { status: "write_executed", outcome: { status: "failed", run: {} as never } },
    });

    const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);

    results.push(
      check(
        "[Case2] executePreparedTaskResume()がcanonical failed outcomeを返した場合、そのままfailedとして透過し、execution呼び出しは1回のまま(自動retryしない)",
        result.ok === true && result.executionOutcome?.status === "failed" && resumeExecutionCalls.length === 1
      )
    );

    results.push(
      check(
        "[F-02] definite failureでもfinalizeSemanticWorkAfterProtectedWrite()は1回呼ばれる(delivery markingは成功/失敗どちらの確定結果でも行う——false successを主張するものではなく、単に定義済みの結果を記録するだけ)",
        finalizeSemanticWorkCalls.length === 1
      )
    );
  }

  // ---- Case3: 既にapproved(repeated decision) + already_executed execution outcome ----
  {
    const { deps, approveCalls, resumeExecutionCalls, finalizeSemanticWorkCalls } = makeFakeDeps({
      approveResult: { status: "already_resolved", approval: makeApproval({ status: "approved" }) },
      resumeExecutionResult: { status: "write_executed", outcome: { status: "already_executed", run: {} as never } },
    });

    const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);

    results.push(
      check(
        "[Case3] 既にapproved状態のApprovalへの再approve callbackは、resume boundaryへは到達するが(already_resolved+approval.status===approved)、canonical dedupによりalready_executedがそのまま維持される",
        approveCalls.length === 1 &&
          resumeExecutionCalls.length === 1 &&
          result.ok === true &&
          result.approvalOutcome.status === "already_resolved" &&
          result.executionOutcome?.status === "already_executed"
      )
    );

    results.push(
      check(
        "[F-02] already_executed(duplicate approval replay)でもfinalizeSemanticWorkAfterProtectedWrite()は1回呼ばれる(冪等——Workは既にterminalのはずで、これ自体は安全なno-opになる)",
        finalizeSemanticWorkCalls.length === 1
      )
    );
  }

  // ---- Case3b(Fast Port P6b新規): requestTaskResume()自身がeligibility再確認でblocked/already_terminalを返した場合 -> Providerへ到達せず、既存invalid_actionへ安全に折り畳む ----
  {
    const { deps, resumeExecutionCalls, finalizeSemanticWorkCalls } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
      resumeRequestResult: { status: "blocked", reasonCode: "active_run_exists" },
    });

    const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);

    results.push(
      check(
        "[Case3b] requestTaskResume()がblocked(例: active_run_exists)を返した場合、executePreparedTaskResumeへは進まず(Provider到達0)、既存invalid_actionへ安全に折り畳む(resolved≠resumedの構造的保証)",
        resumeExecutionCalls.length === 0 &&
          result.ok === true &&
          result.executionOutcome?.status === "invalid_action"
      )
    );

    results.push(
      check(
        "[F-02] resume自体に到達しなかった場合、finalizeSemanticWorkAfterProtectedWrite()は一切呼ばれない(definitiveな結果が無いため、delivery markingしない)",
        finalizeSemanticWorkCalls.length === 0
      )
    );
  }

  // ---- Case3c(F-02新規): executePreparedTaskResume()がwrite_executedを
  // 返しても、outcome自体がinvalid_action/connection_unavailable等
  // (definitiveな実行結果ではない)の場合はfinalizeSemanticWorkAfter
  // ProtectedWrite()を呼ばない ----
  {
    const { deps, finalizeSemanticWorkCalls } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
      resumeExecutionResult: { status: "write_executed", outcome: { status: "connection_unavailable" } },
    });

    const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);

    results.push(
      check(
        "[F-02] write_executedだがoutcome.statusがconnection_unavailable(definitiveな実行結果ではない)の場合、finalizeSemanticWorkAfterProtectedWrite()は呼ばれない",
        result.ok === true &&
          result.executionOutcome?.status === "connection_unavailable" &&
          finalizeSemanticWorkCalls.length === 0
      )
    );
  }

  // ---- Case4: reject -> requestTaskResume/executePreparedTaskResume 0 calls ----
  {
    const { deps, rejectCalls, resumeRequestCalls, resumeExecutionCalls, finalizeSemanticWorkCalls } = makeFakeDeps({
      rejectResult: { status: "rejected", approval: makeApproval({ status: "rejected" }) },
    });

    const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "reject", reason: "却下します" }), deps);

    results.push(
      check(
        "[Case4] reject decisionではrejectApprovalのみが呼ばれ、requestTaskResume/executePreparedTaskResumeは0回のまま(絶対条件)",
        rejectCalls.length === 1 &&
          resumeRequestCalls.length === 0 &&
          resumeExecutionCalls.length === 0 &&
          result.ok === true &&
          result.approvalOutcome.status === "rejected" &&
          result.executionOutcome === undefined
      )
    );

    results.push(
      check(
        "[F-02] reject decisionではfinalizeSemanticWorkAfterProtectedWrite()も0回のまま(rejectはRun/Task/Workをrejectapproval()自身が直接failedへ確定させる既存経路であり、write resumeへは一切進まない)",
        finalizeSemanticWorkCalls.length === 0
      )
    );
  }

  // ---- Case5: approve invalid_transition / not_found / rejected済みapproval -> resume 0 calls ----
  {
    const cases: { name: string; approveResult: ApprovalResolutionOutcome }[] = [
      { name: "invalid_transition", approveResult: { status: "invalid_transition", approval: makeApproval({ status: "rejected" }) } },
      { name: "not_found", approveResult: { status: "not_found" } },
      { name: "work_not_resumable", approveResult: { status: "work_not_resumable", approval: makeApproval({ status: "pending" }), workStatus: "completed" } },
      { name: "already_resolvedだがrejected側", approveResult: { status: "already_resolved", approval: makeApproval({ status: "rejected" }) } },
    ];

    for (const c of cases) {

      const { deps, resumeRequestCalls, resumeExecutionCalls } = makeFakeDeps({ approveResult: c.approveResult });

      const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);

      results.push(
        check(
          `[Case5:${c.name}] approveApprovalがexecutionへ進んでよい状態(approved)を返さない場合、requestTaskResume/executePreparedTaskResumeは0回のまま`,
          resumeRequestCalls.length === 0 &&
            resumeExecutionCalls.length === 0 &&
            result.ok === true &&
            result.executionOutcome === undefined
        )
      );

    }
  }

  // ---- Case6: executePreparedTaskResumeがthrow -> handler自体はthrowしない、execution_error、second call 0 ----
  {
    const { deps, resumeExecutionCalls } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
      resumeExecutionThrows: new Error("simulated internal exception (e.g. unexpected DB error mid-execution)"),
    });

    let threw = false;
    let result;

    try {
      result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);
    } catch {
      threw = true;
    }

    results.push(
      check(
        "[Case6] executePreparedTaskResumeがunexpected exceptionを投げても、handler自体はthrowせず安全にexecution_errorへ倒す",
        threw === false && result?.ok === true && result.executionOutcome?.status === "execution_error"
      )
    );

    results.push(
      check(
        "[Case6] 同一request内でexecutePreparedTaskResumeが2回目呼ばれることはない(自動retry禁止、1回のみ)",
        resumeExecutionCalls.length === 1
      )
    );

    results.push(
      check(
        "[Case6] execution_error結果にraw Error object/message/stackが含まれない(戻り値へは一切含めない)",
        !JSON.stringify(result).includes("simulated internal exception") &&
          !JSON.stringify(result).toLowerCase().includes("stack")
      )
    );
  }

  // ---- Case6b(F-02新規): finalizeSemanticWorkAfterProtectedWrite()自身が
  // throwしても、handler自体はthrowせず、既に確定済みのexecutionOutcome
  // (completed)をそのまま返す(best-effort、既存reconcileAfterTaskUpdate()
  // と同じ「非致命的な副次処理の失敗でexternal side effectの成否判定を
  // 変更しない」既存パターンをこのfileにも適用する) ----
  {
    const { deps, finalizeSemanticWorkCalls } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
      finalizeSemanticWorkThrows: new Error("simulated DB error during semantic delivery marking"),
    });

    let threw = false;
    let result;

    try {
      result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);
    } catch {
      threw = true;
    }

    results.push(
      check(
        "[Case6b][F-02] finalizeSemanticWorkAfterProtectedWrite()がunexpected exceptionを投げても、handler自体はthrowせず、既に確定済みのcompleted outcomeをそのまま返す",
        threw === false &&
          result?.ok === true &&
          result.executionOutcome?.status === "completed" &&
          finalizeSemanticWorkCalls.length === 1
      )
    );
  }

  // ---- Case7: trusted identity boundary(外部actor idをresumeへ渡さない) ----
  {
    const { deps, approveCalls, resumeRequestCalls, resumeExecutionCalls } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
    });

    // handleApprovalDecisionAsTrustedActor()の引数にtactUserIdしか
    // 存在しないこと自体が構造的な保証(BOT-P2.5と同じ既存境界)。
    // ここではその値がapproveApproval/requestTaskResume/
    // executePreparedTaskResumeの全てへ一貫してtactUserId(resolved値)
    // としてのみ渡ることを直接確認する(生のexternal actor idという
    // 概念自体がこのhandlerの引数に存在しない)。
    await handleApprovalDecisionAsTrustedActor(makeParams({ tactUserId: "tact-user-resolved-42", decision: "approve" }), deps);

    results.push(
      check(
        "[Case7] trusted tactUserIdがapproveApproval/requestTaskResume/executePreparedTaskResumeの全てへ一貫してuserId引数として渡る(externalUserId相当の値はこのhandlerの引数自体に存在しない)",
        approveCalls[0]?.[1] === "tact-user-resolved-42" &&
          (resumeRequestCalls[0]?.[0] as { userId?: string })?.userId === "tact-user-resolved-42" &&
          (resumeExecutionCalls[0]?.[0] as { userId?: string })?.userId === "tact-user-resolved-42"
      )
    );
  }

  return summarize("bot/trustedApprovalDecision", results);

}
