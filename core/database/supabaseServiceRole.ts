import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// =========================
// Supabase Service Role Client (BOT-P2)
// =========================
//
// core/database/supabase.ts(既存、anon key固定)とは別の、TACT内で
// 唯一のSupabase service role key利用箇所。service roleはPostgresの
// RLSを常にbypassする特権ロールであるため、利用箇所を意図的に
// 最小限へ絞る。
//
// 利用が許可されているのはcore/tact-bot/配下のみ(BOT-P2絶対条件
// 「service role keyを無制限にCore全体へ渡さない」):
//   - core/tact-bot/identity/supabaseIdentityStore.ts
//       (tact_external_identities: RLSポリシーを1つも持たない
//       service role専用テーブル、supabase/migrations/
//       20260830010000_create_tact_bot_identity_tables.sql参照)
//   - core/tact-bot/conversationLink/supabaseConversationLinkStore.ts
//       (tact_bot_conversation_links: 同上)
//   - core/tact-bot/connector/conversationConnector.ts
//       (既存core/tact-conversation/store.tsの各関数へ、通常のuser
//       access tokenの代わりにservice role keyを「accessToken」として
//       渡す。store.ts側は auth.uid()=user_id等のRLSに依存する
//       Stage1テーブル(tact_conversations等)を対象とするため、RLSは
//       bypassされるが、store.tsの各関数は同時に明示的な
//       `.eq("user_id", userId)`等のapplication-level filterも
//       行っている(store.ts冒頭コメント参照)。呼び出し元
//       (conversationConnector.ts)が、外部Channel userの主張ではなく
//       identity resolver(core/tact-bot/identity/)がserver側で
//       解決した正規のtact_user_idだけをこのuserIdとして渡す限り、
//       他userのConversationへは到達しない)。
//
// それ以外のCore module(core/tact-research・core/tact-orchestrator・
// core/tact-core等)からは一切importしないこと。

let cachedClient: SupabaseClient | null | undefined;

export function isServiceRoleConfigured(): boolean {

  return (
    typeof process.env.SUPABASE_SERVICE_ROLE_KEY === "string" &&
    process.env.SUPABASE_SERVICE_ROLE_KEY.length > 0
  );

}

// service role keyの生の文字列。既存のcore/tact-conversation/store.ts
// のcreateRequestScopedClient(accessToken)へ、通常のuser access token
// の代わりにそのまま渡す(store.ts自体は変更しない、token-agnostic
// design)ためのもの。
export function getServiceRoleKey(): string | null {

  return isServiceRoleConfigured() ? process.env.SUPABASE_SERVICE_ROLE_KEY! : null;

}

// tact_external_identities/tact_bot_conversation_links
// (RLSポリシーを持たないservice role専用table)へ直接クエリするための
// client。遅延生成し、環境変数が未設定のmodule読み込み時に例外を
// 投げない(BOT-P2時点ではSUPABASE_SERVICE_ROLE_KEYは未設定のため、
// この関数は常にnullを返す想定——呼び出し元は必ずnullを安全に
// 扱うこと)。
export function getServiceRoleClient(): SupabaseClient | null {

  if (!isServiceRoleConfigured()) {
    return null;
  }

  if (cachedClient !== undefined) {
    return cachedClient;
  }

  cachedClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );

  return cachedClient;

}
