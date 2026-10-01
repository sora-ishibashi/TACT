-- =====================================================================
-- Yolna Runs Standalone — Baseline Migration 5/8
-- Execution Attention (SOR-135 Phase 3)
-- =====================================================================
--
-- Consolidated from root's 20261027000000_create_tact_execution_
-- attentions.sql and 20261101000000_add_lifecycle_audit_fields_to_
-- tact_execution_attentions.sql. No cross-product FK existed in the root
-- schema for this table — unchanged here except for being one baseline
-- instead of two incremental migrations.
--
-- =====================================================================

create table if not exists public.tact_execution_attentions (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid not null references auth.users (id) on delete cascade,

  execution_id uuid not null references public.tact_canonical_executions (id) on delete cascade,

  permission_decision_id uuid not null references public.tact_execution_permission_decisions (id) on delete cascade,

  reason text not null
    check (reason in ('permission_mismatch', 'approval_required')),

  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved')),

  acknowledged_at timestamptz null,

  acknowledged_by uuid null references auth.users (id) on delete set null,

  resolved_at timestamptz null,

  resolved_by uuid null references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

create unique index if not exists idx_tact_execution_attentions_execution_id
  on public.tact_execution_attentions (execution_id);

create index if not exists idx_tact_execution_attentions_user_id_created_at
  on public.tact_execution_attentions (user_id, created_at desc);

create index if not exists idx_tact_execution_attentions_status
  on public.tact_execution_attentions (status);

create or replace function public.set_tact_execution_attentions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_execution_attentions_updated_at on public.tact_execution_attentions;
create trigger trg_tact_execution_attentions_updated_at
  before update on public.tact_execution_attentions
  for each row
  execute function public.set_tact_execution_attentions_updated_at();

alter table public.tact_execution_attentions enable row level security;

drop policy if exists "tact_execution_attentions_select_own" on public.tact_execution_attentions;
create policy "tact_execution_attentions_select_own"
  on public.tact_execution_attentions for select
  using (auth.uid() = user_id);
