-- =====================================================================
-- Migration: Clarification — Human Interaction Foundation
-- (Fast Port P3a)
-- =====================================================================
--
-- 背景 (docs/architecture/p2-p5-final-architecture.md Section9-14、
-- Fast Port P3a指示):
--   ApprovalをgenericなHumanInteraction entityへ統合しない
--   (ARCH-P1で本番実証済みのtact_approvals schema/status/integrityは
--   一切変更しない、既存のtact_approvals migrationも変更しない)。
--   Clarificationは、Approvalと並列に扱える別のcanonical entityとして
--   独立に新設する。
--
--   Prior Art(ADAPT_AND_BORROW、source codeはコピーせずpatternのみ
--   移植): HumanLayer ACPのAllowedResponderIDs(allowed_responder_ids
--   列)、AXMEのhuman task abstraction(独立interaction typeとしての
--   Clarification)、BoundFlowのgate resolution ≠ engine resume
--   (statusをansweredへ進めるだけで、実際のTask/Work再開はこの
--   migration・対応するStore層のいずれも行わない)。
--
--   このmigrationはSchemaの追加のみを行う(絶対条件: 破壊的変更禁止、
--   tact_approvalsへは一切触れない)。
--
-- 対象テーブル(新設): tact_clarifications
--
-- Ownership設計(tact_approvalsと全く同じ既存パターンを踏襲):
--   Clarification自身はuser_id列を持たない。親tact_worksへのJOIN
--   (RLS policyのEXISTS句)経由でownershipを判定する。
--
-- tact_approvalsとの構造上の差分(意図的な設計判断):
--   - requested_from_actor_kind/id は持たない。Approvalの
--     「判断を仰ぐ相手は常に1人(Work所有者)」という前提の代わりに、
--     Clarificationは「誰が応答してよいか」を allowed_responder_ids
--     (text[]、NULL=Work所有者のみという既定)で表現する
--     (HumanLayer ACP AllowedResponderIDs pattern)。
--   - reason(text) + payload(jsonb、Approval用の汎用action表現)の
--     代わりに、reason_code(closed enum) + question(text)を持つ——
--     ClarificationはAuthorization判断ではなく「情報が足りない」ことの
--     表明であり、Approvalのような任意actionペイロードを持たない
--     (Fast Port P3a絶対条件Step12: JSON-anyのような広すぎるpayload
--     禁止)。
--   - responded_by_actor_kind/id を持つ(Approvalには無い、
--     Clarification固有の追加trace。「誰が応答したか」を最初から
--     記録する設計とした——既存tact_approvalsのschemaは変更しない)。
--   - status列はpending/answered/cancelled/expiredの4値のみ
--     (approved/rejectedに相当する語彙は持たない、Fast Port P3a
--     絶対条件Step3)。
--
-- =====================================================================


create table if not exists public.tact_clarifications (

  id uuid not null primary key default gen_random_uuid(),

  work_id uuid not null references public.tact_works (id) on delete cascade,

  task_id uuid null references public.tact_tasks (id) on delete set null,

  requested_by_actor_kind text not null
    check (requested_by_actor_kind in ('user', 'bot', 'system', 'ai')),

  requested_by_actor_id text not null
    check (char_length(requested_by_actor_id) between 1 and 255),

  -- HumanLayer ACP AllowedResponderIDs pattern(ADAPT_AND_BORROW)。
  -- NULL = canonical owner-only(既定、Work.user_idが暗黙の唯一の
  -- responder候補)。non-empty配列 = 明示allowlist。tactUserIdのみを
  -- 格納する想定(外部Provider由来のraw actor idを直接書き込まない、
  -- 絶対条件10)。
  allowed_responder_ids text[] null,

  status text not null default 'pending'
    check (status in ('pending', 'answered', 'cancelled', 'expired')),

  reason_code text not null
    check (reason_code in ('missing_required_input')),

  question text not null,

  response text null,

  responded_by_actor_kind text null
    check (
      responded_by_actor_kind is null
      or responded_by_actor_kind in ('user', 'bot', 'system', 'ai')
    ),

  responded_by_actor_id text null,

  requested_at timestamptz not null default now(),

  responded_at timestamptz null,

  expires_at timestamptz null,

  created_at timestamptz not null default now()

);

create index if not exists idx_tact_clarifications_work_id
  on public.tact_clarifications (work_id);

create index if not exists idx_tact_clarifications_task_id
  on public.tact_clarifications (task_id);


-- ---------------------------------------------------------------------
-- Row Level Security (tact_approvalsと全く同じEXISTS句パターン)
-- ---------------------------------------------------------------------

alter table public.tact_clarifications enable row level security;

drop policy if exists "tact_clarifications_select_own" on public.tact_clarifications;
create policy "tact_clarifications_select_own"
  on public.tact_clarifications for select
  using (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "tact_clarifications_insert_own" on public.tact_clarifications;
create policy "tact_clarifications_insert_own"
  on public.tact_clarifications for insert
  with check (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "tact_clarifications_update_own" on public.tact_clarifications;
create policy "tact_clarifications_update_own"
  on public.tact_clarifications for update
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

-- tact_approvals / 既存テーブルへの変更は一切無い(このmigrationは
-- tact_clarificationsの新設のみ、絶対条件19)。
