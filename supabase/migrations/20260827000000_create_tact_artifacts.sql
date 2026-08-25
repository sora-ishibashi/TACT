-- =====================================================================
-- Migration: Create tact_artifacts (Phase 75)
-- =====================================================================
--
-- 目的(Phase75 Section5/12): Conversationとは別の永続的な成果物
-- (Artifact)を保持する。Phase73 Investigationで確認済みの通り、
-- 既存のtact_core_knowledge(個別の知識断片)・components/design/*の
-- DocumentModel(Legacy、slide/position基準でTACT Researchの
-- 「成長する調査文書」とは概念が一致しない)のいずれも転用に適さない
-- ため、最小限の新規テーブルを追加する。
--
-- Phase75 Section5の絶対条件通り、sections(evidence/examples/tables/
-- charts個別の構造化カラム)はこの時点でschema確定しない。contentを
-- 単一のmarkdown text(見出し付きで自然に成長させる、Section7の
-- Good例と同じ形)として持ち、構造化ブロックの永続化はPhase76以降へ
-- 明示的にDeferredする(推測でJSON schemaを先回りしない、絶対条件)。
--
-- Project = Folder(Phase74)との関係(Section11): Artifactは
-- ProjectへNullable FKを持つ(Project未選択のConversationでも
-- Artifactを持てるようにするため)。Conversation ↔ Artifactの関係は
-- tact_conversations.artifact_id(このmigrationで追加)で表現する
-- ——Phase74のtact_conversations.project_id追加と全く同じ安全な
-- パターン(nullable、ON DELETE SET NULL)。

create table if not exists public.tact_artifacts (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid not null references auth.users (id) on delete cascade,

  project_id uuid null references public.projects (id) on delete set null,

  title text not null,

  -- 成長するmarkdown文書。「既存内容を壊さない」(Section9)ため、
  -- 更新は基本的にこのフィールドへの追記(アプリケーション層の責務、
  -- store.ts参照)。
  content text not null default '',

  -- 更新のたびに+1する(将来のhistory/diff表示の土台、今回は
  -- version番号の保持のみでUIには使わない、speculative機能は作らない)。
  version integer not null default 1,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

create index if not exists idx_tact_artifacts_user_id
  on public.tact_artifacts (user_id);

create index if not exists idx_tact_artifacts_project_id
  on public.tact_artifacts (project_id);


-- ---------------------------------------------------------------------
-- tact_conversations.artifact_id
-- ---------------------------------------------------------------------
--
-- nullable(既存Conversationは全てartifact_id=NULLのまま成立する、
-- 絶対条件: 既存データを破壊しない)。ON DELETE SET NULLとし、
-- Artifact削除がConversationを巻き込まないようにする
-- (Phase74のproject_id追加と同じ判断)。

alter table public.tact_conversations
  add column if not exists artifact_id uuid null
    references public.tact_artifacts (id) on delete set null;

create index if not exists idx_tact_conversations_artifact_id
  on public.tact_conversations (artifact_id);


-- ---------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------
--
-- tact_conversationsと同じ既存方針(Phase64以来、DB triggerは追加せず
-- アプリケーション層で明示的に更新する)を踏襲し、triggerは追加しない。


-- ---------------------------------------------------------------------
-- Row Level Security (RLS)
-- ---------------------------------------------------------------------
--
-- tact_conversations/projectsと同じStage 1方針(auth.uid() = user_id)。
-- ArtifactはMessageと異なり継続的に更新されるリソースのため、
-- update policyを持つ(tact_conversation_messagesの意図的な
-- append-onlyとは違う設計、Section8「成長するArtifact」の要件に
-- 対応するため)。

alter table public.tact_artifacts enable row level security;

drop policy if exists "tact_artifacts_select_own" on public.tact_artifacts;
create policy "tact_artifacts_select_own"
  on public.tact_artifacts for select
  using (auth.uid() = user_id);

drop policy if exists "tact_artifacts_insert_own" on public.tact_artifacts;
create policy "tact_artifacts_insert_own"
  on public.tact_artifacts for insert
  with check (auth.uid() = user_id);

drop policy if exists "tact_artifacts_update_own" on public.tact_artifacts;
create policy "tact_artifacts_update_own"
  on public.tact_artifacts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "tact_artifacts_delete_own" on public.tact_artifacts;
create policy "tact_artifacts_delete_own"
  on public.tact_artifacts for delete
  using (auth.uid() = user_id);

-- tact_conversationsのRLSは変更しない(artifact_id列の追加のみ)。
