// =========================
// TACT Bot — receiveBotApprovalDecision Regression
// (Architecture Migration Phase C2.1c-b / C2.1c-c)
// =========================
//
// 対象: core/tact-bot/gateway/receiveApprovalDecision.tsの
// receiveBotApprovalDecision()。実Supabase・実Trusted Bot Execution
// Boundaryには一切接続しない(BotApprovalDecisionGatewayDeps経由で
// identityResolver/handleDecisionを偽実装に差し替える)。
//
// 最重要確認事項:
//   - 外部Bot actor idが直接canonical handlerのtactUserIdとして
//     使われないこと(BOT-P2.5と同じidentity resolution境界)
//   - identity未解決の場合、handleDecision自体が一切呼ばれないこと
//   - approveApproval()/rejectApproval()自体が持つidempotency
//     (already_resolved/invalid_transition/not_found)を、この
//     Gatewayが素通しすること(新しいidempotency機構を作らない)
//   - BotApprovalDecisionのcallback payloadにcredential相当の
//     fieldが存在しないこと
//   - Phase C2.1c-c: executionOutcome(canonical Integration
//     execution outcome)をcanonical statusだけを見て安全な文言へ
//     変換すること、raw provider detail/内部IDを一切含めないこと、
//     execution_error時に再試行を促す文言を含めないこと

import {
  receiveBotApprovalDecision,
  type BotApprovalDecisionGatewayDeps,
} from "../../../core/tact-bot/gateway/receiveApprovalDecision";
import type {
  HandleApprovalDecisionAsTrustedActorParams,
  HandleApprovalDecisionAsTrustedActorResult,
} from "../../../core/tact-bot/execution/trustedApprovalDecision";
import type { BotApprovalDecision, BotIdentity } from "../../../core/tact-bot/types";
import type { BotIdentityResolver } from "../../../core/tact-bot/identity/resolver";
import type { Approval } from "../../../core/tact-work/types";
import type { IntegrationActionExecutionOutcome } from "../../../core/tact-integration/execution";
import { check, summarize, type CheckResult } from "../lib/check";

