-- =====================================================================
-- Migration: Canonical Work Model Foundation (Architecture Migration
-- Phase B1)
-- =====================================================================
--
-- 背景 (ARCH-R1/ARCH-R2):
--   現在のTACTはConversationが事実上Workの代替として振る舞っており、
--   「TACTが完了まで責任を持つ仕事」という独立した概念(Work)が
--   存在しない。ARCH-R2はWork/Task/Run/Approval/Event/Actor/Connection
--   をCanonical Modelとして設計し、Phase B1ではそのうちWork/Task/
--   Run/Approval/Task Dependencyの5テーブルのみを新設する
--   (Event/Actor/Connectionは実際の必要性が生じるまで先送り、
--   ARCH-R2 Section8/9/10・完了報告Section22参照)。
--
--   重要(Phase B1絶対条件): このmigrationはSchemaの追加のみを行う。
--   どのアプリケーションコードもまだこれらのテーブルへ接続しない
--   (core/tact-orchestrator/commander.tsのrunOrchestration()は
--   一切変更しない)。既存のResearch/Conversation/Bot/Artifact
--   runtimeは本migration適用後も完全に無変更のまま動作する。
--
-- 対象テーブル(新設):
--   1. tact_works
--   2. tact_tasks
--   3. tact_task_dependencies
--   4. tact_runs
--   5. tact_approvals
--
-- 既存テーブルへの変更:
--   tact_conversations.work_id (nullable、migration互換用の一時的な
--     back-reference。ARCH-R2の原則通り、ConversationとWorkの概念を
--     再統合するための列ではない。既存Conversationはwork_id=NULLの
--     ままで完全に動作し続ける。Phase B1時点ではどのroute/store/
--     orchestrationもこの列を読み書きしない)
--   tact_artifacts.work_id (同上、nullable)
--
-- Actor表現(ARCH-R2 Section9の結論): 独立したtact_actorsテーブルは
-- 作らず、型付き参照(actor_kind + actor_id の2列)をWork/Approvalへ
-- 直接埋め込む。actor_kindは'user'|'bot'|'system'|'ai'の4値に
-- CHECK制約で限定する(tact_execution_records.capability等、この
-- repositoryで既に確立された「無制限textにしない」CHECK制約方針を
-- 踏襲)。
--
-- Ownership設計(ARCH-R2 Section15/17): Work.user_idを唯一のRLS
-- ownership scopeとする。Task/Run/Approval/Task Dependencyは
-- user_id列を重複保持せず、tact_worksへのJOIN(RLS policyの
-- EXISTS句)経由でownershipを判定する——tact_conversation_messages/
-- tact_execution_records(親のtact_conversations.user_idをEXISTS句で
-- 参照する既存パターン、20260825000000migration)と全く同じ設計。
--
-- FK削除挙動の方針(Phase B1指示 Section11、「安易なCASCADEが本当に
-- 適切か」の検討結果):
--   - auth.users → tact_works: CASCADE
--     (既存のtact_conversations/tact_artifacts等と同じ、account
--     削除時に所有データが孤児化しないための既存規約をそのまま踏襲)
--   - tact_works → {tact_tasks, tact_runs, tact_approvals,
--     tact_task_dependencies(task経由)}: CASCADE
--     (これらはWorkが無ければ意味を持たない子データであり、
--     auth.users削除時のフルCASCADE連鎖(既存規約)を維持するために
--     必要。Work単体を明示的に削除する運用は現時点で想定していない
--     ため、「Canonical audit/historyを軽々しく壊す」という懸念は
--     実質的にaccount削除時の整合性維持の話に限定される)
--   - tact_works → tact_conversations.work_id: SET NULL
--     (WorkはConversationの所有者ではない。既存の
--     tact_conversations.artifact_id → tact_artifacts と同じ
--     「参照先が消えても自分は消えない」パターン)
--   - tact_works → tact_artifacts.work_id: SET NULL (同上の理由)
--   - tact_conversations → tact_works.primary_conversation_id:
--     SET NULL (Workは自身の発端となったConversationが削除されても
--     消えるべきではない、Canonical audit重視の判断)
--   - tact_tasks → tact_approvals.task_id: SET NULL
--     (Approvalの主たる所属先はWork(NOT NULL)であり、taskIdは
--     「どのTaskが契機か」を示す任意の追加ポインタに過ぎない。Task
--     削除でApproval自体の監査記録を巻き込み削除しない)
--   - tact_tasks → tact_tasks.parent_task_id: SET NULL
--     (現時点で未使用の予約列。親削除で子を巻き込み削除しない)
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. tact_works
-- ---------------------------------------------------------------------

