import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import type { LinkableBotChannel } from "../identity/supabaseIdentityStore";

// =========================
// TACT Bot — Inbound Event Dedup Store (S1a)
// =========================
//
// tact_bot_processed_events(supabase/migrations/
// 20260908000000_create_tact_bot_processed_events.sql)への唯一の
// アクセス経路。既存identity/supabaseIdentityStore.ts・
// conversationLink/supabaseConversationLinkStore.tsと同じ理由で、
// このtableもRLSポリシーを1つも持たない(service role専用)。
//
// 絶対条件(Section16、atomic claim): 「SELECTして無ければINSERT」
// という2段の処理ではなく、DBのunique制約(channel, external_event_id)
// にそのままINSERTし、成功/unique_violationという結果自体で
// first-delivery/duplicateを判定する。これにより同時再送(concurrent
// retry)でも二重claimを構造的に防げる。
//
// 絶対条件(Section18、fail closed): service role未設定・DB接続
// エラーのいずれも"error"を返す——「duplicate扱いして捨てる」
// (dedup保証を失う)・「claimed扱いで処理を進める」(二重実行の
// リスクを負う)のどちらでもなく、呼び出し元(handleSlackWebhookRequest)
// が明示的にfail closed(processingしない・5xxでSlackの再送を促す)
// できるよう、既存のnull/false安全側fallback(BOT-P2の既存パターン)
// とは意図的に異なるsentinelを返す。

export type ClaimExternalEventResult = "claimed" | "duplicate" | "error";

export interface ClaimExternalEventParams {

  channel: LinkableBotChannel;

  externalEventId: string;

}

// PostgreSQL/PostgRESTのunique_violationエラーコード。
const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";

export async function claimExternalEvent(
  params: ClaimExternalEventParams
): Promise<ClaimExternalEventResult> {

  const client = getServiceRoleClient();

  if (!client) {
    return "error";
  }

  const { error } = await client
    .from("tact_bot_processed_events")
    .insert({
      channel: params.channel,
      external_event_id: params.externalEventId,
    });

  if (!error) {
    return "claimed";
  }

  if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_CODE) {
    return "duplicate";
  }

  console.error("[tact-bot] claimExternalEvent failed:", error.message);

  return "error";

}
