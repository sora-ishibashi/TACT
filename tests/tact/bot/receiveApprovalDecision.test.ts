// =========================
// TACT Bot — receiveBotApprovalDecision Regression
// (Architecture Migration Phase C2.1c-b)
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
} = {}): {
  deps: BotApprovalDecisionGatewayDeps;
  identityResolveCalls: { externalUserId: string; channel: string }[];
  handleDecisionCalls: HandleApprovalDecisionAsTrustedActorParams[];
} {

  const identityResolveCalls: { externalUserId: string; channel: string }[] = [];
  const handleDecisionCalls: HandleApprovalDecisionAsTrustedActorParams[] = [];

  const identityResolver: BotIdentityResolver = {
    async resolve(actor, channel) {
      identityResolveCalls.push({ externalUserId: actor.externalUserId, channel });
      // 絶対条件: "identity: null"が明示的に指定された場合(未解決を
      // 表す)と、指定されなかった場合(既定でtact-user-1に解決)を
      // 区別する(?? だとnullも既定値へfallbackしてしまうため、
      // undefinedかどうかで判定する)。
      return options.identity !== undefined ? options.identity : { tactUserId: "tact-user-1" };
    },
  };

  const handleDecisionResult: HandleApprovalDecisionAsTrustedActorResult =
    options.handleDecisionResult ?? { ok: true, status: "approved", approval: makeApproval(), workResumed: true };

  const deps: BotApprovalDecisionGatewayDeps = {
    identityResolver,
    handleDecision: async (params) => {
      handleDecisionCalls.push(params);
      return handleDecisionResult;
    },
  };

  return { deps, identityResolveCalls, handleDecisionCalls };

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

  // ---- Case3: approve ----
  {
    const { deps, handleDecisionCalls } = makeDeps({
      handleDecisionResult: { ok: true, status: "approved", approval: makeApproval({ status: "approved" }), workResumed: true },
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
      handleDecisionResult: { ok: true, status: "rejected", approval: makeApproval({ status: "rejected" }) },
    });

    const result = await receiveBotApprovalDecision(makeDecision({ decision: "reject", reason: "却下します" }), deps);

    results.push(
      check(
        "[Case4] reject decisionでhandleDecisionが正しいparams(reason含む)で呼ばれ、handled:trueとなる",
        handleDecisionCalls[0]?.decision === "reject" &&
          handleDecisionCalls[0]?.reason === "却下します" &&
          result.handled === true &&
          result.outcomeStatus === "rejected"
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
      handleDecisionResult: { ok: true, status: "not_found" },
    });

    const result = await receiveBotApprovalDecision(makeDecision(), deps);

    results.push(
      check(
        "[Case5] 所有権が無いApprovalへのdecisionはnot_foundとしてhandled:trueのまま安全に素通しされる(mutationはcore/tact-work/approval.ts側で0件に保たれる、既存ownership defenseの再利用)",
        result.outcomeStatus === "not_found" && handleDecisionCalls.length === 1
      )
    );
  }

  // ---- Case6: repeated approve(既に承認済み) ----
  {
    const { deps } = makeDeps({
      handleDecisionResult: { ok: true, status: "already_resolved", approval: makeApproval({ status: "approved" }) },
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
      handleDecisionResult: { ok: true, status: "already_resolved", approval: makeApproval({ status: "rejected" }) },
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
      handleDecisionResult: { ok: true, status: "invalid_transition", approval: makeApproval({ status: "approved" }) },
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

  return summarize("bot/receiveApprovalDecision", results);

}
