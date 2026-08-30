-- =====================================================================
-- Migration: TACT Bot Identity Bridge & Conversation Link (BOT-P2)
-- =====================================================================
--
-- 背景 (BOT-P2投資調査):
--   core/tact-bot/(BOT-P1)は外部Channel(Slack/LINE等)からのメッセージを
--   platform非依存に正規化するChannel Gatewayとして完成しているが、
--   TACT Coreへは未接続だった。理由: 既存Canonical Conversation経路
--   (runConversationOrchestration())はSupabase RLS(auth.uid()=user_id、
--   20260825000000migration)を機能させるため実Supabase Auth JWTを要求
--   するが、外部Slack/LINE userにはそのJWTが存在しない。
--
--   BOT-P2はこれを、「外部Channel userを、server側で検証された
--   仕組みでTACT userへ解決する」Identity Bridgeと、「解決済みTACT
--   userとして、既存Conversation実行経路(狭いconnector関数内でのみ
--   service role keyを使う)を呼び出す」Conversation Connectorの2つで
--   解決する(詳細はcore/tact-bot/README.md、および
--   core/tact-bot/connector/conversationConnector.tsのコメント参照)。
--   このmigrationはそのための永続化層(2テーブル)のみを追加する。
--
-- 対象テーブル:
--   1. tact_external_identities   … 外部Channel user ⇄ TACT user
--   2. tact_bot_conversation_links … 外部Channel conversation/thread
--                                     ⇄ TACT conversation
--
-- Security方針(BOT-P2絶対条件、Repository調査で判明したtact_memory
-- (Stage 0、anonキーから全操作許可)とは意図的に異なる扱いとする):
--   この2テーブルはidentity解決・thread紐付けという、なりすまし
--   (他userのTACT accountへの不正な書き込み)に直結する機微データを
--   扱うため、Stage 0はもちろんStage 1(auth.uid()ベースの自己所有権
--   ポリシー)も採用しない——auth.uid()は「TACT側にログイン済みの
--   Supabaseセッション」を前提とするが、この2テーブルの主な書き込み
--   主体はBotのserver-side実行経路(外部Channel Webhook起点、Supabase
--   セッションを一切持たない)であるため、auth.uid()ベースのポリシーは
--   そもそも成立しない。
--
--   そのため、RLSは有効化した上でポリシーを一切定義しない
--   (「ポリシーが存在しない操作はデフォルトで拒否される」というRLSの
--   既定動作により、anon/authenticatedロールからの読み書きを完全に
--   遮断する)。この2テーブルへアクセスできるのはservice role
--   (Supabaseの設計上RLSを常にbypassする、Postgresの特権ロール)を
--   使うserver-side codeのみとなる。service role key自体は
--   core/tact-bot/配下の狭いmodule(core/database/supabaseServiceRole.ts
--   経由)以外には一切渡さない(BOT-P2絶対条件「service role keyを
--   無制限にCore全体へ渡さない」)。
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. tact_external_identities
-- ---------------------------------------------------------------------
--
-- provider + external_user_id + external_workspace_id の組み合わせで
-- 一意なTACT userを解決できるようにする(同じexternal_user_idでも
-- workspace/teamが異なれば別人でありうるため、Identity Bridge節の
-- 要求通りexternal_workspace_idも一意性の一部に含める)。
--
-- external_workspace_id はnullable(1:1のDM専用providerや、workspace
-- 概念を持たないproviderを将来追加する可能性を考慮)。PostgreSQLの
-- UNIQUE制約はNULLを「重複可能」として扱うため、そのままでは
-- external_workspace_id=NULLの行が複数作れてしまう
-- (provider+external_user_idが同じでも別行として許可されてしまう)。
-- これを避けるため、coalesce()を使った一意index(NULLを空文字として
-- 正規化してから一意性を判定する)を採用する。

create table if not exists public.tact_external_identities (

  id uuid not null primary key default gen_random_uuid(),

  tact_user_id uuid not null references auth.users (id) on delete cascade,

  provider text not null
    check (provider in ('slack', 'line', 'teams', 'discord')),

  external_user_id text not null
    check (char_length(external_user_id) between 1 and 255),

  external_workspace_id text null
    check (external_workspace_id is null or char_length(external_workspace_id) between 1 and 255),

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

-- Identity解決(provider + external_user_id + external_workspace_id →
-- tact_user_id)の一意性・主キー的な検索経路。
create unique index if not exists idx_tact_external_identities_lookup
  on public.tact_external_identities (
    provider,
    external_user_id,
    coalesce(external_workspace_id, '')
  );

-- 逆引き(あるTACT userにどの外部identityが紐付いているかの一覧表示等、
-- 将来のaccount linking画面向け)。
create index if not exists idx_tact_external_identities_tact_user_id
  on public.tact_external_identities (tact_user_id);

create or replace function public.set_tact_external_identities_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_external_identities_updated_at
  on public.tact_external_identities;

create trigger trg_tact_external_identities_updated_at
before update on public.tact_external_identities
for each row
execute function public.set_tact_external_identities_updated_at();

alter table public.tact_external_identities enable row level security;
-- 意図的にポリシーを1つも定義しない(コメント冒頭のSecurity方針参照)。
-- anon/authenticatedロールからの読み書きは常に拒否され、service role
-- (RLSを常にbypassする)のみがアクセスできる。


-- ---------------------------------------------------------------------
-- 2. tact_bot_conversation_links
-- ---------------------------------------------------------------------
--
-- 外部Channelのconversation/thread(例: Slack channel + thread_ts)と
-- TACT Conversationを紐付ける。1つの外部thread(channel +
-- external_conversation_id + external_thread_id)は高々1つのTACT
-- Conversationを指す(以後の同一threadでの発言・Clarification返信を
-- 同じTACT Conversationへ継続させるため)。
--
-- external_thread_id はnullable(DM等、thread概念を持たない会話では
-- conversation単位のみで一意)。tact_external_identitiesと同じ理由で
-- coalesce()を使った一意indexを採用する。

create table if not exists public.tact_bot_conversation_links (

  id uuid not null primary key default gen_random_uuid(),

  tact_conversation_id uuid not null
    references public.tact_conversations (id) on delete cascade,

  channel text not null
    check (channel in ('slack', 'line', 'teams', 'discord')),

  external_conversation_id text not null
    check (char_length(external_conversation_id) between 1 and 255),

  external_thread_id text null
    check (external_thread_id is null or char_length(external_thread_id) between 1 and 255),

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

create unique index if not exists idx_tact_bot_conversation_links_lookup
  on public.tact_bot_conversation_links (
    channel,
    external_conversation_id,
    coalesce(external_thread_id, '')
  );

create index if not exists idx_tact_bot_conversation_links_tact_conversation_id
  on public.tact_bot_conversation_links (tact_conversation_id);

create or replace function public.set_tact_bot_conversation_links_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_bot_conversation_links_updated_at
  on public.tact_bot_conversation_links;

create trigger trg_tact_bot_conversation_links_updated_at
before update on public.tact_bot_conversation_links
for each row
execute function public.set_tact_bot_conversation_links_updated_at();

alter table public.tact_bot_conversation_links enable row level security;
-- tact_external_identitiesと同じ理由で、意図的にポリシーを1つも
-- 定義しない(service role専用)。
