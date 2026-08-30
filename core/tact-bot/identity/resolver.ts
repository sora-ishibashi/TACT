// =========================
// TACT Bot — Identity Resolver (BOT-P1 / BOT-P2)
// =========================
//
// externalUserId(Slack user ID等)からTACT側のuserId(BotIdentity)を
// 解決するためのinterface。
//
// BOT-P1時点では、外部user⇄TACT userの永続的なmapping機構
// (「DB schemaの大規模変更は今回行わない」という制約に抵触するため)を
// 意図的に実装せず、default実装(unresolvedIdentityResolver)は常に
// nullを返す、安全側の未解決状態を表現するだけの実装とした。
//
// BOT-P2: tact_external_identities(supabase/migrations/
// 20260830010000_create_tact_bot_identity_tables.sql)を追加し、
// 実装(supabaseIdentityResolver.ts、identity/supabaseIdentityStore.ts)
// を用意した。identity lookupはprovider・external_user_id・
// external_workspace_id(同じexternal_user_idでもworkspace/teamが
// 異なれば別人でありうるため)の3つで行う必要があるため、resolve()の
// 第3引数としてexternalWorkspaceIdを追加した(既存呼び出し元
// (gateway/receiveMessage.ts)がBotIncomingMessage.organizationIdを
// そのまま渡す)。既存のresolve(actor, channel)だけを実装したfake/
// unresolvedIdentityResolverは、TypeScriptの構造的型付け上
// このまま(第3引数を宣言しなくても)引き続き有効。
//
// unresolvedIdentityResolverは変わらず、存在しないTACT userへ
// fallbackする・匿名userとして処理を進める、といった振る舞いは
// 一切行わない。

import type { BotActor, BotChannel, BotIdentity } from "../types";

export interface BotIdentityResolver {

  resolve(
    actor: BotActor,
    channel: BotChannel,
    externalWorkspaceId?: string
  ): Promise<BotIdentity | null>;

}

export const unresolvedIdentityResolver: BotIdentityResolver = {

  async resolve(): Promise<BotIdentity | null> {
    return null;
  },

};
