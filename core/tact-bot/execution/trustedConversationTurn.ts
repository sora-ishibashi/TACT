// =========================
// TACT Bot — Trusted Bot Execution Boundary (BOT-P2.5)
// =========================
//
// BOT-P2投資調査(BOT-P2.5)で判明した問題: core/tact-bot/connector/
// conversationConnector.tsが、service role keyを
// RunConversationTurnParams.accessTokenへ直接渡し、Web(本物のuser
// JWT)と同じ関数呼び出し形へそのまま合流させていた。動作自体は
// (userId明示フィルタ+RLSの二重防御により)安全だったが、「service
// role keyをuser access tokenの代用品として扱う」ように見える構造で
// あり、「Botがservice role JWTを使ってユーザー本人として認証された
// ように見せる」設計を避けるという方針に反していた。
//
// この境界は、Bot側の「trusted server-side execution」という認証
// モードを明示的に表現する。呼び出し元(conversationConnector.ts)は
// もはやservice role keyという値そのものを一切扱わない
// (accessTokenという概念自体がこの境界の外に出てこない)。
//
//   Web:  User JWT
//           → runConversationTurnAsAuthenticatedUser()
//               (core/tact-conversation/orchestration.ts)
//           → runConversationTurn() [shared conversation turn logic]
//
//   Bot:  server-side verified external identity (tactUserId)
//           → runConversationTurnAsTrustedActor() [ここ]
//           → runConversationTurn() [shared conversation turn logic]
//
// Business logic(Conversation解決・Orchestrator実行・Artifact
// Mutation・Clarification)はWeb/Botで完全に共通(runConversationTurn)。
// この境界が担うのはAuthentication/Authorizationの意味づけだけであり、
// 新しいConversation business logicを一切持たない
// (「Botのために独自のConversation管理を作らない」絶対条件)。
//
// service role keyはこのファイル(core/database/supabaseServiceRole.ts
// 経由)でのみ読み出す。呼び出し元・戻り値・Errorのいずれにも生の
// key文字列を含めない。

import {
  runConversationTurn,
  type RunConversationTurnResult,
} from "../../tact-conversation";
import type { AttachmentEvidence } from "../../tact-attachment/types";
import type { LocalWorkspaceEvidence } from "../../tact-context-source/localWorkspace/types";
import { getServiceRoleKey } from "../../database/supabaseServiceRole";

// Web向けのRunConversationTurnParamsとの意図的な違い: userId/accessToken
// を受け取らない。tactUserIdはserver-side identity resolver
// (core/tact-bot/identity/)が既に検証済みの値であることを、呼び出し元
// (conversationConnector.ts)が保証する——この関数自体はそれを再検証
// しない(identity解決はこの関数の責務ではない、既存の役割分担を
// 重複させない)。
export interface RunConversationTurnAsTrustedActorParams {

  tactUserId: string;

  content: string;

  conversationId?: string;

  attachmentEvidence?: AttachmentEvidence[];

  workspaceEvidence?: LocalWorkspaceEvidence[];

}

export type RunConversationTurnAsTrustedActorResult =
  | RunConversationTurnResult
  | { ok: false; error: "trusted_execution_not_configured" };

// service role key(=Bot専用のtrusted server-side execution credential)
// が未設定の場合、DBへは一切アクセスせず安全にfallbackする
// (SUPABASE_SERVICE_ROLE_KEYが未設定のBOT-P2/BOT-P2.5時点の既定状態、
// core/database/supabaseServiceRole.ts参照)。
export async function runConversationTurnAsTrustedActor(
  params: RunConversationTurnAsTrustedActorParams
): Promise<RunConversationTurnAsTrustedActorResult> {

  const trustedExecutionCredential = getServiceRoleKey();

  if (!trustedExecutionCredential) {
    return { ok: false, error: "trusted_execution_not_configured" };
  }

  return runConversationTurn({
    userId: params.tactUserId,
    accessToken: trustedExecutionCredential,
    content: params.content,
    conversationId: params.conversationId,
    attachmentEvidence: params.attachmentEvidence,
    workspaceEvidence: params.workspaceEvidence,
  });

}
