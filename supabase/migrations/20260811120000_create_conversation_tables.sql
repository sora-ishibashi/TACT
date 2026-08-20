-- =====================================================================
-- Migration: Create conversation persistence tables
-- =====================================================================
--
-- 目的:
--   TACTのConversation機能(core/conversation/*)を、開発サーバー再起動や
--   HTTPリクエストをまたいでも保持できるようにするための永続化テーブル。
--
-- 対象テーブル:
--   1. conversations
--   2. conversation_messages
--   3. conversation_workflow_runs
--
-- ドメイン構造:
--   Conversation
--     ├─ messages      (conversation_messages)
--     └─ workflowRuns  (conversation_workflow_runs)
--
-- 重要:
--   - 既存の users / executions テーブルには一切手を加えない。
--   - このマイグレーションはSTEP4時点では作成のみであり、
--     Supabaseへの適用(実行)はまだ行わない。
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 拡張機能
-- ---------------------------------------------------------------------
--
-- gen_random_uuid()の利用に必要。既存のusers/executionsテーブルが
-- 既にuuid主キーを使っていることから、この拡張は既に有効である
-- 可能性が高いが、念のため冪等な形で明示しておく
-- (新規テーブル・新規カラムの追加ではないため、禁止事項には抵触しない)。

create extension if not exists pgcrypto;


-- ---------------------------------------------------------------------
-- 1. conversations
-- ---------------------------------------------------------------------
--
-- Conversation Aggregate Rootの本体。
-- currentTask / currentOutput / title など「現在の状態」のみを持つ。
-- messages / workflowRunsは別テーブルに保持する(理由はSTEP2の設計案を参照)。

create table if not exists public.conversations (

  id uuid not null primary key default gen_random_uuid(),

  -- 現状は認証機構がなく、Conversation.userIdは常に未設定。
  -- 将来Supabase Authを導入した際にスキーマ変更なしで移行できるよう、
  -- 今のうちにFKだけ張っておく。ON DELETE SET NULLとし、
  -- usersが削除されてもconversations自体は消さない。
  user_id uuid null references public.users (id) on delete set null,

  title text null,

  current_task text not null default '',

  -- Writerの出力(unknown型)をそのまま保持する。
  -- 既存のWriter出力Schemaには一切依存しない。
  current_output jsonb null default null,

  created_at timestamptz not null default now(),

  -- Turn終了時の楽観的ロックにも利用する
  -- (WHERE id = :id AND updated_at = :読み込み時の値 のような形で使用想定)。
  updated_at timestamptz not null default now()

);


-- ---------------------------------------------------------------------
-- 2. conversation_messages
-- ---------------------------------------------------------------------
--
-- ConversationMessageは追記専用のログであり、Conversation本体の
-- JSONB配列にはせず、独立したテーブルとして持つ
-- (1件追加のたびに配列全体を書き戻すコストを避けるため)。

create table if not exists public.conversation_messages (

  id uuid not null primary key default gen_random_uuid(),

  conversation_id uuid not null
    references public.conversations (id) on delete cascade,

  role text not null check (role in ('user', 'assistant')),

  content text not null,

  created_at timestamptz not null default now()

);

create index if not exists idx_conversation_messages_conversation_id_created_at
  on public.conversation_messages (conversation_id, created_at);


-- ---------------------------------------------------------------------
-- 3. conversation_workflow_runs
-- ---------------------------------------------------------------------
--
-- WorkflowRunも同様に、Conversation本体とは独立したテーブルとして持つ。
-- outputsは全Agent出力(Evidence等を含む)をそのままJSONBで保持し、
-- 個別Agentの出力Schemaには一切依存しない。

create table if not exists public.conversation_workflow_runs (

  id uuid not null primary key default gen_random_uuid(),

  conversation_id uuid not null
    references public.conversations (id) on delete cascade,

  input text not null,

  outputs jsonb not null default '{}'::jsonb,

  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),

  started_at timestamptz not null default now(),

  completed_at timestamptz null,

  error text null

);

create index if not exists idx_conversation_workflow_runs_conversation_id_started_at
  on public.conversation_workflow_runs (conversation_id, started_at);


-- ---------------------------------------------------------------------
-- 4. updated_at 自動更新 (conversationsのみ)
-- ---------------------------------------------------------------------
--
-- リポジトリ内を調査した結果、updated_at自動更新用の関数・triggerは
-- 既存プロジェクトに存在しなかったため、今回のスコープに必要な
-- 最小限の関数・triggerを新規に定義する。対象はconversations.updated_at
-- のみ(conversation_messages / conversation_workflow_runsにはupdated_at
-- 列自体が存在しないため対象外)。

create or replace function public.set_conversations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_conversations_updated_at on public.conversations;

create trigger trg_conversations_updated_at
before update on public.conversations
for each row
execute function public.set_conversations_updated_at();


-- ---------------------------------------------------------------------
-- 5. Row Level Security (RLS)
-- ---------------------------------------------------------------------
--
-- Stage 0 (現在・Supabase Auth未導入):
--   anonキーからの操作を許可する許可的ポリシーを明示的に作成する
--   (「RLSを無効化する」のではなく、RLSは有効にした上で許可的ポリシーを
--   敷く。将来Stage 1でauth.uid()ベースのポリシーに差し替える前提)。
--
-- Stage 1 (将来・Supabase Auth導入後、想定):
--   下記のUSING(true)/WITH CHECK(true)を、
--     conversations           : auth.uid() = user_id
--     conversation_messages    : conversation_idの親conversationsが
--                                auth.uid() = user_idであること
--     conversation_workflow_runs: 同上
--   へ差し替える想定。テーブル構造・列追加は不要。

alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.conversation_workflow_runs enable row level security;

-- conversations --------------------------------------------------------

drop policy if exists "conversations_select_anon_stage0" on public.conversations;
create policy "conversations_select_anon_stage0"
  on public.conversations for select
  using (true);

drop policy if exists "conversations_insert_anon_stage0" on public.conversations;
create policy "conversations_insert_anon_stage0"
  on public.conversations for insert
  with check (true);

drop policy if exists "conversations_update_anon_stage0" on public.conversations;
create policy "conversations_update_anon_stage0"
  on public.conversations for update
  using (true)
  with check (true);

drop policy if exists "conversations_delete_anon_stage0" on public.conversations;
create policy "conversations_delete_anon_stage0"
  on public.conversations for delete
  using (true);

-- conversation_messages -------------------------------------------------

drop policy if exists "conversation_messages_select_anon_stage0" on public.conversation_messages;
create policy "conversation_messages_select_anon_stage0"
  on public.conversation_messages for select
  using (true);

drop policy if exists "conversation_messages_insert_anon_stage0" on public.conversation_messages;
create policy "conversation_messages_insert_anon_stage0"
  on public.conversation_messages for insert
  with check (true);

drop policy if exists "conversation_messages_update_anon_stage0" on public.conversation_messages;
create policy "conversation_messages_update_anon_stage0"
  on public.conversation_messages for update
  using (true)
  with check (true);

drop policy if exists "conversation_messages_delete_anon_stage0" on public.conversation_messages;
create policy "conversation_messages_delete_anon_stage0"
  on public.conversation_messages for delete
  using (true);

-- conversation_workflow_runs ---------------------------------------------

drop policy if exists "conversation_workflow_runs_select_anon_stage0" on public.conversation_workflow_runs;
create policy "conversation_workflow_runs_select_anon_stage0"
  on public.conversation_workflow_runs for select
  using (true);

drop policy if exists "conversation_workflow_runs_insert_anon_stage0" on public.conversation_workflow_runs;
create policy "conversation_workflow_runs_insert_anon_stage0"
  on public.conversation_workflow_runs for insert
  with check (true);

drop policy if exists "conversation_workflow_runs_update_anon_stage0" on public.conversation_workflow_runs;
create policy "conversation_workflow_runs_update_anon_stage0"
  on public.conversation_workflow_runs for update
  using (true)
  with check (true);

drop policy if exists "conversation_workflow_runs_delete_anon_stage0" on public.conversation_workflow_runs;
create policy "conversation_workflow_runs_delete_anon_stage0"
  on public.conversation_workflow_runs for delete
  using (true);