create table if not exists public.tact_works (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid not null references auth.users (id) on delete cascade,

  -- 予約列。Organization機能は未実装(tact_core_knowledge等と同じ
  -- 「テーブルは無いが列だけ確保しておく」既存パターン)のため、FK
  -- 制約は付与しない。
  organization_id uuid null,

  created_by_actor_kind text not null
    check (created_by_actor_kind in ('user', 'bot', 'system', 'ai')),

  created_by_actor_id text not null
    check (char_length(created_by_actor_id) between 1 and 255),

  title text null,

  objective text null,

  status text not null default 'created'
    check (status in (
      'created', 'planning', 'running', 'waiting_for_input',
      'waiting_for_approval', 'completed', 'failed', 'cancelled'
    )),

  primary_conversation_id uuid null
    references public.tact_conversations (id) on delete set null,

  started_at timestamptz null,

  completed_at timestamptz null,

  failed_at timestamptz null,

  cancelled_at timestamptz null,

  -- Run.costの集約キャッシュ(ARCH-R2 Section15、Source of Truthは
  -- 各Run.cost)。Phase B1ではどのコードも書き込まない。
  cost_summary jsonb null,

  metadata jsonb null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

create index if not exists idx_tact_works_user_id_updated_at
  on public.tact_works (user_id, updated_at desc);

create index if not exists idx_tact_works_primary_conversation_id
  on public.tact_works (primary_conversation_id);

create or replace function public.set_tact_works_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_works_updated_at on public.tact_works;

create trigger trg_tact_works_updated_at
before update on public.tact_works
for each row
execute function public.set_tact_works_updated_at();


-- ---------------------------------------------------------------------
-- 2. tact_tasks
-- ---------------------------------------------------------------------
--
-- core/tact-orchestrator/task.tsのTask(runtime memoryのみ)と意味を
-- 揃える。assignedProvider/assignedModelはここには持たない
-- (Phase B1指示: 実際に使用されたProvider/ModelはRunの責務)。

create table if not exists public.tact_tasks (

  id uuid not null primary key default gen_random_uuid(),

  work_id uuid not null references public.tact_works (id) on delete cascade,

  parent_task_id uuid null
    references public.tact_tasks (id) on delete set null,

  description text not null,

  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),

  assigned_capability text null,

  -- Phase90由来(core/tact-orchestrator/task.tsのTask.tableSchemaと
  -- 同じ形: {columns: string[], requestedRowCount?: number})。
  table_schema jsonb null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

create index if not exists idx_tact_tasks_work_id
  on public.tact_tasks (work_id);

create or replace function public.set_tact_tasks_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_tasks_updated_at on public.tact_tasks;

create trigger trg_tact_tasks_updated_at
before update on public.tact_tasks
for each row
execute function public.set_tact_tasks_updated_at();


-- ---------------------------------------------------------------------
-- 3. tact_task_dependencies
-- ---------------------------------------------------------------------
--
-- core/tact-orchestrator/task.tsのTask.dependencies(string[])を、
-- 配列FKではなく正規化されたjoin tableとして持つ(このrepositoryに
-- 配列FKの前例が無いため)。複合主キー自体がduplicate dependencyを
-- 構造的に防ぎ、CHECK制約がself dependencyを防ぐ(Cycle Detectionの
-- 実装はPhase B1のscope外、将来のWork Router側で行う)。

create table if not exists public.tact_task_dependencies (

  task_id uuid not null references public.tact_tasks (id) on delete cascade,

  depends_on_task_id uuid not null references public.tact_tasks (id) on delete cascade,

  created_at timestamptz not null default now(),

  primary key (task_id, depends_on_task_id),

  constraint tact_task_dependencies_no_self_dependency
    check (task_id <> depends_on_task_id)

);

create index if not exists idx_tact_task_dependencies_depends_on_task_id
  on public.tact_task_dependencies (depends_on_task_id);


-- ---------------------------------------------------------------------
-- 4. tact_runs
-- ---------------------------------------------------------------------
--
-- 「あるTaskを、あるCapability/Provider/Model構成で一度実行した
-- attempt」。同一task_id内でattemptが重複しないことをunique indexで
-- 保証する。work_idはtask_id経由でも辿れるが、Work単位のRun一覧を
-- 都度自己結合しなくて済むよう意図的に非正規化する
-- (ARCH-R2 Section5)。

create table if not exists public.tact_runs (

  id uuid not null primary key default gen_random_uuid(),

  work_id uuid not null references public.tact_works (id) on delete cascade,

  task_id uuid not null references public.tact_tasks (id) on delete cascade,

  attempt integer not null check (attempt >= 1),

  capability text not null,

  provider text null,

  model text null,

  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),

  started_at timestamptz not null default now(),

  completed_at timestamptz null,

  error text null,

  -- core/llm/types.tsのLLMCost({tokens, estimatedUSD})と同じ形状を
  -- 想定するが、計測できないCapability(Search/API等)ではNULLのまま
  -- (「取得できないcostを0として記録しない」というARCH-R2 Section16
  -- の方針)。
  cost jsonb null,

  -- Provider固有ID(将来のn8n execution id等)。WorkやTaskへは
  -- 一切持たせず、Runにのみ保持する(ARCH-R2 Section14)。
  external_ref jsonb null,

  -- core/tact-orchestrator/types.tsのCapabilityInvocationResultと
  -- 同じ語彙で格納する想定。
  result jsonb null,

  created_at timestamptz not null default now()

);

