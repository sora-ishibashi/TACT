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
  type ExecutionOutcomeOrError,
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

  // Architecture Migration Phase C2.1c-c: executeApprovedIntegrationAction()
  // (core/tact-integration/execution.ts)へ実際に到達した場合のみ設定
  // される、canonical execution outcomeのstatus("execution_error"含む)。
  // reject時、またはapproveでもexecution条件を満たさなかった場合は
  // 常にundefined。
  executionStatus?: string;

  actions: BotAction[];

}

function buildIdentityRequiredMessage(): string {
  return "このアカウントはまだTACTアカウントと連携されていません。連携後にもう一度お試しください。";
}

function buildNotConfiguredMessage(): string {
  return "現在この操作を処理できません。しばらくお待ちください。";
}

// ApprovalResolutionOutcome.statusごとのack文言(executionへ到達しな
// かった場合のみ使う)。新しい業務判断は一切加えない(既存
// core/tact-work/approval.tsが確定させた結果をそのまま人間可読な
// 文字列へ変換するだけ)。
function buildApprovalOnlyAckMessage(decision: "approve" | "reject", outcomeStatus: string): string {

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

// Architecture Migration Phase C2.1c-c: executeApprovedIntegrationAction()
// のcanonical outcome(core/tact-integration/types.tsのstatus)だけを
// 見て、Bot向けの安全な文言へ変換する。絶対条件: run/providerの生の
// error・providerExecutionRef・connectionId・approvalId等の内部IDは
// 一切参照しない(outcome.statusという列挙値だけを見るswitch)。
// switch exhaustiveness: 新しいstatusが将来追加された場合、この
// exhaustiveCheckがTS compile errorとして気づかせる。
function buildExecutionAckMessage(outcome: ExecutionOutcomeOrError): string {

  switch (outcome.status) {

    case "completed":
      return "承認しました。送信が完了しました。";

    case "failed":
      return "承認しましたが、送信に失敗しました。";

    case "already_executed":
      return "この操作はすでに実行されています。";

    case "connection_unavailable":
      return "承認しましたが、連携先を利用できないため実行できませんでした。";

    case "task_not_executable":
    case "work_not_runnable":
    case "invalid_action":
      return "承認しましたが、現在この操作を実行できませんでした。";

    case "not_found":
    case "approval_not_approved":
      return "承認しましたが、対象の操作を確認できませんでした。";

    // Architecture Migration ARCH-P1c(docs/architecture/approval-integrity.md):
    // 承認された時点の内容と、実行直前の内容が一致しなかった場合の
    // 安全なmessage。絶対条件(Step8): reasonの詳細(missing_subject/
    // hash_mismatch/subject_mismatch等)・raw hash・canonical
    // payload・connectionId・provider metadata・secretのいずれも
    // 一切出さない——固定文言のみ。
    case "approval_integrity_failed":
      return "承認後に実行内容を確認できなかったため、実行を停止しました。再承認が必要です。";

    // Architecture Migration Phase C2.1c-c(ユーザー指示、最重要):
    // unexpected exception時は「結果不明」であることだけを伝える。
    // 「もう一度承認してください」「再試行してください」等、同じ
    // protected external writeの再実行を促す文言は絶対に含めない
    // (この状態を自動retryのsignalとして扱わないため)。
    case "execution_error":
      return "承認は完了しましたが、実行結果を確認できませんでした。";

    default: {
      const exhaustiveCheck: never = outcome;
      return exhaustiveCheck;
    }

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

  const { approvalOutcome, executionOutcome } = result;

  const text = executionOutcome
    ? buildExecutionAckMessage(executionOutcome)
    : buildApprovalOnlyAckMessage(decision.decision, approvalOutcome.status);

  return {
    handled: true,
    outcomeStatus: approvalOutcome.status,
    executionStatus: executionOutcome?.status,
    actions: [
      {
        kind: "reply",
        target: decision.target,
        inReplyToMessageId: decision.inReplyToMessageId,
        text,
      },
    ],
  };

}
