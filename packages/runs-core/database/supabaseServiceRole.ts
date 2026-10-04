import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// =========================
// Runs Core — Supabase Service Role Client (SOR-135 Phase 2)
// =========================
//
// SOR-135 Phase 2: this is Runs' OWN independent copy of the generic
// Supabase service-role client constructor, originally defined in root
// Yolna's core/database/supabaseServiceRole.ts (BOT-P2/BOT-P2.5). The file
// is intentionally duplicated rather than imported across the package
// boundary: packages/runs-core must be installable/buildable with zero
// Yolna source tree present, and Runs' and Yolna's service-role clients
// are expected to diverge further in a later phase (separate Supabase
// projects, separate SUPABASE_SERVICE_ROLE_KEY). The function bodies below
// are unchanged from the original — only this header comment differs
// (the original's long Yolna-module allowlist described Yolna's own
// internal usage discipline and does not apply to this copy).
//
// service role keyはPostgresのRLSを常にbypassする特権ロールであるため、
// Runs Core内でも利用箇所を最小限へ絞る規律は維持する(各呼び出し元が
// 明示的に`.eq("user_id", userId)`等のapplication-level filterを伴う、
// packages/runs-core/src/tact-execution/配下の各store.tsコメント参照)。

let cachedClient: SupabaseClient | null | undefined;

export function isServiceRoleConfigured(): boolean {

  return (
    typeof process.env.SUPABASE_SERVICE_ROLE_KEY === "string" &&
    process.env.SUPABASE_SERVICE_ROLE_KEY.length > 0
  );

}

// service role keyの生の文字列。core/tact-bot/execution/
// trustedConversationTurn.ts(Trusted Bot Execution Boundary)だけが
// 呼び出し、既存のcore/tact-conversation/store.tsの
// createRequestScopedClient(accessToken)へ、通常のuser access token
// の代わりにそのまま渡す(store.ts自体は変更しない、token-agnostic
// design)。それ以外のcode(core/tact-bot/connector/等)はこの関数を
// 直接呼ばない——生のkey文字列がtrustedConversationTurn.tsの外へ
// 出ないようにするため。
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
