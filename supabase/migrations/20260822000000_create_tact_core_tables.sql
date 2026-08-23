-- =====================================================================
-- Migration: TACT Core (Knowledge / Memory / Example) 永続化
-- =====================================================================
--
-- 背景 (STEP175〜205):
--   core/tact-core/* が定義するCoreCapability(Knowledge/Memory/Example)は
--   STEP175以降、in-memoryのmockCoreCapability.ts(core/tact-core/
--   mockCoreCapability.ts)のみが実装として存在し、永続化されていな
--   かった(STEP203で確認)。
--
--   STEP204でDB構造を設計し(3テーブル完全分離案=案A)、STEP205で
--   TypeScript側にownerId(scopeに応じた所有者ID)を追加した。
--   このmigrationは、その設計をSQLとしてコード化するものである。
--
-- 重要(STEP206絶対条件): このmigrationは**作成のみ**であり、
--   Supabaseへの適用(`supabase db push` 等)は今回のSTEPでは行わない。
--   Repository実装・Persistent CoreCapability実装・Research Route
--   接続もこのSTEPの対象外(いずれも別STEPで扱う)。
--
-- STEP207修正: user_id FKのON DELETE挙動を`cascade`から`set null`へ
--   修正した。既存Repository内のauth.users参照FK(conversations・
--   tact_memory・tact_execution_history、旧public.users版を含め4件)
--   が例外なく`on delete set null`を採用しており(STEP207-A調査で
--   確認)、STEP206時点の`cascade`が唯一の逸脱だったため。この
--   既存パターンは「ユーザーが削除されてもレコード自体は残し、
--   所有者情報だけを外す」という一貫した設計判断(conversationsの
--   migrationコメント参照)であり、Core Knowledge/Memory/Exampleを
--   これと異なる扱いにする明確な根拠は既存コードに見当たらないため、
--   既存パターンへ合わせた。なお、conversation_idのON DELETE CASCADE
--   (conversation_messages等の子テーブル)とは別の関係性
--   (トップレベルEntityのuserへの任意リンク、vs 親Entityに完全に
--   従属する子行)であるため、この修正と矛盾しない。
--
-- 対象テーブル (STEP204案Aをそのまま採用、命名変更なし):
--   1. tact_core_knowledge  <-> KnowledgeItem (core/tact-core/knowledge/types.ts)
--   2. tact_core_memories   <-> CoreMemory    (core/tact-core/memory/types.ts)
--   3. tact_core_examples   <-> Example       (core/tact-core/knowledge/types.ts)
--
-- Legacyとの境界 (STEP204/206絶対条件):
--   tact_memory / tact_execution_history / conversations /
--   conversation_messages / conversation_workflow_runs は
--   一切変更しない。Legacy Brain Memory(tact_memory)は
--   Reviewer/Optimizerの自己改善データであり、ここで定義する
--   Core Memoryとは意図的に別概念・別テーブルとする
--   (core/tact-core/memory/types.tsのSTEP175コメント参照)。
--
-- 命名規則・記法は既存migration
--   (20260811120000_create_conversation_tables.sql、
--    20260821000000_create_brain_memory_tables.sql)
--   の慣例をそのまま踏襲する(独自流儀を導入しない、STEP206絶対条件)。
--   pgcrypto拡張は20260811120000で既に有効化済みのため、
--   20260821000000と同様、このmigrationでは再宣言しない。
--
-- Organization / Project について (STEP204/206で確認済み・重要):
--   Repository内にはOrganization/Projectの永続テーブルが存在しない
--   (organizations/projects/organization_members/project_members、
--   いずれも存在しない)。そのため organization_id / project_id は
--   **FK制約を持たない素のuuid列**として用意するに留める。将来
--   参照先テーブルが作られた時点で、別migrationとしてFK制約を
--   追加できる形にしてある(列自体は変更不要)。あるuserIdが
--   どのorganizationId/projectIdに属するかを判定する仕組みも
--   現時点では存在しないため、このmigrationはその所属関係を
--   一切仮定しない(RLSポリシーも参照)。
--
-- owner/scope整合性 (STEP205のownerId設計をDB制約として表現):
--   core/tact-core/knowledge/types.ts・memory/types.tsのownerIdは
--   scopeの値に応じて意味が変わる単一フィールドだった(TypeScript側)。
--   DBでは同じ意味論を、4つのnullable列(user_id/organization_id/
--   project_id/conversation_id)のうち、scopeに対応する1列だけが
--   非nullであることを強制するCHECK制約として表現する
--   (STEP204で検討し、STEP206-Fで指示された設計をそのまま採用)。
--
-- Evidence / Embeddingについて:
--   Research EvidenceをそのままKnowledgeとして保存する仕組み、
--   Evidence専用テーブル(tact_core_evidence等)、
--   source_evidence_id / source_execution_id列、
--   Embedding/Vector Search(pgvector拡張・embedding列・vector index)
--   は、いずれも今回のmigrationに一切含めない
--   (STEP206絶対条件J・K)。ただし、embedding列を将来additiveに
--   追加してもこのテーブル構造・既存クエリを破壊しないため、
--   Phase 2(Embedding導入)を阻害しない設計になっている
--   (STEP204-Fで確認済みの方針)。
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. tact_core_knowledge
-- ---------------------------------------------------------------------
--
-- core/tact-core/knowledge/types.ts の KnowledgeItem
-- (KnowledgeBase: id/scope/ownerId/source/tags/createdAt を継承)
-- にほぼ1:1で対応する。

create table if not exists public.tact_core_knowledge (

  id uuid not null primary key default gen_random_uuid(),

  -- owner/scope (STEP205 ownerId の意味論をDB上の4列として表現。
  -- scopeに対応する1列だけが非nullであることを下部のCHECK制約で強制する)。
  user_id uuid null references auth.users (id) on delete set null,

  -- Organization/Projectの永続テーブルが存在しないため、FK制約は
  -- 付与しない(将来テーブルが作られた時点で別migrationとして追加)。
  organization_id uuid null,

  project_id uuid null,

  conversation_id uuid null
    references public.conversations (id) on delete set null,

  scope text not null
    check (scope in ('user', 'organization', 'project', 'conversation')),

  kind text not null
    check (kind in ('document', 'example', 'evidence', 'reference', 'artifact')),

  title text not null,

  description text null,

  content text not null,

  -- KnowledgeBase.sourceはTypeScript側で必須(optionalではない)ため、
  -- DB側もnot nullとする(STEP206絶対条件: 既存型契約をこの都合で
  -- optional化しない、の裏返しとして、必須のものは必須のまま)。
  source text not null,

  reference text null,

  tags text[] not null default '{}',

  metadata jsonb null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint tact_core_knowledge_scope_owner_check check (
    -- STEP207: user_id/conversation_idはON DELETE SET NULLの対象
    -- (auth.users/public.conversations削除時にnullへ変わりうる)ため、
    -- 「scope='user'ならuser_idが必ず非null」という強い制約にすると、
    -- 所有者削除時にCHECK制約違反でDELETEそのものが失敗してしまう。
    -- そのためuser/conversationの枝は「他の3列が全てnullであること」
    -- のみを要求し(scope混同の防止という制約本来の目的は維持する)、
    -- 対応するowner列自体の非null要求は外した(所有者削除後は
    -- user_id/conversation_id=nullのままデータ自体は残る、という
    -- 既存Legacy migration・conversations/tact_memoryと同じ挙動を許容
    -- するため)。organization/projectはON DELETEで自動的にnullへ
    -- 変わる経路が存在しない(FK自体が無い)ため、従来通り非null要求を
    -- 維持する。
    (scope = 'user'         and organization_id is null and project_id is null and conversation_id is null) or
    (scope = 'organization' and organization_id is not null and user_id is null and project_id is null and conversation_id is null) or
    (scope = 'project'      and project_id is not null and user_id is null and organization_id is null and conversation_id is null) or
    (scope = 'conversation' and user_id is null and organization_id is null and project_id is null)
  )

);

create index if not exists idx_tact_core_knowledge_user_id
  on public.tact_core_knowledge (user_id);

create index if not exists idx_tact_core_knowledge_conversation_id
  on public.tact_core_knowledge (conversation_id);

create index if not exists idx_tact_core_knowledge_scope
  on public.tact_core_knowledge (scope);

create index if not exists idx_tact_core_knowledge_created_at
  on public.tact_core_knowledge (created_at desc);

create index if not exists idx_tact_core_knowledge_tags
  on public.tact_core_knowledge using gin (tags);


-- ---------------------------------------------------------------------
-- 2. tact_core_memories
-- ---------------------------------------------------------------------
--
-- core/tact-core/memory/types.ts の CoreMemory に対応する。
-- Legacy Brain Memory(tact_memory)とは名前空間・概念とも完全に分離する
-- (tact_memoryは一切変更しない)。

create table if not exists public.tact_core_memories (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid null references auth.users (id) on delete set null,

  organization_id uuid null,

  project_id uuid null,

  conversation_id uuid null
    references public.conversations (id) on delete set null,

  scope text not null
    check (scope in ('user', 'organization', 'project', 'conversation')),

  type text not null
    check (type in (
      'preference', 'rule', 'successful_approach', 'context',
      'working_preference', 'other'
    )),

  content text not null,

  importance smallint not null
    check (importance between 1 and 10),

  confidence text not null
    check (confidence in ('low', 'medium', 'high')),

  -- CoreMemory.sourceはTypeScript側でoptionalのため、DB側もnullableとする。
  source text null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint tact_core_memories_scope_owner_check check (
    -- STEP207: user_id/conversation_idはON DELETE SET NULLの対象
    -- (auth.users/public.conversations削除時にnullへ変わりうる)ため、
    -- 「scope='user'ならuser_idが必ず非null」という強い制約にすると、
    -- 所有者削除時にCHECK制約違反でDELETEそのものが失敗してしまう。
    -- そのためuser/conversationの枝は「他の3列が全てnullであること」
    -- のみを要求し(scope混同の防止という制約本来の目的は維持する)、
    -- 対応するowner列自体の非null要求は外した(所有者削除後は
    -- user_id/conversation_id=nullのままデータ自体は残る、という
    -- 既存Legacy migration・conversations/tact_memoryと同じ挙動を許容
    -- するため)。organization/projectはON DELETEで自動的にnullへ
    -- 変わる経路が存在しない(FK自体が無い)ため、従来通り非null要求を
    -- 維持する。
    (scope = 'user'         and organization_id is null and project_id is null and conversation_id is null) or
    (scope = 'organization' and organization_id is not null and user_id is null and project_id is null and conversation_id is null) or
    (scope = 'project'      and project_id is not null and user_id is null and organization_id is null and conversation_id is null) or
    (scope = 'conversation' and user_id is null and organization_id is null and project_id is null)
  )

);

create index if not exists idx_tact_core_memories_user_id
  on public.tact_core_memories (user_id);

create index if not exists idx_tact_core_memories_scope
  on public.tact_core_memories (scope);

create index if not exists idx_tact_core_memories_type
  on public.tact_core_memories (type);

create index if not exists idx_tact_core_memories_created_at
  on public.tact_core_memories (created_at desc);


-- ---------------------------------------------------------------------
-- 3. tact_core_examples
-- ---------------------------------------------------------------------
--
-- core/tact-core/knowledge/types.ts の Example
-- (KnowledgeBaseを継承。KnowledgeItemと違いupdated_atを持たない)
-- に対応する。
--
-- 重要: ExampleのTypeScript型にupdatedAtが存在しないため
-- (STEP204で発見、STEP205でも意図的に維持した非対称性)、
-- このテーブルにもupdated_at列を追加しない。

create table if not exists public.tact_core_examples (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid null references auth.users (id) on delete set null,

  organization_id uuid null,

  project_id uuid null,

  conversation_id uuid null
    references public.conversations (id) on delete set null,

  scope text not null
    check (scope in ('user', 'organization', 'project', 'conversation')),

  source text not null,

  tags text[] not null default '{}',

  title text not null,

  description text null,

  -- 参照先(将来のDesign Document Model等)が現時点で未定義のため、
  -- FK制約は付与しない(core/tact-core/knowledge/types.tsの
  -- Example.artifactIdコメント参照)。
  artifact_id uuid null,

  importance smallint not null
    check (importance between 1 and 10),

  reason text null,

  category text null,

  created_at timestamptz not null default now(),

  constraint tact_core_examples_scope_owner_check check (
    -- STEP207: user_id/conversation_idはON DELETE SET NULLの対象
    -- (auth.users/public.conversations削除時にnullへ変わりうる)ため、
    -- 「scope='user'ならuser_idが必ず非null」という強い制約にすると、
    -- 所有者削除時にCHECK制約違反でDELETEそのものが失敗してしまう。
    -- そのためuser/conversationの枝は「他の3列が全てnullであること」
    -- のみを要求し(scope混同の防止という制約本来の目的は維持する)、
    -- 対応するowner列自体の非null要求は外した(所有者削除後は
    -- user_id/conversation_id=nullのままデータ自体は残る、という
    -- 既存Legacy migration・conversations/tact_memoryと同じ挙動を許容
    -- するため)。organization/projectはON DELETEで自動的にnullへ
    -- 変わる経路が存在しない(FK自体が無い)ため、従来通り非null要求を
    -- 維持する。
    (scope = 'user'         and organization_id is null and project_id is null and conversation_id is null) or
    (scope = 'organization' and organization_id is not null and user_id is null and project_id is null and conversation_id is null) or
    (scope = 'project'      and project_id is not null and user_id is null and organization_id is null and conversation_id is null) or
    (scope = 'conversation' and user_id is null and organization_id is null and project_id is null)
  )

);

create index if not exists idx_tact_core_examples_user_id
  on public.tact_core_examples (user_id);

create index if not exists idx_tact_core_examples_scope
  on public.tact_core_examples (scope);

create index if not exists idx_tact_core_examples_tags
  on public.tact_core_examples using gin (tags);


-- ---------------------------------------------------------------------
-- 4. Row Level Security (RLS) — Stage 0のみ
-- ---------------------------------------------------------------------
--
-- 既存migration(20260811120000のconversations系、20260821000000の
-- tact_memory/tact_execution_history)と同じ「Stage 0」方針を踏襲する:
-- RLSは有効化した上で、anonキーからの操作を許可する許可的ポリシーを
-- 明示的に敷く(RLSを無効化するのではない)。
--
-- CRUD範囲の判断根拠: tact_core_*はLegacyの2系統のうち、より近い
-- 前例であるtact_memory/tact_execution_history(20260821000000)の
-- 範囲(select/insert/updateのみ、deleteポリシーなし)を踏襲する
-- (conversations系のようなdeleteポリシーは付与しない)。
-- tact_core_examplesのみ、TypeScript型にupdatedAtが存在しない
-- (=更新という操作自体が型契約上想定されていない)ことに合わせ、
-- updateポリシーも付与しない(select/insertのみ)。
--
-- 本格運用(Stage 1、auth.uid()ベースの所有者チェック)への移行は
-- 今回のスコープ外。特にorganization_id/project_idに基づくアクセス
-- 制御(「あるauth.uid()がこのorganization_idに属するか」等)は、
-- 所属関係を判定する仕組み自体が現時点でRepository内に存在しない
-- ため、推測でpolicyを実装しない(STEP206絶対条件、STEP206-I)。
-- この点は未確定事項として最終報告に明記する。

alter table public.tact_core_knowledge enable row level security;
alter table public.tact_core_memories enable row level security;
alter table public.tact_core_examples enable row level security;

-- tact_core_knowledge ---------------------------------------------------

drop policy if exists "tact_core_knowledge_select_anon_stage0" on public.tact_core_knowledge;
create policy "tact_core_knowledge_select_anon_stage0"
  on public.tact_core_knowledge for select using (true);

drop policy if exists "tact_core_knowledge_insert_anon_stage0" on public.tact_core_knowledge;
create policy "tact_core_knowledge_insert_anon_stage0"
  on public.tact_core_knowledge for insert with check (true);

drop policy if exists "tact_core_knowledge_update_anon_stage0" on public.tact_core_knowledge;
create policy "tact_core_knowledge_update_anon_stage0"
  on public.tact_core_knowledge for update using (true) with check (true);

-- tact_core_memories ------------------------------------------------------

drop policy if exists "tact_core_memories_select_anon_stage0" on public.tact_core_memories;
create policy "tact_core_memories_select_anon_stage0"
  on public.tact_core_memories for select using (true);

drop policy if exists "tact_core_memories_insert_anon_stage0" on public.tact_core_memories;
create policy "tact_core_memories_insert_anon_stage0"
  on public.tact_core_memories for insert with check (true);

drop policy if exists "tact_core_memories_update_anon_stage0" on public.tact_core_memories;
create policy "tact_core_memories_update_anon_stage0"
  on public.tact_core_memories for update using (true) with check (true);

-- tact_core_examples --------------------------------------------------

drop policy if exists "tact_core_examples_select_anon_stage0" on public.tact_core_examples;
create policy "tact_core_examples_select_anon_stage0"
  on public.tact_core_examples for select using (true);

drop policy if exists "tact_core_examples_insert_anon_stage0" on public.tact_core_examples;
create policy "tact_core_examples_insert_anon_stage0"
  on public.tact_core_examples for insert with check (true);
