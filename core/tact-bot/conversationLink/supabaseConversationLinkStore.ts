// =========================
// TACT Bot — Supabase Conversation Link Store (BOT-P2)
// =========================
//
// tact_bot_conversation_links(supabase/migrations/
// 20260830010000_create_tact_bot_identity_tables.sql、workspace scope
// はSOR-52 Closeout Hardening Part8で追加)への唯一のアクセス経路。
// 外部Channelのconversation/thread(例: Slack channel + thread_ts)と
// TACT Conversationを紐付け、同一threadでの続きの発言や
// Clarificationへの返信が同じTACT Conversationへ継続するようにする
// (Conversationの扱い節)。
//
// SOR-52 Closeout Hardening Part8(blocker): externalWorkspaceId
// (Slack team_id等)を一意性の一部に追加した——同じuserが複数の
// Slack workspaceを接続した場合でも、channel IDだけに依存せず
// resource identityを区別する(tact_external_identitiesが既に
// external_workspace_idを一意性へ含めているのと同じ理由)。
//
// このtableもRLSポリシーを1つも持たない(service role専用)。
// DB接続エラー・service role未設定はいずれも安全側(null/false、
// 新規Conversationとして扱う)へfallbackする——見つからなければ
// 単に新規Conversationが作られるだけであり、Bot Gateway全体を
// 落とすような失敗にはしない。

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import type { LinkableBotChannel } from "../identity/supabaseIdentityStore";

export interface FindConversationLinkParams {
  channel: LinkableBotChannel;
  // Slack team_id等。省略可能(workspace概念を持たないproviderのため)
  // だが、Slack向けの呼び出し元は必ず渡す(絶対条件、Part8)。
  externalWorkspaceId?: string;
  externalConversationId: string;
  externalThreadId?: string;
}

export interface CreateConversationLinkParams extends FindConversationLinkParams {
  tactConversationId: string;
}

// 該当する外部thread/conversationに紐付くTACT conversation idを返す。
// 見つからない場合はnull(=呼び出し元は新規Conversationを作成する)。
export async function findConversationLink(
  params: FindConversationLinkParams
): Promise<string | null> {

  const client = getServiceRoleClient();

  if (!client) {
    return null;
  }

  let query = client
    .from("tact_bot_conversation_links")
    .select("tact_conversation_id")
    .eq("channel", params.channel)
    .eq("external_conversation_id", params.externalConversationId);

  query = params.externalWorkspaceId
    ? query.eq("external_workspace_id", params.externalWorkspaceId)
    : query.is("external_workspace_id", null);

  query = params.externalThreadId
    ? query.eq("external_thread_id", params.externalThreadId)
    : query.is("external_thread_id", null);

  const { data, error } = await query.maybeSingle();

  if (error) {
    console.error("[tact-bot] findConversationLink failed:", error.message);
    return null;
  }

  if (!data) {
    return null;
  }

  return (data as { tact_conversation_id: string }).tact_conversation_id;

}

// 新規に作成したTACT Conversationを、外部thread/conversationへ紐付ける。
// 既に同じ(channel, externalWorkspaceId, externalConversationId,
// externalThreadId)の行があれば更新する(find→update/insertの2段、
// identity storeと同じ理由でnative upsertは使わない)。
export async function createConversationLink(
  params: CreateConversationLinkParams
): Promise<boolean> {

  const client = getServiceRoleClient();

  if (!client) {
    return false;
  }

  let findQuery = client
    .from("tact_bot_conversation_links")
    .select("id")
    .eq("channel", params.channel)
    .eq("external_conversation_id", params.externalConversationId);

  findQuery = params.externalWorkspaceId
    ? findQuery.eq("external_workspace_id", params.externalWorkspaceId)
    : findQuery.is("external_workspace_id", null);

  findQuery = params.externalThreadId
    ? findQuery.eq("external_thread_id", params.externalThreadId)
    : findQuery.is("external_thread_id", null);

  const { data: existing, error: findError } = await findQuery.maybeSingle();

  if (findError) {
    console.error("[tact-bot] createConversationLink (lookup) failed:", findError.message);
    return false;
  }

  if (existing) {

    const { error } = await client
      .from("tact_bot_conversation_links")
      .update({ tact_conversation_id: params.tactConversationId })
      .eq("id", (existing as { id: string }).id);

    if (error) {
      console.error("[tact-bot] createConversationLink (update) failed:", error.message);
      return false;
    }

    return true;

  }

  const { error } = await client
    .from("tact_bot_conversation_links")
    .insert({
      tact_conversation_id: params.tactConversationId,
      channel: params.channel,
      external_workspace_id: params.externalWorkspaceId ?? null,
      external_conversation_id: params.externalConversationId,
      external_thread_id: params.externalThreadId ?? null,
    });

  if (error) {
    console.error("[tact-bot] createConversationLink (insert) failed:", error.message);
    return false;
  }

  return true;

}
