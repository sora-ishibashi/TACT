-- =====================================================================
-- Migration: Create projects table (Phase 30)
-- =====================================================================
--
-- 目的(Phase29調査結果に基づく):
--   TACTに初めて実体としてのProjectを導入する。今回のスコープは
--   DB基盤のみ(絶対条件1)。Project API・UI・File・Project Context・
--   Orchestrator接続・Learning/Reflectionはこのmigrationの対象外。
--
-- 構造:
--   User(auth.users、既存)
--     └─ Project(このmigrationで新設)
--          └─ Conversation(既存conversationsテーブルへproject_id列を追加)
--
--   Organizationは新設しない(Phase29調査: 現時点で利用者・所属関係を
--   判定する仕組みが存在しないため、絶対条件9・絶対条件10により
--   先回りしない)。
--
-- 重要:
--   - 既存の conversations / conversation_messages /
--     conversation_workflow_runs / tact_memory / tact_execution_history /
--     tact_core_knowledge / tact_core_memories / tact_core_examples の
--     いずれにも変更を加えない(conversations.project_id列の追加のみ、
--     既存列・既存データは一切変更しない)。
--   - 既存Conversationはすべてproject_id = NULLのまま(絶対条件14:
--     既存データを破壊するmigrationを作らない)。
--   - このmigration適用後も、既存コードがProjectを自動利用するような
--     変更は一切行わない(絶対条件19)。projectsテーブルが存在する
--     だけで、参照するコードはまだ存在しない。
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. projects
-- ---------------------------------------------------------------------
--
-- 最小限のProject Entity。現時点ではUser直下のみ(Organization無し)。
-- name以外の付加情報(description・color・archived等)は、ChatGPT/
-- Claude型UXの調査(Phase29)でも「最小限のconceptで成立させる」方針を
-- 踏襲し、今回は追加しない(絶対条件16: Phase31以降を先回りしない)。

create table if not exists public.projects (

  id uuid not null primary key default gen_random_uuid(),

  -- conversations.user_id(20260820000000migration適用後)と同じく
  -- auth.usersを直接参照する。Projectは常に単一Userの所有物として
  -- 扱う(Organization無し、Phase29調査結果)。
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

create index if not exists idx_projects_user_id
  on public.projects (user_id);


-- ---------------------------------------------------------------------
-- 2. conversations.project_id
-- ---------------------------------------------------------------------
--
-- nullable column(絶対条件: 既存Conversationはすべてproject_id=NULLの
-- ままで成立する)。ON DELETE SET NULLとし、Project削除時に既存
-- Conversationを巻き込んで削除しない(指示書の通り、Project削除に
-- Conversation連鎖削除が必要という根拠はPhase29のReality Testでは
-- 確認されていないため、最も安全な選択肢を採用する)。

alter table public.conversations
  add column if not exists project_id uuid null
    references public.projects (id) on delete set null;

create index if not exists idx_conversations_project_id
  on public.conversations (project_id);


-- ---------------------------------------------------------------------
-- 3. updated_at自動更新
-- ---------------------------------------------------------------------
--
-- 既存3テーブル(conversations等)には同種のtriggerが無く、
-- updated_atはアプリケーション層で明示的に更新する既存方針
-- (STEP4設計、conversationsのコメント「Turn終了時の楽観的ロックにも
-- 利用する」参照)。この既存方針をprojectsでも踏襲し、DB triggerは
-- 追加しない(絶対条件15: 新しい依存関係・仕組みを増やさない)。


-- ---------------------------------------------------------------------
-- 4. Row Level Security (RLS)
-- ---------------------------------------------------------------------
--
-- projectsは既存テーブル群のStage 0方針(anonキーからの全操作許可、
-- アプリケーション層のWHERE句のみで絞り込み)とは異なり、Stage 1
-- (auth.uid()ベースの所有者チェック)を採用する。
--
-- 既存のtact_core_*/tact_memory等がStage 0に留まっている理由
-- (20260822000000migrationのコメント参照)は、「organization_id/
-- project_idに基づくアクセス制御は、所属関係を判定する仕組みが
-- 存在しないため実装できない」というものだった。projectsテーブル
-- 自体は所有者がuser_id 1列で直接表現される(所属関係の判定を
-- 必要としない)ため、この既存の障害がそのまま当てはまらない。
-- auth.uid() = user_id という直接比較だけで、指示書の要求
-- (自分のProjectのみ参照/作成/更新/削除できる)を推測なしに実装できる。

alter table public.projects enable row level security;

drop policy if exists "projects_select_own" on public.projects;
create policy "projects_select_own"
  on public.projects for select
  using (auth.uid() = user_id);

drop policy if exists "projects_insert_own" on public.projects;
create policy "projects_insert_own"
  on public.projects for insert
  with check (auth.uid() = user_id);

drop policy if exists "projects_update_own" on public.projects;
create policy "projects_update_own"
  on public.projects for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "projects_delete_own" on public.projects;
create policy "projects_delete_own"
  on public.projects for delete
  using (auth.uid() = user_id);

-- conversationsのRLSは今回変更しない(絶対条件: 既存Conversationの
-- アクセス制御を壊さない)。project_id列の追加のみ。
