// =========================
// TACT Bot — Trusted Approval Decision Boundary
// (Architecture Migration Phase C2.1c-b)
// =========================
//
// core/tact-bot/execution/trustedConversationTurn.ts(BOT-P2.5)と
// 全く同じ設計: 「server-side verified external identity(tactUserId)
// → trusted server-side execution」という認証モードを、Approval
// decision(approve/reject)についても明示的に表現する境界。
//
//   Web:  User JWT → approveApproval()/rejectApproval()を直接呼ぶ
//         (将来のWeb Approval UI、今回のscope外)
//   Bot:  server-side verified external identity(tactUserId)
//           → handleApprovalDecisionAsTrustedActor() [ここ]
//           → core/tact-work/approval.tsのapproveApproval()/
//             rejectApproval() [canonical Approval Execution Boundary、
//             Phase B3で確立済み、business logicはここに一切複製しない]
//
// service role keyはこのファイル(core/database/supabaseServiceRole.ts
// 経由)でのみ読み出す。呼び出し元・戻り値・Errorのいずれにも生の
// key文字列を含めない(trustedConversationTurn.tsと同じ絶対条件)。
//
// 絶対条件(Section6/9): executeApprovedIntegrationAction()はこの
// ファイルから一切呼ばない(C2.1c-cのscope)。approveApproval()/
// rejectApproval()自体が持つidempotency(already_resolved/
// invalid_transition)をそのまま再利用し、新しいidempotency機構は
// 作らない。

import { approveApproval, rejectApproval, type ApprovalResolutionOutcome } from "../../tact-work";
import { getServiceRoleKey } from "../../database/supabaseServiceRole";

// Web向けapproveApproval()/rejectApproval()との意図的な違い:
// accessTokenを受け取らない。tactUserIdはserver-side identity
// resolver(core/tact-bot/identity/)が既に検証済みの値であることを、
// 呼び出し元(core/tact-bot/gateway/receiveApprovalDecision.ts)が
// 保証する——この関数自体はそれを再検証しない(既存の役割分担を
// 重複させない、trustedConversationTurn.tsと同じ方針)。
export interface HandleApprovalDecisionAsTrustedActorParams {

  tactUserId: string;

  workId: string;

  approvalId: string;

  decision: "approve" | "reject";

  // reject時のみ意味を持つ(任意)。
  reason?: string;

}

export type HandleApprovalDecisionAsTrustedActorResult =
  | ({ ok: true } & ApprovalResolutionOutcome)
  | { ok: false; error: "trusted_execution_not_configured" };

// service role key(=Bot専用のtrusted server-side execution credential)
// が未設定の場合、DBへは一切アクセスせず安全にfallbackする
// (trustedConversationTurn.tsと同じ既存パターン)。
export async function handleApprovalDecisionAsTrustedActor(
  params: HandleApprovalDecisionAsTrustedActorParams
): Promise<HandleApprovalDecisionAsTrustedActorResult> {

  const trustedExecutionCredential = getServiceRoleKey();

  if (!trustedExecutionCredential) {
    return { ok: false, error: "trusted_execution_not_configured" };
  }

  const outcome =
    params.decision === "approve"
      ? await approveApproval(params.workId, params.tactUserId, trustedExecutionCredential, params.approvalId)
      : await rejectApproval(params.workId, params.tactUserId, trustedExecutionCredential, params.approvalId, params.reason);

  return { ok: true, ...outcome };

}
