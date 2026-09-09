import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// =========================
// Supabase Service Role Client (BOT-P2 / BOT-P2.5)
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
//   - core/tact-bot/eventDedup/supabaseEventDedupStore.ts
//       (tact_bot_processed_events: 同上。S1a、Slack Events API等の
//       inbound event重複配信をatomic claimで防ぐためのdedup専用table)
//   - core/tact-bot/execution/trustedConversationTurn.ts
//       (Trusted Bot Execution Boundary、BOT-P2.5。既存
//       core/tact-conversation/store.tsの各関数へ、通常のuser access
//       tokenの代わりにservice role keyを渡す。store.ts側は
//       auth.uid()=user_id等のRLSに依存するStage1テーブル
//       (tact_conversations等)を対象とするため、RLSはbypassされるが、
//       store.tsの各関数は同時に明示的な`.eq("user_id", userId)`等の
//       application-level filterも行っている(store.ts冒頭コメント
//       参照)。呼び出し元(trustedConversationTurn.ts)が、外部Channel
//       userの主張ではなくidentity resolver(core/tact-bot/identity/)
//       がserver側で解決した正規のtact_user_idだけをこのuserIdとして
//       渡す限り、他userのConversationへは到達しない。
//       BOT-P2.5: この境界より外側(core/tact-bot/connector/
//       conversationConnector.ts含む)は、service role keyという値
//       そのものを一切扱わない——「Botがservice role JWTを使って
//       ユーザー本人として認証されたように見せる」構造を避けるため、
//       key読み出しをこの1関数だけに閉じ込める)。
//   - core/tact-bot/execution/trustedApprovalDecision.ts
//       (Architecture Migration Phase C2.1c-b/c、Approval decision
//       (approve/reject)専用のTrusted Bot Execution Boundary。
//       trustedConversationTurn.tsと同じ理由・同じ設計)。
//   - core/tact-bot/execution/resolvePendingApprovalForThread.ts
//       (Architecture Migration S1e、Slack thread → Conversation →
//       Work → pending Approvalの相関解決専用のTrusted Bot Execution
//       Boundary。tactUserIdはserver側で検証済みの値のみを受け取り、
//       外部Channel user idは一切使わない、trustedConversationTurn.ts
//       と同じ設計)。
//   - core/tact-runtime/execution.ts
//       (Fast Port P5c、Trusted Runtime Execution Boundary。
//       Trigger.dev task(TACT外の実行infrastructure)から呼ばれる
//       executeRuntimeIntegrationRead()専用。Trigger.dev payloadは
//       secretを一切含まないため、Supabase server-side credentialは
//       Trigger.dev自身のEnvironment Secret(このprocessのenv、
//       core/tact-bot/execution/配下と同じgetServiceRoleKey()経由)
//       からのみ解決する。tactUserIdはpayload(RuntimeExecutionRequest.
//       userId、外部からの主張ではなくTACT側がdispatch時に埋め込んだ
//       canonical値)を受け取るが、Work/Task/Run/actionのcorrelationを
//       必ず再検証してから使う(trustedConversationTurn.tsと同じ、
//       「値を受け取ったら即信用する」のではなく都度再検証する設計)。
//   - core/tact-runtime/reconcileOneShotIntegrationReadAsTrustedActor.ts
//       (P5d、Trusted Bot-Owned Run Compatibility Fix。Production
//       Slack Bot経由で解決されたTACT userが所有するambiguous Runを、
//       そのuserのaccess tokenをユーザーに取得・表示・転送させずに
//       reconcileするための、HTTP非公開のtrusted operator専用境界。
//       userIdはcaller入力を一切受け取らず、tact_works.user_id列を
//       このfile自身がservice role権限で直接読んで確定する
//       (trustedConversationTurn.tsが「identity resolverが検証済みの
//       tactUserId」を受け取るのと同じ精神を、identity resolverが
//       存在しないこの文脈向けに適用したもの)。
//   - core/brain/memory.ts・core/brain/history.ts
//       (TACT SEC-P0-3、Pre-Live Remediation。tact_memory・
//       tact_execution_historyは、supabase/migrations/
//       20260913000000_restrict_legacy_stage0_tables_to_service_role.sql
//       でclient側policyを全てdropし、service role以外は既定で
//       アクセス不可にした——tact_external_identities等と同じ
//       「policy 0件」pattern。これらのfile自身はper-request user
//       access tokenを持たない共有anon clientしか元々使っていなかった
//       ため(Stage 0設計、STEP131以前)、既存の挙動・既存の
//       application層user_id比較ロジックを一切変えずにservice role
//       clientへ差し替えるだけで、外部からの直接REST accessだけを
//       閉じる)。
//   - core/conversation/store.ts
//       (同上、conversations/conversation_messages/
//       conversation_workflow_runsが対象。既存のuser_id明示比較
//       ロジック(STEP145のownership check含む)は変更しない)。
//   - core/codeAgent/store.ts
//       (同上、tact_memory内のCodeTask行が対象。TACT SEC-P0-1で
//       CodeTaskへuser_id列を追加したため、この境界がowner-scoped
//       query(`.eq("user_id", userId)`)も併せて行う)。
//   - core/tact-agent/supabaseStore.ts
//       (同上、tact_memory内のDevelopmentTask/HandoffState行が対象)。
//   - core/tact-core/supabaseCoreCapability.ts
//       (同上、tact_core_knowledge/tact_core_memories/
//       tact_core_examplesが対象)。
//
// それ以外のCore module(core/tact-research・core/tact-orchestrator等)
// からは一切importしないこと。

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
