-- =====================================================================
-- Migration: TACT Conversation Architecture (Phase 64)
-- =====================================================================
--
-- 背景 (Phase 60〜63):
--   TACTのCanonical UIは "/" (TactShell → ResearchSection/CoreSection)
--   と確定した(Phase60)。Legacy(core/conversation/*・public.conversations
--   等)は"/legacy"のFrozen Legacyとして維持され、Canonicalへ直接移植
--   しない(Phase61〜63の一貫した絶対条件)。
--
--   本migrationは、Canonical UI向けの新しいConversation Layerの
--   DB基盤(3テーブル)のみを作成する。Conversation Layerのruntime
--   (core/tact-conversation/*)・API・UI・Orchestrator接続は一切
--   含まない(Phase65以降のスコープ)。
--
-- 対象テーブル (Phase63 Final Schema、そのまま採用):
--   1. tact_conversations
--   2. tact_conversation_messages
--   3. tact_execution_records
--
-- 既存テーブルへの変更:
--   tact_core_knowledge.conversation_id / tact_core_memories.conversation_id
--   のFK参照先を public.conversations(id)(Legacy) から
--   public.tact_conversations(id) へ変更する。
--
--   Phase63の調査により、この2列は core/tact-core/supabaseCoreCapability.ts
--   の resolveUserScopeOwnerId()/assertUserScopeOwner() が
--   scope="conversation"での読み書きを常にthrowで拒否しているため
--   (STEP208、未実装ガード)、現在も将来も実データが存在しないことが
--   判明している。本migration実行直前に以下で実データ0件を再確認済み:
--     SELECT COUNT(*) FROM tact_core_knowledge WHERE conversation_id IS NOT NULL;
--     SELECT COUNT(*) FROM tact_core_memories WHERE conversation_id IS NOT NULL;
--   → いずれも0件(Phase64実行時点で確認済み)。既存データへの影響はない。
--
-- Circular FK対応 (Phase63 Section8):
--   tact_conversations.pending_clarification_message_id は
--   tact_conversation_messages(id) を参照するが、
--   tact_conversation_messages.conversation_id は tact_conversations(id)
--   を参照するため、循環参照になる。作成順序:
--     1. tact_conversations (pending_clarification_message_id 列は
--        作るが、FK制約は付与しない)
--     2. tact_execution_records (tact_conversationsのみ参照)
--     3. tact_conversation_messages (tact_conversations・
--        tact_execution_recordsの両方が既に存在するため、FK込みで作成可能)
--     4. tact_conversations.pending_clarification_message_id へ
--        FK制約を追加(この時点でtact_conversation_messagesが存在する)
--
-- Phase63で明示的に「追加しない」と判定した列(Evidenceなき先回り
-- schema追加の禁止、絶対条件遵守):
--   metadata / last_opened_at / current_task / current_output /
--   status(tact_conversations側) / active_execution_id /
--   last_execution_id / completed_at(tact_execution_records側) /
--   ExecutionRecordの各種speculative index
--   いずれも本migrationに含めない。
--
-- Standalone Execution (Phase63 Section7):
--   Conversationと無関係な独立実行の具体的ユースケースがrepository上に
--   存在しないため、tact_execution_records.conversation_id は
--   NOT NULLとする(Phase62時点のnullable案から変更)。
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. tact_conversations
-- ---------------------------------------------------------------------
--
-- pending_clarification_message_id 列は作成するが、この時点では
-- tact_conversation_messagesがまだ存在しないため、FK制約は
-- セクション4で後から追加する(Circular FK対応)。

create table if not exists public.tact_conversations (

  id uuid not null primary key default gen_random_uuid(),

  -- Phase63 Section3: Legacy conversations.user_idはnullable
  -- (未認証フロー互換のため)だったが、tact_conversationsは新規テーブル
  -- でありその互換制約を持たない。Canonical UI側のConversation作成は
  -- 認証済みユーザーに限定する(Phase62 Section3の判断)。
  user_id uuid not null references auth.users (id) on delete cascade,

  title text null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  -- FK制約はセクション4で追加(Circular FK対応)。
  pending_clarification_message_id uuid null,

  pending_clarification_answered_at timestamptz null

);

create index if not exists idx_tact_conversations_user_id_updated_at
  on public.tact_conversations (user_id, updated_at desc);


-- ---------------------------------------------------------------------
-- 2. tact_execution_records
-- ---------------------------------------------------------------------
--
-- idにDB defaultを設定しない(Phase63 Section6の絶対条件): Orchestrator
-- 実行時はOrchestrationResult.executionIdをそのままアプリケーション側
-- から明示的にINSERTするため。

create table if not exists public.tact_execution_records (

  id uuid not null primary key,

  -- Phase63 Section7: Standalone Executionの具体的ユースケースが
  -- repository上に存在しないため NOT NULL とする。
  conversation_id uuid not null
    references public.tact_conversations (id) on delete cascade,

  capability text not null
    check (capability in ('research', 'chat', 'core_push', 'orchestrator')),

  input text not null,

  status text not null
    check (status in ('completed', 'failed', 'partial')),

  created_at timestamptz not null default now()

  -- completed_atは追加しない(Phase63 Section6: 現行architectureに
  -- 非同期・ストリーミング処理が存在しないため、Evidenceなき先回り
  -- schema追加として除外)。

);


-- ---------------------------------------------------------------------
-- 3. tact_conversation_messages
-- ---------------------------------------------------------------------
--
-- この時点でtact_conversations・tact_execution_recordsの両方が
-- 既に存在するため、FK込みで作成できる。

create table if not exists public.tact_conversation_messages (

  id uuid not null primary key default gen_random_uuid(),

  conversation_id uuid not null
    references public.tact_conversations (id) on delete cascade,

  role text not null
    check (role in ('user', 'assistant')),

  content text not null,

  -- Phase63 Section5: message_typeは "clarification_question" の
  -- 1値のみ(汎用的なMessage taxonomyを作らない)。
  message_type text null
    check (message_type is null or message_type in ('clarification_question')),

  -- Phase63 Section4-3: 逆方向(ExecutionRecord→Message)の検索を
  -- 行う具体的なクエリパターンが存在しないため、indexは付与しない。
  execution_record_id uuid null
    references public.tact_execution_records (id) on delete set null,

  created_at timestamptz not null default now()

);

create index if not exists idx_tact_conversation_messages_conversation_id_created_at
  on public.tact_conversation_messages (conversation_id, created_at);


-- ---------------------------------------------------------------------
-- 4. tact_conversations.pending_clarification_message_id FK追加
-- ---------------------------------------------------------------------
--
-- Circular FK対応: tact_conversation_messagesが今作成されたため、
-- ここでFK制約を追加する。

alter table public.tact_conversations
  drop constraint if exists tact_conversations_pending_clarification_message_id_fkey;

alter table public.tact_conversations
  add constraint tact_conversations_pending_clarification_message_id_fkey
  foreign key (pending_clarification_message_id)
  references public.tact_conversation_messages (id)
  on delete set null;


-- ---------------------------------------------------------------------
-- 5. updated_at 自動更新トリガー (tact_conversationsのみ)
-- ---------------------------------------------------------------------
--
-- 既存precedent: 20260811120000migrationのconversations.updated_atが
-- 同種のtrigger(set_conversations_updated_at())を既に持つ。この
-- 既存conventionにそのまま従う(Phase64絶対条件: Evidenceなしにtrigger
-- を追加しない → 今回はEvidence[既存precedent]があるため追加する)。

create or replace function public.set_tact_conversations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_conversations_updated_at on public.tact_conversations;

create trigger trg_tact_conversations_updated_at
before update on public.tact_conversations
for each row
execute function public.set_tact_conversations_updated_at();


-- ---------------------------------------------------------------------
-- 6. 既存FK参照先変更: tact_core_knowledge / tact_core_memories
-- ---------------------------------------------------------------------
--
-- 変更前: conversation_id → public.conversations(id) (Legacy)
-- 変更後: conversation_id → public.tact_conversations(id) (Canonical)
--
-- 既存の制約名(20260822000000migrationでの無名FK定義から、PostgreSQLの
-- デフォルト命名規則 "<table>_<column>_fkey" に従って自動生成された名前)
-- をdrop constraint if existsで安全に削除してから、新しいFKを追加する。
-- 20260820000000migration(conversations.user_id FK変更)と同じ手法を
-- 踏襲する(既存precedent)。

alter table public.tact_core_knowledge
  drop constraint if exists tact_core_knowledge_conversation_id_fkey;

alter table public.tact_core_knowledge
  add constraint tact_core_knowledge_conversation_id_fkey
  foreign key (conversation_id)
  references public.tact_conversations (id)
  on delete set null;

alter table public.tact_core_memories
  drop constraint if exists tact_core_memories_conversation_id_fkey;

alter table public.tact_core_memories
  add constraint tact_core_memories_conversation_id_fkey
  foreign key (conversation_id)
  references public.tact_conversations (id)
  on delete set null;


-- ---------------------------------------------------------------------
-- 7. Row Level Security
-- ---------------------------------------------------------------------
--
-- tact_conversationsは新規テーブルであり、Stage0(許可的ポリシー)を
-- 経由する既存データ・既存互換性の負担がないため、既存テーブル群の
-- 中で最新かつ唯一のStage1実例であるprojectsテーブル
-- (20260823000000migration、auth.uid() = user_id)と同じ水準の
-- RLSを最初から採用する(Phase63 Section4で確定済みの方針)。

alter table public.tact_conversations enable row level security;
alter table public.tact_conversation_messages enable row level security;
alter table public.tact_execution_records enable row level security;

-- tact_conversations: 4操作すべてをowner本人に限定する(projectsと同型)。

drop policy if exists "tact_conversations_select_own" on public.tact_conversations;
create policy "tact_conversations_select_own"
  on public.tact_conversations for select
  using (auth.uid() = user_id);

drop policy if exists "tact_conversations_insert_own" on public.tact_conversations;
create policy "tact_conversations_insert_own"
  on public.tact_conversations for insert
  with check (auth.uid() = user_id);

drop policy if exists "tact_conversations_update_own" on public.tact_conversations;
create policy "tact_conversations_update_own"
  on public.tact_conversations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "tact_conversations_delete_own" on public.tact_conversations;
create policy "tact_conversations_delete_own"
  on public.tact_conversations for delete
  using (auth.uid() = user_id);

-- tact_conversation_messages: 追記専用(Phase63 Section10の方針)。
-- SELECT/INSERTのみをポリシーとして定義し、UPDATE/DELETEポリシーは
-- 意図的に作らない(RLS有効時、対応するポリシーが存在しない操作は
-- 既定で拒否されるため、これによりUPDATE/DELETEが構造的に不可能になる)。

drop policy if exists "tact_conversation_messages_select_own" on public.tact_conversation_messages;
create policy "tact_conversation_messages_select_own"
  on public.tact_conversation_messages for select
  using (
    exists (
      select 1
      from public.tact_conversations c
      where c.id = conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "tact_conversation_messages_insert_own" on public.tact_conversation_messages;
create policy "tact_conversation_messages_insert_own"
  on public.tact_conversation_messages for insert
  with check (
    exists (
      select 1
      from public.tact_conversations c
      where c.id = conversation_id
        and c.user_id = auth.uid()
    )
  );

-- tact_execution_records: tact_conversation_messagesと同じ理由で
-- 追記専用とし、SELECT/INSERTのみ定義する。

drop policy if exists "tact_execution_records_select_own" on public.tact_execution_records;
create policy "tact_execution_records_select_own"
  on public.tact_execution_records for select
  using (
    exists (
      select 1
      from public.tact_conversations c
      where c.id = conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "tact_execution_records_insert_own" on public.tact_execution_records;
create policy "tact_execution_records_insert_own"
  on public.tact_execution_records for insert
  with check (
    exists (
      select 1
      from public.tact_conversations c
      where c.id = conversation_id
        and c.user_id = auth.uid()
    )
  );