create unique index if not exists idx_tact_runs_task_id_attempt
  on public.tact_runs (task_id, attempt);

create index if not exists idx_tact_runs_work_id
  on public.tact_runs (work_id);


-- ---------------------------------------------------------------------
-- 5. tact_approvals
-- ---------------------------------------------------------------------

create table if not exists public.tact_approvals (

  id uuid not null primary key default gen_random_uuid(),

  work_id uuid not null references public.tact_works (id) on delete cascade,

  task_id uuid null references public.tact_tasks (id) on delete set null,

  requested_by_actor_kind text not null
    check (requested_by_actor_kind in ('user', 'bot', 'system', 'ai')),

  requested_by_actor_id text not null
    check (char_length(requested_by_actor_id) between 1 and 255),

  requested_from_actor_kind text not null
    check (requested_from_actor_kind in ('user', 'bot', 'system', 'ai')),

  requested_from_actor_id text not null
    check (char_length(requested_from_actor_id) between 1 and 255),

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired')),

  reason text not null,

  payload jsonb not null default '{}'::jsonb,

  requested_at timestamptz not null default now(),

  responded_at timestamptz null,

  response text null,

  expires_at timestamptz null,

  created_at timestamptz not null default now()

);

create index if not exists idx_tact_approvals_work_id
  on public.tact_approvals (work_id);

create index if not exists idx_tact_approvals_task_id
  on public.tact_approvals (task_id);


-- ---------------------------------------------------------------------
-- 6. 既存テーブルへのwork_id追加(migration互換用のback-reference)
-- ---------------------------------------------------------------------

alter table public.tact_conversations
  add column if not exists work_id uuid null
    references public.tact_works (id) on delete set null;

create index if not exists idx_tact_conversations_work_id
  on public.tact_conversations (work_id);

alter table public.tact_artifacts
  add column if not exists work_id uuid null
    references public.tact_works (id) on delete set null;

create index if not exists idx_tact_artifacts_work_id
  on public.tact_artifacts (work_id);


