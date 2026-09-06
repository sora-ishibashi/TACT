// =========================
// TACT Bot — receiveBotApprovalDecision
// (Architecture Migration Phase C2.1c-b)
// =========================
//
// receiveBotMessage()(BOT-P1)と対になる、Approval decision専用の
// 狭い入口。概念的な流れ:
//
//   receiveBotApprovalDecision
//     ↓
//   identity resolver (receiveBotMessage()と全く同じ既存resolver)
//     ↓
//   handleApprovalDecisionAsTrustedActor
//     (Trusted Bot Execution Boundary、core/tact-bot/execution/
//      trustedApprovalDecision.ts経由でcore/tact-work/approval.tsの
//      approveApproval()/rejectApproval()を呼ぶ)
//     ↓
//   BotAction[](ack replyのみ、execution result deliveryではない)
//
// 絶対条件(Section8、最重要): BotApprovalDecision(core/tact-bot/
// types.ts)にはaccessToken/service role key/providerConnectionRef/
// connectedAccountId/Composio credentialのいずれも存在しない
// (型定義自体がそれらのfieldを持たない)。tactUserIdもこの入口の
// 引数には存在せず、必ずidentityResolver経由で解決する
// (BOT-P2.5のexternal identity→trusted tactUserIdという既存順序を
// そのまま踏襲)。

import type { BotAction, BotApprovalDecision } from "../types";
import {
  unresolvedIdentityResolver,
  type BotIdentityResolver,
} from "../identity/resolver";
import {
  handleApprovalDecisionAsTrustedActor,
  type HandleApprovalDecisionAsTrustedActorParams,
  type HandleApprovalDecisionAsTrustedActorResult,
} from "../execution/trustedApprovalDecision";

export interface BotApprovalDecisionGatewayDeps {

  // 省略時はunresolvedIdentityResolver(常にnull)を使う
  // (receiveBotMessage()と同じ既定、絶対条件: 存在しないTACT userへ
  // fallbackしない)。
  identityResolver?: BotIdentityResolver;

  // 省略時は実際のTrusted Bot Execution Boundaryを使う。
  handleDecision?: (
    params: HandleApprovalDecisionAsTrustedActorParams
  ) => Promise<HandleApprovalDecisionAsTrustedActorResult>;

}

export type ReceiveBotApprovalDecisionReason =
  | "identity_unresolved"
  | "trusted_execution_not_configured";

export interface ReceiveBotApprovalDecisionResult {

  handled: boolean;

  // handled=falseの場合のみ設定される。
  reason?: ReceiveBotApprovalDecisionReason;

  // 実際のApprovalResolutionOutcome(core/tact-work/approval.ts)。
  // handled=trueの場合のみ設定される。
  outcomeStatus?: string;

  actions: BotAction[];

}

function buildIdentityRequiredMessage(): string {
  return "このアカウントはまだTACTアカウントと連携されていません。連携後にもう一度お試しください。";
}

function buildNotConfiguredMessage(): string {
  return "現在この操作を処理できません。しばらくお待ちください。";
}

// ApprovalResolutionOutcome.statusごとのack文言。新しい業務判断は
// 一切加えない(既存core/tact-work/approval.tsが確定させた結果を
// そのまま人間可読な文字列へ変換するだけ)。
function buildAckMessage(decision: "approve" | "reject", outcomeStatus: string): string {

  switch (outcomeStatus) {
    case "approved":
      return "承認しました。";
    case "rejected":
      return "却下しました。";
    case "already_resolved":
      return decision === "approve"
        ? "このApprovalは既に処理済みです。"
        : "このApprovalは既に処理済みです。";
    case "invalid_transition":
      return "このApprovalは現在の状態では処理できません。";
    case "work_not_resumable":
      return "このApprovalに対応するWorkは既に終了しているため処理できません。";
    case "not_found":
      return "対象のApprovalが見つかりませんでした。";
    default:
      return "処理結果を確認できませんでした。";
  }

}

export async function receiveBotApprovalDecision(
  decision: BotApprovalDecision,
  deps: BotApprovalDecisionGatewayDeps = {}
): Promise<ReceiveBotApprovalDecisionResult> {

  const identityResolver = deps.identityResolver ?? unresolvedIdentityResolver;
  const handleDecision = deps.handleDecision ?? handleApprovalDecisionAsTrustedActor;

  // BOT-P2.5と全く同じ順序: external identity → trusted tactUserId
  // resolution → canonical handler。外部Bot user id(decision.actor.
  // externalUserId)を直接canonical handlerのtactUserIdとして使わない。
  const identity = await identityResolver.resolve(decision.actor, decision.channel);

  if (!identity) {

    return {
      handled: false,
      reason: "identity_unresolved",
      actions: [
        {
          kind: "reply",
          target: decision.target,
          inReplyToMessageId: decision.inReplyToMessageId,
          text: buildIdentityRequiredMessage(),
        },
      ],
    };

  }

  const result = await handleDecision({
    tactUserId: identity.tactUserId,
    workId: decision.workId,
    approvalId: decision.approvalId,
    decision: decision.decision,
    reason: decision.reason,
  });

  if (!result.ok) {

    return {
      handled: false,
      reason: "trusted_execution_not_configured",
      actions: [
        {
          kind: "reply",
          target: decision.target,
          inReplyToMessageId: decision.inReplyToMessageId,
          text: buildNotConfiguredMessage(),
        },
      ],
    };

  }

  return {
    handled: true,
    outcomeStatus: result.status,
    actions: [
      {
        kind: "reply",
        target: decision.target,
        inReplyToMessageId: decision.inReplyToMessageId,
        text: buildAckMessage(decision.decision, result.status),
      },
    ],
  };

}
