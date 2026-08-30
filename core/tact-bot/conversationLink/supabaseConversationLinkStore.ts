// =========================
// TACT Bot — Supabase Conversation Link Store (BOT-P2)
// =========================
//
// tact_bot_conversation_links(supabase/migrations/
// 20260830010000_create_tact_bot_identity_tables.sql)への唯一の
// アクセス経路。外部Channelのconversation/thread(例: Slack channel +
// thread_ts)とTACT Conversationを紐付け、同一threadでの続きの発言や
// Clarificationへの返信が同じTACT Conversationへ継続するようにする
// (Conversationの扱い節)。
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

  const baseQuery = client
    .from("tact_bot_conversation_links")
    .select("tact_conversation_id")
    .eq("channel", params.channel)
    .eq("external_conversation_id", params.externalConversationId);

  const { data, error } = await (
    params.externalThreadId
      ? baseQuery.eq("external_thread_id", params.externalThreadId)
      : baseQuery.is("external_thread_id", null)
  ).maybeSingle();

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
// 既に同じ(channel, externalConversationId, externalThreadId)の行が
// あれば更新する(find→update/insertの2段、identity storeと同じ理由
// でnative upsertは使わない)。
export async function createConversationLink(
  params: CreateConversationLinkParams
): Promise<boolean> {

  const client = getServiceRoleClient();

  if (!client) {
    return false;
  }

  const findQuery = client
    .from("tact_bot_conversation_links")
    .select("id")
    .eq("channel", params.channel)
    .eq("external_conversation_id", params.externalConversationId);

  const { data: existing, error: findError } = await (
    params.externalThreadId
      ? findQuery.eq("external_thread_id", params.externalThreadId)
      : findQuery.is("external_thread_id", null)
  ).maybeSingle();

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
      external_conversation_id: params.externalConversationId,
      external_thread_id: params.externalThreadId ?? null,
    });

  if (error) {
    console.error("[tact-bot] createConversationLink (insert) failed:", error.message);
    return false;
  }

  return true;

}