-- ---------------------------------------------------------------------
-- 7. Row Level Security
-- ---------------------------------------------------------------------
--
-- tact_works: tact_conversations/tact_artifactsと同じStage1
-- ownershipパターン(auth.uid() = user_id)。Artifactと同じく継続的に
-- 更新されるリソースのため、4操作すべてにpolicyを持つ。

alter table public.tact_works enable row level security;

drop policy if exists "tact_works_select_own" on public.tact_works;
create policy "tact_works_select_own"
  on public.tact_works for select
  using (auth.uid() = user_id);

drop policy if exists "tact_works_insert_own" on public.tact_works;
create policy "tact_works_insert_own"
  on public.tact_works for insert
  with check (auth.uid() = user_id);

drop policy if exists "tact_works_update_own" on public.tact_works;
create policy "tact_works_update_own"
  on public.tact_works for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "tact_works_delete_own" on public.tact_works;
create policy "tact_works_delete_own"
  on public.tact_works for delete
  using (auth.uid() = user_id);

-- tact_tasks: 自身のuser_id列を持たないため、親tact_worksへの
-- EXISTS句でownershipを判定する(tact_conversation_messagesと同じ
-- 既存パターン)。Phase B1のStore(core/tact-work/store.ts)は
-- select/insertのみを行うため、update/deleteポリシーは今回定義
-- しない(tact_conversation_messages/tact_execution_recordsと同じ
-- 「使わない操作のpolicyを先回りで作らない」既存方針。Task statusの
-- 更新が必要になった時点で、そのPhaseでupdateポリシーを追加する)。

alter table public.tact_tasks enable row level security;

drop policy if exists "tact_tasks_select_own" on public.tact_tasks;
create policy "tact_tasks_select_own"
  on public.tact_tasks for select
  using (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "tact_tasks_insert_own" on public.tact_tasks;
create policy "tact_tasks_insert_own"
  on public.tact_tasks for insert
  with check (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

-- tact_task_dependencies: 同じくEXISTS句でownershipを判定する。
-- select/insertのみ(Phase B1のStoreはdelete/updateを行わない)。

alter table public.tact_task_dependencies enable row level security;

drop policy if exists "tact_task_dependencies_select_own" on public.tact_task_dependencies;
create policy "tact_task_dependencies_select_own"
  on public.tact_task_dependencies for select
  using (
    exists (
      select 1 from public.tact_tasks t
      join public.tact_works w on w.id = t.work_id
      where t.id = task_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "tact_task_dependencies_insert_own" on public.tact_task_dependencies;
create policy "tact_task_dependencies_insert_own"
  on public.tact_task_dependencies for insert
  with check (
    exists (
      select 1 from public.tact_tasks t
      join public.tact_works w on w.id = t.work_id
      where t.id = task_id and w.user_id = auth.uid()
    )
  );

-- tact_runs: Phase B1のStoreがcompleteRun()/failRun()でstatus等を
-- 更新するため、update policyも定義する(delete policyは無し、
-- Storeにdelete操作が無いため)。

alter table public.tact_runs enable row level security;

drop policy if exists "tact_runs_select_own" on public.tact_runs;
create policy "tact_runs_select_own"
  on public.tact_runs for select
  using (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "tact_runs_insert_own" on public.tact_runs;
create policy "tact_runs_insert_own"
  on public.tact_runs for insert
  with check (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "tact_runs_update_own" on public.tact_runs;
create policy "tact_runs_update_own"
  on public.tact_runs for update
  using (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

-- tact_approvals: 同じくupdateApprovalStatus()のためupdate policyも
-- 定義する。

alter table public.tact_approvals enable row level security;

drop policy if exists "tact_approvals_select_own" on public.tact_approvals;
create policy "tact_approvals_select_own"
  on public.tact_approvals for select
  using (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "tact_approvals_insert_own" on public.tact_approvals;
create policy "tact_approvals_insert_own"
  on public.tact_approvals for insert
  with check (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "tact_approvals_update_own" on public.tact_approvals;
create policy "tact_approvals_update_own"
  on public.tact_approvals for update
  using (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

-- tact_conversations/tact_artifactsの既存RLSは変更しない
-- (work_id列の追加のみ、既存policyがそのまま適用される)。
