-- =====================================================================
-- Migration: Canonical Connection Foundation (Architecture Migration
-- Phase C1 — Integration Gateway Foundation + Composio Adapter)
-- =====================================================================
--
-- 背景(Phase C0 Architecture Decision): TACTはWork/Task/Run/Approval/
-- Integration Gateway/Canonical Connection referenceを所有し、SaaS
-- OAuth・credential storage・token refresh・SaaS API差分・Tool
-- execution等は外部Provider(Phase C1ではComposio)へ委託する。
--
-- このmigrationは、TACT側が持つべき最小限のlogical Connection
-- reference(「どのTACT userが、どのexternal serviceへ、どのProvider
-- 経由で接続しているか」)だけを追加する。
--
--   TACT user → tact_connections(論理参照) → provider adapter →
--   Composio connected account → Slack
--
-- 絶対条件(Phase C1指示Section8): token/access token/refresh token/
-- OAuth secretはこのテーブルへ一切保存しない。Composio側が
-- credential本体を保持し、TACT側はComposio connected accountへの
-- 参照(provider_connection_ref)だけを持つ。
--
-- 絶対条件(Phase C1指示Section7): Composio固有の識別子
-- (composioUserId・composioToolSlug等)をWork/Task/Approvalの
-- canonical typeへ持ち込まない。Provider固有詳細はこのテーブル
-- (Integration infrastructure領域)とmetadata jsonbへ隔離する。
--
-- 対象テーブル(新設): tact_connections
--
-- 既存テーブルへの変更: なし。

create table if not exists public.tact_connections (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid not null references auth.users (id) on delete cascade,

  -- Canonical service識別子(Provider非依存)。Phase C1はSlackのみ。
  -- 将来のservice追加時はこのCHECK制約へ値を足すだけでよい
  -- (既存repositoryの「無制限textにしない」CHECK制約方針を踏襲)。
  service text not null
    check (service in ('slack')),

  -- Canonical status(Provider固有の詳細ステータスはmetadata jsonbへ、
  -- ここでは「実行に使ってよいか」を判断できる粗い粒度のみ持つ)。
  status text not null default 'pending'
    check (status in ('pending', 'active', 'failed', 'revoked')),

  -- どのIntegration Providerがこの接続を実装しているか。Phase C1は
  -- Composioのみだが、将来MCP/Pipedream/Merge/Native等が追加された
  -- 場合もこの1列で表現できる。
  provider text not null
    check (provider in ('composio')),

  -- Provider側の接続参照(例: Composio connected account id)。
  -- credential/token本体ではなく、あくまで「どの接続を指すか」の
  -- 参照文字列。
  provider_connection_ref text not null
    check (char_length(provider_connection_ref) between 1 and 255),

  -- Provider固有の非機密メタデータ(例: Composio側の詳細status・
  -- toolkit slug等)。絶対条件: token/secret/credentialは入れない
  -- (アプリケーション層の責務、DB制約では強制できないため
  -- core/tact-integration/側のtype/testで担保する)。
  metadata jsonb null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

-- 同一user・同一serviceの重複active接続を無制限に増やさないための
-- 参照用index(一意制約ではなく検索用。allowMultiple相当の運用は
-- 将来検討、Phase C1では作らない)。
create index if not exists idx_tact_connections_user_id_service
  on public.tact_connections (user_id, service);

create or replace function public.set_tact_connections_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_connections_updated_at on public.tact_connections;

create trigger trg_tact_connections_updated_at
before update on public.tact_connections
for each row
execute function public.set_tact_connections_updated_at();


-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
--
-- tact_works/tact_artifacts等と同じStage1 ownershipパターン
-- (auth.uid() = user_id)。Connectionはuserが作成・確認・無効化できる
-- 継続的なリソースのため、select/insert/update/deleteの4操作全てに
-- policyを持つ(tact_worksと同じ扱い)。

alter table public.tact_connections enable row level security;

drop policy if exists "tact_connections_select_own" on public.tact_connections;
create policy "tact_connections_select_own"
  on public.tact_connections for select
  using (auth.uid() = user_id);

drop policy if exists "tact_connections_insert_own" on public.tact_connections;
create policy "tact_connections_insert_own"
  on public.tact_connections for insert
  with check (auth.uid() = user_id);

drop policy if exists "tact_connections_update_own" on public.tact_connections;
create policy "tact_connections_update_own"
  on public.tact_connections for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "tact_connections_delete_own" on public.tact_connections;
create policy "tact_connections_delete_own"
  on public.tact_connections for delete
  using (auth.uid() = user_id);
