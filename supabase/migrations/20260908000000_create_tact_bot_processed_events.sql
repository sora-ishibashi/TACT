-- =====================================================================
-- Migration: TACT Bot Inbound Event Dedup (S1a)
-- =====================================================================
--
-- 背景 (S1a — Slack Interface Inbound Foundation):
--   Slack Events API等のwebhook配信は、ネットワーク遅延・タイムアウト等
--   により同一eventが複数回配信される可能性がある(「たぶん1回しか
--   送らない」という前提は使えない)。同一eventによってTACT Research/
--   Conversation/Workが二重実行されることを防ぐため、
--   provider(channel) + external event id の組み合わせをatomicに
--   claimできる最小限のtableを追加する。
--
--   provider-neutralな設計とする(Slack専用table名にしない)——将来
--   LINE/Teams等の他Channel Adapterを追加した場合も同じtableを
--   再利用できる想定(BOT-P2のtact_external_identities/
--   tact_bot_conversation_linksと同じ「channelというdiscriminator列で
--   複数providerを共存させる」既存パターンを踏襲)。
--
-- 保存するのはevent identityだけ(絶対条件): raw Slack payload・
-- user message本文・Bot token・Signing Secret・OAuth credential等は
-- 一切保存しない。
--
-- Security方針(既存BOT-P2 identity/link tableと同じ理由): この
-- tableもRLSポリシーを1つも定義しない。書き込み/読み込みの主体は
-- 外部Channel webhookを受けるBotのserver-side実行経路(Supabase
-- セッションを持たない)であり、auth.uid()ベースのポリシーは
-- そもそも成立しないため。service role(RLSを常にbypassする)のみが
-- アクセスできる。
--
-- =====================================================================

create table if not exists public.tact_bot_processed_events (

  id uuid not null primary key default gen_random_uuid(),

  channel text not null
    check (channel in ('slack', 'line', 'teams', 'discord')),

  external_event_id text not null
    check (char_length(external_event_id) between 1 and 255),

  created_at timestamptz not null default now()

);

-- atomic claim(絶対条件Section16): この一意indexへのINSERTが
-- 同時実行された場合、片方だけが成功し、もう片方はunique_violation
-- (Postgresエラーコード23505)を受け取る。「SELECTして無ければ
-- INSERT」という2段の非atomicな方式は使わない。
create unique index if not exists idx_tact_bot_processed_events_lookup
  on public.tact_bot_processed_events (channel, external_event_id);

alter table public.tact_bot_processed_events enable row level security;
-- 意図的にポリシーを1つも定義しない(コメント冒頭のSecurity方針参照)。
-- anon/authenticatedロールからの読み書きは常に拒否され、service role
-- のみがアクセスできる。
