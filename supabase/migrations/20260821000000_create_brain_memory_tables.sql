-- =====================================================================
-- Migration: TACT Brain Memory / Execution History永続化
-- =====================================================================
--
-- 背景:
--   core/brain/memory.ts(brainMemory)・core/brain/history.ts
--   (executionHistory)は、これまでモジュールレベルのプロセス内配列
--   (let ... = [])として実装されており、サーバー再起動・デプロイの
--   たびに内容が消えていた。「TACT最速実装モード」の指示に基づき、
--   既存のSupabase接続(core/database/supabase.ts)・既存の認証基盤
--   (STEP131〜138、auth.users.id)をそのまま再利用し、最小限の
--   スキーマで永続化する。
--
-- 対象テーブル:
--   1. tact_execution_history : ExecutionRecord(core/context/types.ts)
--      の永続化。Brainのパターン分析(core/brain/pattern.ts)が読む。
--   2. tact_memory            : 優先順位付きMemory本体。
--      Reviewerの改善指摘・Optimizerの提案・将来的な
--      ImprovementProposal等を保持する。
--
-- 設計方針:
--   - user_id / conversation_id はどちらもnullable(未認証Workflow・
--     Conversation層を経由しない呼び出しでも動作を継続するため。
--     STEP131のuserId導入時と同じ「未認証でも通す」方針を踏襲)。
--   - user_idはauth.users(id)を直接参照する(STEP133〜138で確立した
--     「public.usersを経由しない」設計をそのまま踏襲)。
--   - RLSはStage 0(既存のconversationsテーブルと同じ、anonキーからの
--     全操作を許可する暫定ポリシー)。本格的なRLS導入は今回のスコープ外。
--   - 新しいDB接続・新しいクライアントライブラリは追加しない
--     (既存のcore/database/supabase.tsをそのまま使う)。
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. tact_execution_history
-- ---------------------------------------------------------------------
--
-- core/context/types.ts の ExecutionRecord とほぼ1:1に対応する。
-- 個別のAgent出力(outputs)まで含めて保持すると肥大化するため、
-- outputsはJSONBでそのまま保持しつつ、Brainのパターン分析
-- (agents / quality.score / success)に必要な値は個別カラムにも
-- 複製し、集計クエリを軽くする。

create table if not exists public.tact_execution_history (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid null references auth.users (id) on delete set null,

  conversation_id uuid null
    references public.conversations (id) on delete set null,

  user_input text not null,

  mode text not null default 'think'
    check (mode in ('quick', 'think', 'deep')),

  -- 実行されたAgent一覧(パターン分析のキーとして使う)。
  agents text[] not null default '{}',

  quality_score integer null,

  success boolean not null default true,

  failed_agents text[] not null default '{}',

  duration_ms integer null,

  evidence_mode text null,

  quality_profile text null,

  -- ExecutionRecord全体(outputs等を含む)をそのまま保持する。
  -- 個別Agent出力Schemaへの依存は持たない。
  record jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()

);

create index if not exists idx_tact_execution_history_created_at
  on public.tact_execution_history (created_at desc);

create index if not exists idx_tact_execution_history_user_id
  on public.tact_execution_history (user_id);


-- ---------------------------------------------------------------------
-- 2. tact_memory
-- ---------------------------------------------------------------------
--
-- 「最速実装モード」指示のフィールド構成をそのまま採用する。
-- contentはJSONBとし、単純な文字列(rule/reason程度)から、将来の
-- 構造化されたImprovementProposal(Problem/Cause/Evidence/Affected/
-- Suggestion/ExpectedEffect/Confidence)まで、型を固定せず保持できる
-- ようにする(DBスキーマを都度変更しなくて済むようにするため)。

create table if not exists public.tact_memory (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid null references auth.users (id) on delete set null,

  conversation_id uuid null
    references public.conversations (id) on delete set null,

  type text not null check (type in (
    'fact', 'task', 'preference', 'role', 'decision', 'feedback',
    'failure', 'success_pattern', 'instruction', 'improvement_proposal'
  )),

  -- 改善対象Agent(該当する場合のみ)。nullは「全Agent共通」を意味する
  -- (core/brain/types.tsのBrainRule.targetAgentと同じ意味)。
  target_agent text null,

  content jsonb not null,

  -- 1(低)〜10(高)の単純な整数スケール。
  importance smallint not null default 5
    check (importance between 1 and 10),

  confidence text not null default 'medium'
    check (confidence in ('low', 'medium', 'high')),

  reuse_count integer not null default 0,

  source text null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

create index if not exists idx_tact_memory_user_id
  on public.tact_memory (user_id);

create index if not exists idx_tact_memory_type
  on public.tact_memory (type);

create index if not exists idx_tact_memory_target_agent
  on public.tact_memory (target_agent);


-- ---------------------------------------------------------------------
-- 3. RLS (Stage 0、既存conversationsテーブルと同じ暫定ポリシー)
-- ---------------------------------------------------------------------

alter table public.tact_execution_history enable row level security;
alter table public.tact_memory enable row level security;

drop policy if exists "tact_execution_history_select_anon_stage0" on public.tact_execution_history;
create policy "tact_execution_history_select_anon_stage0"
  on public.tact_execution_history for select using (true);

drop policy if exists "tact_execution_history_insert_anon_stage0" on public.tact_execution_history;
create policy "tact_execution_history_insert_anon_stage0"
  on public.tact_execution_history for insert with check (true);

drop policy if exists "tact_memory_select_anon_stage0" on public.tact_memory;
create policy "tact_memory_select_anon_stage0"
  on public.tact_memory for select using (true);

drop policy if exists "tact_memory_insert_anon_stage0" on public.tact_memory;
create policy "tact_memory_insert_anon_stage0"
  on public.tact_memory for insert with check (true);

drop policy if exists "tact_memory_update_anon_stage0" on public.tact_memory;
create policy "tact_memory_update_anon_stage0"
  on public.tact_memory for update using (true) with check (true);