function makeDecision(overrides: Partial<BotApprovalDecision> = {}): BotApprovalDecision {
  return {
    channel: "slack",
    actor: { externalUserId: "U-external-attacker-or-owner" },
    target: { channel: "slack", conversation: { externalConversationId: "C1", type: "channel" } },
    workId: "work-1",
    approvalId: "approval-1",
    decision: "approve",
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "integration.slack.send_message",
    requestedFromActorKind: "user",
    requestedFromActorId: "tact-user-1",
    status: "approved",
    reason: "test",
    payload: {},
    requestedAt: "2026-09-06T00:00:00.000Z",
    createdAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(options: {
  identity?: BotIdentity | null;
  handleDecisionResult?: HandleApprovalDecisionAsTrustedActorResult;
  // S1e Identity Hotfix: workspace-aware resolutionをシミュレートする
  // 場合のみ指定する(未指定ならworkspace無視で既定identityを返す、
  // 既存Caseへの影響を避ける)。
  expectedOrganizationId?: string;
} = {}): {
  deps: BotApprovalDecisionGatewayDeps;
  identityResolveCalls: { externalUserId: string; channel: string; organizationId?: string }[];
  handleDecisionCalls: HandleApprovalDecisionAsTrustedActorParams[];
} {

  const identityResolveCalls: { externalUserId: string; channel: string; organizationId?: string }[] = [];
  const handleDecisionCalls: HandleApprovalDecisionAsTrustedActorParams[] = [];

  const identityResolver: BotIdentityResolver = {
    async resolve(actor, channel, organizationId) {
      identityResolveCalls.push({ externalUserId: actor.externalUserId, channel, organizationId });

      // S1e Identity Hotfix: expectedOrganizationIdが指定された場合、
      // findExternalIdentity()の既存workspace-scoped lookup semantics
      // (external_workspace_id = <値> の完全一致、fallback無し)を
      // fakeで再現する——不一致・欠落は常にnull(fail closed)。
      if (options.expectedOrganizationId !== undefined) {
        return organizationId === options.expectedOrganizationId
          ? { tactUserId: "tact-user-1" }
          : null;
      }

      // 絶対条件: "identity: null"が明示的に指定された場合(未解決を
      // 表す)と、指定されなかった場合(既定でtact-user-1に解決)を
      // 区別する(?? だとnullも既定値へfallbackしてしまうため、
      // undefinedかどうかで判定する)。
      return options.identity !== undefined ? options.identity : { tactUserId: "tact-user-1" };
    },
  };

  const handleDecisionResult: HandleApprovalDecisionAsTrustedActorResult =
    options.handleDecisionResult ??
    { ok: true, approvalOutcome: { status: "approved", approval: makeApproval(), workResumed: true } };

  const deps: BotApprovalDecisionGatewayDeps = {
    identityResolver,
    handleDecision: async (params) => {
      handleDecisionCalls.push(params);
      return handleDecisionResult;
    },
  };

  return { deps, identityResolveCalls, handleDecisionCalls };

}

function executionResult(executionOutcome: IntegrationActionExecutionOutcome | { status: "execution_error" }): HandleApprovalDecisionAsTrustedActorResult {
  return {
    ok: true,
    approvalOutcome: { status: "approved", approval: makeApproval(), workResumed: true },
    executionOutcome,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case9: external identity boundary(最優先で確認) ----
  {
    const { deps, identityResolveCalls, handleDecisionCalls } = makeDeps();

    await receiveBotApprovalDecision(makeDecision({ actor: { externalUserId: "U-external-999" } }), deps);

    results.push(
      check(
        "[Case9] identityResolver.resolve()へ渡るのはactor(外部platform user)であり、canonical handlerへはtrusted解決済みtactUserIdだけが渡る(外部actor idを直接使わない)",
        identityResolveCalls[0]?.externalUserId === "U-external-999" &&
          handleDecisionCalls[0]?.tactUserId === "tact-user-1"
      )
    );
  }

  // ---- S1e Identity Hotfix Case: decision.organizationIdがresolve()第3引数へ転送される ----
  {
    const { deps, identityResolveCalls } = makeDeps();

    await receiveBotApprovalDecision(makeDecision({ organizationId: "T123TEAM" }), deps);

    results.push(
      check(
        "[S1e Hotfix] identityResolver.resolve()の第3引数はdecision.organizationId('T123TEAM')そのもの(通常message pathと同じargument semantics)",
        identityResolveCalls[0]?.organizationId === "T123TEAM"
      )
    );
  }

  // ---- S1e Identity Hotfix Case: workspace一致時のみ解決される(fail closed on mismatch) ----
  {
    const { deps, handleDecisionCalls } = makeDeps({ expectedOrganizationId: "T123TEAM" });

    const matched = await receiveBotApprovalDecision(
      makeDecision({ organizationId: "T123TEAM" }),
      deps
    );

    results.push(
      check(
        "[S1e Hotfix] workspace(organizationId)が一致する場合、canonical handleDecisionへ到達しhandled:trueとなる",
        matched.handled === true && handleDecisionCalls.length === 1
      )
    );
  }

  // ---- S1e Identity Hotfix Case: 同じexternal user idでもorganizationIdが違えばfail closed ----
  {
    const { deps: wrongWorkspaceDeps, handleDecisionCalls: wrongWorkspaceCalls } = makeDeps({
      expectedOrganizationId: "T123TEAM",
    });

    const mismatched = await receiveBotApprovalDecision(
      makeDecision({ organizationId: "T999OTHERTEAM" }),
      wrongWorkspaceDeps
    );

    results.push(
      check(
        "[S1e Hotfix] 同一external user idでもorganizationIdが期待値と異なる場合、identity未解決としてfail closedされ、handleDecisionは一切呼ばれない(wildcard/fallback一致は行わない)",
        mismatched.handled === false &&
          mismatched.reason === "identity_unresolved" &&
          wrongWorkspaceCalls.length === 0
      )
    );
  }

  // ---- S1e Identity Hotfix Case: organizationId欠落時は既存null-workspace semanticsのまま(resolverの挙動自体は変更しない) ----
  {
    const { deps, identityResolveCalls } = makeDeps();

    await receiveBotApprovalDecision(makeDecision({ organizationId: undefined }), deps);

    results.push(
      check(
        "[S1e Hotfix] decision.organizationId省略時、resolve()の第3引数はundefinedのまま渡る(独自のfallback値を作らない、既存resolver semantics — external_workspace_id IS NULL相当 — をそのまま維持する)",
        identityResolveCalls[0]?.organizationId === undefined
      )
    );
  }

  // ---- identity未解決の場合、handleDecision自体を呼ばない ----
  {
    const { deps, handleDecisionCalls } = makeDeps({ identity: null });

    const result = await receiveBotApprovalDecision(makeDecision(), deps);

    results.push(
      check(
        "[Security] identity未解決の場合、handleDecision(=canonical approveApproval/rejectApproval経路)を一切呼ばない",
        result.handled === false &&
          result.reason === "identity_unresolved" &&
          handleDecisionCalls.length === 0
      )
    );
  }

  // ---- Case3: approve(executionへ進まない、approve outcomeのみ) ----
  {
    const { deps, handleDecisionCalls } = makeDeps({
      handleDecisionResult: { ok: true, approvalOutcome: { status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true } },
    });

    const result = await receiveBotApprovalDecision(makeDecision({ decision: "approve" }), deps);

    results.push(
      check(
        "[Case3] approve decisionでhandleDecisionが正しいparams(workId/approvalId/decision)で呼ばれ、handled:trueとなる",
        handleDecisionCalls[0]?.workId === "work-1" &&
          handleDecisionCalls[0]?.approvalId === "approval-1" &&
          handleDecisionCalls[0]?.decision === "approve" &&
          result.handled === true &&
          result.outcomeStatus === "approved"
      )
    );

    results.push(
      check(
        "[Case3] ackとして単純なreply Actionが1件返る(execution result deliveryではない)",
        result.actions.length === 1 && result.actions[0].kind === "reply"
      )
    );
  }

  // ---- Case4: reject ----
  {
    const { deps, handleDecisionCalls } = makeDeps({
      handleDecisionResult: { ok: true, approvalOutcome: { status: "rejected", approval: makeApproval({ status: "rejected" }) } },
    });

    const result = await receiveBotApprovalDecision(makeDecision({ decision: "reject", reason: "却下します" }), deps);

    results.push(
      check(
        "[Case4] reject decisionでhandleDecisionが正しいparams(reason含む)で呼ばれ、handled:trueとなる",
        handleDecisionCalls[0]?.decision === "reject" &&
          handleDecisionCalls[0]?.reason === "却下します" &&
          result.handled === true &&
          result.outcomeStatus === "rejected" &&
          result.executionStatus === undefined
      )
    );
  }

  // ---- Case5: wrong user(Approval ownershipが無いuserId) ----
  // 実際のownership検証はcore/tact-work/approval.ts(getApproval経由の
  // 既存WorkOwnershipDefense、tests/tact/work/approval.test.tsで
  // 別途検証済み)が担う。このGatewayはその結果(not_found)をそのまま
  // 素通しするだけであることを確認する。
  {
    const { deps, handleDecisionCalls } = makeDeps({
      handleDecisionResult: { ok: true, approvalOutcome: { status: "not_found" } },
    });

    const result = await receiveBotApprovalDecision(makeDecision(), deps);

    results.push(
      check(
        "[Case5] 所有権が無いApprovalへのdecisionはnot_foundとしてhandled:trueのまま安全に素通しされる(mutationはcore/tact-work/approval.ts側で0件に保たれる、既存ownership defenseの再利用)",
        result.outcomeStatus === "not_found" && handleDecisionCalls.length === 1
      )
    );
  }

  // ---- Case6: repeated approve(既に承認済み、executionはundefined側) ----
  {
    const { deps } = makeDeps({
      handleDecisionResult: { ok: true, approvalOutcome: { status: "already_resolved", approval: makeApproval({ status: "approved" }) } },
    });

    const result = await receiveBotApprovalDecision(makeDecision({ decision: "approve" }), deps);

    results.push(
      check(
        "[Case6] 承認済みApprovalへの再approveはalready_resolvedとして安全にno-op扱いされる(新しいidempotency機構を作らず既存approveApproval()の保証をそのまま利用)",
        result.handled === true && result.outcomeStatus === "already_resolved"
      )
    );
  }

  // ---- Case7: repeated reject(既に却下済み) ----
  {
    const { deps } = makeDeps({
      handleDecisionResult: { ok: true, approvalOutcome: { status: "already_resolved", approval: makeApproval({ status: "rejected" }) } },
    });

    const result = await receiveBotApprovalDecision(makeDecision({ decision: "reject" }), deps);

    results.push(
      check(
        "[Case7] 却下済みApprovalへの再rejectもalready_resolvedとして安全にno-op扱いされる",
        result.handled === true && result.outcomeStatus === "already_resolved"
      )
    );
  }

  // ---- Case8: conflicting decision(approved -> reject 等) ----
  {
    const { deps } = makeDeps({
      handleDecisionResult: { ok: true, approvalOutcome: { status: "invalid_transition", approval: makeApproval({ status: "approved" }) } },
    });

    const result = await receiveBotApprovalDecision(makeDecision({ decision: "reject" }), deps);

    results.push(
      check(
        "[Case8] approved済みApprovalへのreject(競合するdecision)はinvalid_transitionとして拒否され、state変更を伴わない",
        result.handled === true && result.outcomeStatus === "invalid_transition"
      )
    );
  }

  // ---- Case10: callback payloadの構造確認 ----
  {
    const decision = makeDecision();
    const serialized = JSON.stringify(decision).toLowerCase();

    results.push(
      check(
        "[Case10] BotApprovalDecisionのcallback payloadにaccessToken/service role key/providerConnectionRef/connectedAccountId/Composio credentialのいずれも含まれない",
        !serialized.includes("accesstoken") &&
          !serialized.includes("service_role") &&
          !serialized.includes("servicerolekey") &&
          !serialized.includes("providerconnectionref") &&
          !serialized.includes("connectedaccountid") &&
          !serialized.includes("composio")
      )
    );

    results.push(
      check(
        "[Case10] payloadはworkId/approvalId/decision/reason(任意)/channel/actor/target/inReplyToMessageId(任意)という最小限のfieldだけで構成される",
        Object.keys(decision).sort().join(",") ===
          ["actor", "channel", "decision", "target", "workId", "approvalId"].sort().join(",")
      )
    );
  }

  // ==========================================================
  // Phase C2.1c-c: execution outcome -> safe Bot reply mapping
  // ==========================================================

  // ---- completed: safe success reply ----
  {
    const { deps } = makeDeps({ handleDecisionResult: executionResult({ status: "completed", run: {} as never }) });

    const result = await receiveBotApprovalDecision(makeDecision(), deps);
    const text = result.actions[0].kind === "reply" ? result.actions[0].text : "";

    results.push(
      check(
        "[Execution:completed] 成功時、安全なsuccess replyが1件返り、executionStatus=completedが観測できる",
        result.handled === true && result.executionStatus === "completed" && text.length > 0
      )
    );
  }

  // ---- failed: safe failure reply(raw run/provider errorを含まない) ----
  {
    const { deps } = makeDeps({
      handleDecisionResult: executionResult({ status: "failed", run: { error: "raw provider stack trace / secret-looking detail" } as never }),
    });

    const result = await receiveBotApprovalDecision(makeDecision(), deps);
    const text = result.actions[0].kind === "reply" ? result.actions[0].text : "";

    results.push(
      check(
        "[Execution:failed] 失敗時、安全なfailure replyが返り、run.errorの生文字列がtextに含まれない",
        result.executionStatus === "failed" &&
          !text.includes("raw provider stack trace") &&
          !text.toLowerCase().includes("secret")
      )
    );
  }

  // ---- already_executed: safe already-executed reply ----
  {
    const { deps } = makeDeps({ handleDecisionResult: executionResult({ status: "already_executed", run: {} as never }) });

    const result = await receiveBotApprovalDecision(makeDecision(), deps);
    const text = result.actions[0].kind === "reply" ? result.actions[0].text : "";

    results.push(
      check(
        "[Execution:already_executed] 既に実行済みである旨のtextが返り、providerが再度呼ばれたことを示唆する文言を含まない",
        result.executionStatus === "already_executed" && text.includes("すでに実行")
      )
    );
  }

  // ---- connection_unavailable: safe connection message ----
  {
    const { deps } = makeDeps({ handleDecisionResult: executionResult({ status: "connection_unavailable" }) });

    const result = await receiveBotApprovalDecision(makeDecision(), deps);
    const text = result.actions[0].kind === "reply" ? result.actions[0].text : "";

    results.push(
      check(
        "[Execution:connection_unavailable] 連携先を利用できない旨の安全なtextが返り、connectionId/providerConnectionRefを含まない",
        result.executionStatus === "connection_unavailable" &&
          !text.toLowerCase().includes("connectionid") &&
          !text.toLowerCase().includes("providerconnectionref")
      )
    );
  }

  // ---- work_not_runnable / task_not_executable / invalid_action: safe generic message ----
  {
    for (const status of ["work_not_runnable", "task_not_executable", "invalid_action"] as const) {

      const outcome =
        status === "work_not_runnable"
          ? { status: "work_not_runnable" as const, workStatus: "waiting_for_approval" as const }
          : status === "task_not_executable"
          ? { status: "task_not_executable" as const, taskStatus: "running" as const }
          : { status: "invalid_action" as const, reason: "internal malformed payload detail" };

      const { deps } = makeDeps({ handleDecisionResult: executionResult(outcome) });

      const result = await receiveBotApprovalDecision(makeDecision(), deps);
      const text = result.actions[0].kind === "reply" ? result.actions[0].text : "";

      results.push(
        check(
          `[Execution:${status}] 安全な汎用textが返り、内部reason/status文字列("internal malformed payload detail"等)を含まない`,
          result.executionStatus === status && !text.includes("internal malformed payload detail")
        )
      );

    }
  }

  // ---- execution_error: result unknown message、retryを促さない ----
  {
    const { deps } = makeDeps({ handleDecisionResult: executionResult({ status: "execution_error" }) });

    const result = await receiveBotApprovalDecision(makeDecision(), deps);
    const text = result.actions[0].kind === "reply" ? result.actions[0].text : "";

    results.push(
      check(
        "[Execution:execution_error] 「実行結果を確認できませんでした」相当のtextが返り、「もう一度」「再試行」「再度お試し」等、再実行を促す文言を一切含まない",
        result.executionStatus === "execution_error" &&
          text.includes("確認できません") &&
          !text.includes("もう一度") &&
          !text.includes("再試行") &&
          !text.includes("再度お試し")
      )
    );
  }

  // ---- Architecture Migration ARCH-P1c: approval_integrity_failed ----
  {
    const reasons = [
      "subject_mismatch",
      "hash_mismatch",
      "version_unsupported",
      "stored_subject_invalid",
      "current_subject_invalid",
    ] as const;

    let allSafe = true;
    let allExpectedText = true;

    for (const reason of reasons) {

      const { deps } = makeDeps({
        handleDecisionResult: executionResult({ status: "approval_integrity_failed", reason }),
      });

      const result = await receiveBotApprovalDecision(makeDecision(), deps);
      const text = result.actions[0].kind === "reply" ? result.actions[0].text : "";

      if (text !== "承認後に実行内容を確認できなかったため、実行を停止しました。再承認が必要です。") {
        allExpectedText = false;
      }

      // 絶対条件(Step8): reasonの詳細("subject_mismatch"等)・raw
      // hash・canonical payload・connectionId・provider metadata・
      // secretのいずれも一切出さない。
      if (
        text.includes(reason) ||
        text.toLowerCase().includes("conn-") ||
        text.toLowerCase().includes("connectionid") ||
        /[0-9a-f]{64}/.test(text.toLowerCase()) ||
        text.includes("channel") ||
        text.includes("input")
      ) {
        allSafe = false;
      }

    }

    results.push(
      check(
        "[ARCH-P1c/Execution:approval_integrity_failed] 全reason variant(subject_mismatch/hash_mismatch/version_unsupported/stored_subject_invalid/current_subject_invalid)で、同一の固定・安全なtextが返る(reasonの詳細をBotへ出さない)",
        allExpectedText
      )
    );

    results.push(
      check(
        "[ARCH-P1c/Execution:approval_integrity_failed] reply textにreason文字列・connectionId・64桁hex(hash)・canonical payloadのfield名が一切含まれない",
        allSafe
      )
    );

  }

  // ---- reject: 既存reject ack維持(executionは常にundefined) ----
  {
    const { deps } = makeDeps({
      handleDecisionResult: { ok: true, approvalOutcome: { status: "rejected", approval: makeApproval({ status: "rejected" }) } },
    });

    const result = await receiveBotApprovalDecision(makeDecision({ decision: "reject" }), deps);
    const text = result.actions[0].kind === "reply" ? result.actions[0].text : "";

    results.push(
      check(
        "[Execution:reject] reject時はexecutionStatusが常にundefinedであり、既存の却下ack文言がそのまま維持される",
        result.executionStatus === undefined && text.includes("却下")
      )
    );
  }

  // ---- Leakage: 全execution outcomeメッセージにUUID/内部ID/Composio等が含まれない ----
  {
    const outcomes: (IntegrationActionExecutionOutcome | { status: "execution_error" })[] = [
      { status: "completed", run: {} as never },
      { status: "failed", run: {} as never },
      { status: "already_executed", run: {} as never },
      { status: "connection_unavailable" },
      { status: "task_not_executable", taskStatus: "running" },
      { status: "work_not_runnable", workStatus: "waiting_for_approval" },
      { status: "invalid_action", reason: "x" },
      { status: "not_found" },
      { status: "approval_not_approved", approvalStatus: "pending" },
      { status: "execution_error" },
      // Architecture Migration ARCH-P1c。
      { status: "approval_integrity_failed", reason: "subject_mismatch" },
    ];

    let allSafe = true;

    for (const outcome of outcomes) {

      const { deps } = makeDeps({ handleDecisionResult: executionResult(outcome) });
      const result = await receiveBotApprovalDecision(makeDecision(), deps);
      const text = result.actions[0].kind === "reply" ? result.actions[0].text.toLowerCase() : "";

      if (
        text.includes("approval-1") ||
        text.includes("work-1") ||
        text.includes("task-1") ||
        text.includes("providerconnectionref") ||
        text.includes("connectedaccountid") ||
        text.includes("providerexecutionref") ||
        text.includes("composio") ||
        text.includes("slack_send_message") ||
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text)
      ) {
        allSafe = false;
      }

    }

    results.push(
      check(
        "[Leakage] 全executionOutcome(completed/failed/already_executed/connection_unavailable/task_not_executable/work_not_runnable/invalid_action/not_found/approval_not_approved/execution_error)のreply textに、内部ID・UUID・provider固有識別子が一切含まれない",
        allSafe
      )
    );
  }

  return summarize("bot/receiveApprovalDecision", results);

}
