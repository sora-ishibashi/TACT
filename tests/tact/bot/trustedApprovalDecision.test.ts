// =========================
// TACT Bot — Trusted Approval Decision Boundary Regression
// (Architecture Migration Phase C2.1c-b / C2.1c-c)
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
// Category B(Case1〜7、Phase C2.1c-c新規): approveApproval/
// rejectApproval/executeApprovedIntegrationAction/getServiceRoleKeyを
// 全てfake実装へ差し替え、live Supabase/Composio/providerへは一切
// 到達せずにapprove後executionの起動条件・reject時の非到達・
// unexpected exception時の安全なfallbackを検証する。

import "dotenv/config";
import {
  handleApprovalDecisionAsTrustedActor,
  type HandleApprovalDecisionAsTrustedActorDeps,
  type HandleApprovalDecisionAsTrustedActorParams,
} from "../../../core/tact-bot/execution/trustedApprovalDecision";
import { isServiceRoleConfigured } from "../../../core/database/supabaseServiceRole";
import type { ApprovalResolutionOutcome } from "../../../core/tact-work/approval";
import type { Approval } from "../../../core/tact-work/types";
import type { IntegrationActionExecutionOutcome } from "../../../core/tact-integration/execution";
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

// 絶対条件: このfakeなgetServiceRoleKeyがcallされても、実際のcredential
// 文字列(process.env.SUPABASE_SERVICE_ROLE_KEY)は一切使わない
// (live Supabaseへは到達しない——approveApproval/rejectApproval/
// executeApprovedIntegrationAction自体を全てfakeへ差し替えるため)。
function makeFakeDeps(options: {
  approveResult?: ApprovalResolutionOutcome;
  rejectResult?: ApprovalResolutionOutcome;
  executeResult?: IntegrationActionExecutionOutcome;
  executeThrows?: unknown;
} = {}): {
  deps: HandleApprovalDecisionAsTrustedActorDeps;
  approveCalls: unknown[][];
  rejectCalls: unknown[][];
  executeCalls: unknown[][];
} {

  const approveCalls: unknown[][] = [];
  const rejectCalls: unknown[][] = [];
  const executeCalls: unknown[][] = [];

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

    executeApprovedIntegrationAction: async (...args: unknown[]) => {
      executeCalls.push(args);
      if (options.executeThrows !== undefined) {
        throw options.executeThrows;
      }
      return (options.executeResult ?? { status: "completed", run: {} as never }) as IntegrationActionExecutionOutcome;
    },
  };

  return { deps, approveCalls, rejectCalls, executeCalls };

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
  // Category B(Phase C2.1c-c): approve/reject/execution起動条件
  // =========================

  // ---- Case1: 新規approve成功 -> executeApprovedIntegrationAction exactly 1 -> completed ----
  {
    const { deps, approveCalls, executeCalls } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
      executeResult: { status: "completed", run: {} as never },
    });

    const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);

    results.push(
      check(
        "[Case1] 新規approve成功: approveApprovalが1回、executeApprovedIntegrationActionが正確に1回呼ばれ、completed outcomeが返る",
        approveCalls.length === 1 &&
          executeCalls.length === 1 &&
          result.ok === true &&
          result.approvalOutcome.status === "approved" &&
          result.executionOutcome?.status === "completed"
      )
    );

    results.push(
      check(
        "[Case1] executeApprovedIntegrationActionへ渡る引数はtrusted tactUserId(=identity解決済みの値)であり、workId/approvalIdもparamsのまま転記される(providerConnectionRef等の第五引数は無い)",
        executeCalls[0]?.[0] === "work-1" &&
          executeCalls[0]?.[1] === "tact-user-1" &&
          executeCalls[0]?.[3] === "approval-1"
      )
    );
  }

  // ---- Case2: provider/execution canonical failed outcome -> そのまま返す、retry 0 ----
  {
    const { executeCalls, deps } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
      executeResult: { status: "failed", run: {} as never },
    });

    const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);

    results.push(
      check(
        "[Case2] executeApprovedIntegrationActionがcanonical failedを返した場合、そのままfailedとして返し、execution呼び出しは1回のまま(自動retryしない)",
        result.ok === true && result.executionOutcome?.status === "failed" && executeCalls.length === 1
      )
    );
  }

  // ---- Case3: 既にapproved(repeated decision) + already_executed execution outcome ----
  {
    const { deps, approveCalls, executeCalls } = makeFakeDeps({
      approveResult: { status: "already_resolved", approval: makeApproval({ status: "approved" }) },
      executeResult: { status: "already_executed", run: {} as never },
    });

    const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);

    results.push(
      check(
        "[Case3] 既にapproved状態のApprovalへの再approve callbackは、execution boundaryへは到達するが(already_resolved+approval.status===approved)、canonical dedupによりalready_executedがそのまま維持される",
        approveCalls.length === 1 &&
          executeCalls.length === 1 &&
          result.ok === true &&
          result.approvalOutcome.status === "already_resolved" &&
          result.executionOutcome?.status === "already_executed"
      )
    );
  }

  // ---- Case4: reject -> executeApprovedIntegrationAction 0 calls ----
  {
    const { deps, rejectCalls, executeCalls } = makeFakeDeps({
      rejectResult: { status: "rejected", approval: makeApproval({ status: "rejected" }) },
    });

    const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "reject", reason: "却下します" }), deps);

    results.push(
      check(
        "[Case4] reject decisionではrejectApprovalのみが呼ばれ、executeApprovedIntegrationActionは0回のまま(絶対条件)",
        rejectCalls.length === 1 &&
          executeCalls.length === 0 &&
          result.ok === true &&
          result.approvalOutcome.status === "rejected" &&
          result.executionOutcome === undefined
      )
    );
  }

  // ---- Case5: approve invalid_transition / not_found / rejected済みapproval -> execution 0 calls ----
  {
    const cases: { name: string; approveResult: ApprovalResolutionOutcome }[] = [
      { name: "invalid_transition", approveResult: { status: "invalid_transition", approval: makeApproval({ status: "rejected" }) } },
      { name: "not_found", approveResult: { status: "not_found" } },
      { name: "work_not_resumable", approveResult: { status: "work_not_resumable", approval: makeApproval({ status: "pending" }), workStatus: "completed" } },
      { name: "already_resolvedだがrejected側", approveResult: { status: "already_resolved", approval: makeApproval({ status: "rejected" }) } },
    ];

    for (const c of cases) {

      const { deps, executeCalls } = makeFakeDeps({ approveResult: c.approveResult });

      const result = await handleApprovalDecisionAsTrustedActor(makeParams({ decision: "approve" }), deps);

      results.push(
        check(
          `[Case5:${c.name}] approveApprovalがexecutionへ進んでよい状態(approved)を返さない場合、executeApprovedIntegrationActionは0回のまま`,
          executeCalls.length === 0 && result.ok === true && result.executionOutcome === undefined
        )
      );

    }
  }

  // ---- Case6: executeApprovedIntegrationActionがthrow -> handler自体はthrowしない、execution_error、second call 0 ----
  {
    const { deps, executeCalls } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
      executeThrows: new Error("simulated internal exception (e.g. unexpected DB error mid-execution)"),
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
        "[Case6] executeApprovedIntegrationActionがunexpected exceptionを投げても、handler自体はthrowせず安全にexecution_errorへ倒す",
        threw === false && result?.ok === true && result.executionOutcome?.status === "execution_error"
      )
    );

    results.push(
      check(
        "[Case6] 同一request内でexecuteApprovedIntegrationActionが2回目呼ばれることはない(自動retry禁止、1回のみ)",
        executeCalls.length === 1
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

  // ---- Case7: trusted identity boundary(外部actor idをexecutionへ渡さない) ----
  {
    const { deps, approveCalls, executeCalls } = makeFakeDeps({
      approveResult: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
      executeResult: { status: "completed", run: {} as never },
    });

    // handleApprovalDecisionAsTrustedActor()の引数にtactUserIdしか
    // 存在しないこと自体が構造的な保証(BOT-P2.5と同じ既存境界)。
    // ここではその値がapproveApproval/executeApprovedIntegrationAction
    // の両方へ一貫してtactUserId(resolved値)としてのみ渡ることを
    // 直接確認する(生のexternal actor idという概念自体がこの
    // handlerの引数に存在しない)。
    await handleApprovalDecisionAsTrustedActor(makeParams({ tactUserId: "tact-user-resolved-42", decision: "approve" }), deps);

    results.push(
      check(
        "[Case7] trusted tactUserIdがapproveApproval/executeApprovedIntegrationActionの両方へ一貫してuserId引数として渡る(externalUserId相当の値はこのhandlerの引数自体に存在しない)",
          approveCalls[0]?.[1] === "tact-user-resolved-42" &&
          executeCalls[0]?.[1] === "tact-user-resolved-42"
      )
    );
  }

  return summarize("bot/trustedApprovalDecision", results);

}
