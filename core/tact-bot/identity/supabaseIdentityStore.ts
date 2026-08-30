// =========================
// TACT Bot — Supabase Identity Store (BOT-P2)
// =========================
//
// tact_external_identities(supabase/migrations/
// 20260830010000_create_tact_bot_identity_tables.sql)への唯一の
// アクセス経路。このテーブルはRLSポリシーを1つも持たない
// (service role専用)ため、core/database/supabaseServiceRole.ts
// 経由のservice role clientのみを使う。
//
// 重要: このファイルはexternal userをそのままTACT userとして信用しない
// (BOT-P2絶対条件)。findExternalIdentity()は既存のtact_user_id
// mappingを検索するだけであり、見つからない場合は常にnull(未解決)を
// 返す——存在しないTACT userへのfallbackや、external_user_idをTACT
// user idとして代用する設計は一切行わない。
//
// DB接続エラー・service role未設定のいずれでも、常に安全側(null/false)
// へfallbackする(呼び出し元のBot Gateway全体を落とさない、
// core/tact-context-source/localWorkspace/browserAdapter.tsの
// resolveWorkspaceContext()と同じ「0件/未解決で安全に継続する」設計を
// 踏襲する)。

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import type { BotChannel, BotIdentity } from "../types";

export type LinkableBotChannel = Exclude<BotChannel, "unknown">;

const LINKABLE_CHANNELS: readonly LinkableBotChannel[] = ["slack", "line", "teams", "discord"];

export function isLinkableChannel(channel: BotChannel): channel is LinkableBotChannel {
  return (LINKABLE_CHANNELS as readonly string[]).includes(channel);
}

export interface FindExternalIdentityParams {
  provider: LinkableBotChannel;
  externalUserId: string;
  externalWorkspaceId?: string;
}

export interface LinkExternalIdentityParams extends FindExternalIdentityParams {
  tactUserId: string;
}

// provider/external_user_id/external_workspace_idからtact_user_idを
// 検索する。1件も無い・service role未設定・DBエラーのいずれも
// nullを返す(未解決として安全に扱う)。
export async function findExternalIdentity(
  params: FindExternalIdentityParams
): Promise<BotIdentity | null> {

  const client = getServiceRoleClient();

  if (!client) {
    return null;
  }

  const baseQuery = client
    .from("tact_external_identities")
    .select("tact_user_id")
    .eq("provider", params.provider)
    .eq("external_user_id", params.externalUserId);

  const { data, error } = await (
    params.externalWorkspaceId
      ? baseQuery.eq("external_workspace_id", params.externalWorkspaceId)
      : baseQuery.is("external_workspace_id", null)
  ).maybeSingle();

  if (error) {
    console.error("[tact-bot] findExternalIdentity failed:", error.message);
    return null;
  }

  if (!data) {
    return null;
  }

  return { tactUserId: (data as { tact_user_id: string }).tact_user_id };

}

// 外部identityをTACT userへ紐付ける(将来のaccount linking flowが
// 呼び出す想定、BOT-P2では実UIから呼ばれない)。native upsertは
// 使わない: external_workspace_idがnullableなため、PostgRESTの
// on_conflict(列名ベース)ではNULLを一意制約として正しく扱えない
// (このtableのunique indexはcoalesce(external_workspace_id, '')という
// 式indexであり、単純な列名一致のon_conflictとは噛み合わないため)。
// find→update/insertの2段で明示的に行う。
export async function linkExternalIdentity(
  params: LinkExternalIdentityParams
): Promise<boolean> {

  const client = getServiceRoleClient();

  if (!client) {
    return false;
  }

  const findQuery = client
    .from("tact_external_identities")
    .select("id")
    .eq("provider", params.provider)
    .eq("external_user_id", params.externalUserId);

  const { data: existing, error: findError } = await (
    params.externalWorkspaceId
      ? findQuery.eq("external_workspace_id", params.externalWorkspaceId)
      : findQuery.is("external_workspace_id", null)
  ).maybeSingle();

  if (findError) {
    console.error("[tact-bot] linkExternalIdentity (lookup) failed:", findError.message);
    return false;
  }

  if (existing) {

    const { error } = await client
      .from("tact_external_identities")
      .update({ tact_user_id: params.tactUserId })
      .eq("id", (existing as { id: string }).id);

    if (error) {
      console.error("[tact-bot] linkExternalIdentity (update) failed:", error.message);
      return false;
    }

    return true;

  }

  const { error } = await client
    .from("tact_external_identities")
    .insert({
      tact_user_id: params.tactUserId,
      provider: params.provider,
      external_user_id: params.externalUserId,
      external_workspace_id: params.externalWorkspaceId ?? null,
    });

  if (error) {
    console.error("[tact-bot] linkExternalIdentity (insert) failed:", error.message);
    return false;
  }

  return true;

}
