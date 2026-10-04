-- =====================================================================
-- Yolna Runs Standalone — Baseline Migration 1/8
-- Canonical Execution (SOR-135 Phase 3)
-- =====================================================================
--
-- Consolidated Runs-owned baseline for public.tact_canonical_executions,
-- re-derived from the root Yolna schema (supabase/migrations/
-- 20261020000000_create_tact_canonical_executions.sql,
-- 20261022000000_create_tact_execution_work_correlations.sql's
-- correlation_status column,
-- 20261103000000_add_v1_observation_contract_to_tact_canonical_executions.sql,
-- 20261104000000_create_tact_execution_outcomes.sql's outcome_status/
-- outcome_kind columns) as ONE forward baseline rather than copied
-- incremental history — this is a new product's migration timeline, not a
-- replay of Yolna's (per SOR-135 Phase 3 instructions). The v1 Canonical
-- Execution contract (schema_version/observation_mode/
-- pre_execution_visible/correlation_status/outcome_status/outcome_kind)
-- itself is unchanged; only the physical migration history is
-- consolidated.
--
-- Cross-product FK removal (SOR-135 Phase 3 non-negotiable, SOR-10/Phase 2
-- audit finding): the root schema's work_id/connection_id are
-- `references public.tact_works` / `references public.tact_connections`
-- — both Yolna-owned tables that do not exist in this schema. Here they
-- are plain `uuid null` columns with NO foreign key — opaque references
-- Runs Core treats as "a Work/Connection identifier it was told about",
-- never as a key Runs' own database can validate by itself. Work identity
-- is instead corroborated, when available, against this product's own
-- tact_runs_work_projection (migration 20270101000008) — and Capture must
-- succeed identically whether or not that projection row has arrived yet
-- (Capture first. Check immediately. Correlate later. — see
-- 20270101000003_create_tact_execution_correlation.sql's RPCs for where
-- that corroboration actually happens; it is never done here at capture
-- time via a blocking FK/trigger).
--
-- =====================================================================

create table if not exists public.tact_canonical_executions (

  id uuid not null primary key default gen_random_uuid(),

  schema_version integer not null default 1
    check (schema_version >= 1),

  -- ---- Identity ----

  user_id uuid not null references auth.users (id) on delete cascade,

  organization_id uuid null,

  workspace_id uuid null,

  -- Opaque reference (see header comment) — no FK to any Work table,
  -- Runs-owned or otherwise. Deleting/archiving the referenced Work on
  -- whichever system owns it never cascades here; Capture-first means
  -- this row outlives the Work's own lifecycle by design.
  work_id uuid null,

  -- Opaque reference, same reasoning as work_id.
  connection_id uuid null,

  -- ---- Actor ----

  actor_kind text not null
    check (actor_kind in ('human', 'ai_agent', 'service', 'connector', 'system')),

  actor_id text null
    check (actor_id is null or char_length(actor_id) between 1 and 255),

  agent_id text null
    check (agent_id is null or char_length(agent_id) between 1 and 255),

  on_behalf_of_actor_kind text null
    check (
      on_behalf_of_actor_kind is null
      or on_behalf_of_actor_kind in ('human', 'ai_agent', 'service', 'connector', 'system')
    ),

  on_behalf_of_actor_id text null
    check (on_behalf_of_actor_id is null or char_length(on_behalf_of_actor_id) between 1 and 255),

  -- ---- Source / Provenance ----

  provider text not null
    check (provider in (
      'openai', 'anthropic', 'mcp', 'slack', 'gmail',
      'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom'
    )),

  source_type text not null
    check (source_type in ('webhook', 'poll', 'manual_report', 'sdk_callback', 'runtime_dispatch')),

  external_event_id text not null
    check (char_length(external_event_id) between 1 and 500),

  adapter_version text not null
    check (char_length(adapter_version) between 1 and 100),

  source_metadata jsonb null,

  raw_payload_ref text null
    check (raw_payload_ref is null or char_length(raw_payload_ref) between 1 and 1000),

  observation_mode text null
    check (observation_mode is null or observation_mode in ('inline', 'instrumented', 'reconciled')),

  pre_execution_visible boolean not null default false,

  -- ---- Action ----

  action_category text not null
    check (action_category in (
      'read', 'create', 'update', 'send', 'delete', 'share', 'execute', 'approve', 'unknown'
    )),

  operation text not null
    check (char_length(operation) between 1 and 255),

  resource_type text null
    check (resource_type is null or char_length(resource_type) between 1 and 255),

  resource_identifier text null
    check (resource_identifier is null or char_length(resource_identifier) between 1 and 500),

  target_provider text null
    check (target_provider is null or target_provider in (
      'openai', 'anthropic', 'mcp', 'slack', 'gmail',
      'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom'
    )),

  -- ---- Status ----

  status text not null default 'observed'
    check (status in ('observed', 'running', 'succeeded', 'failed', 'cancelled', 'unknown')),

  error_code text null
    check (error_code is null or char_length(error_code) between 1 and 255),

  error_message text null
    check (error_message is null or char_length(error_message) <= 2000),

  -- ---- Permission Context (summary; history lives in
  -- tact_execution_permission_decisions) ----

  permission_status text not null default 'unknown'
    check (permission_status in ('pending', 'allowed', 'denied', 'unknown', 'approval_required')),

  permission_reason_code text null
    check (permission_reason_code is null or char_length(permission_reason_code) between 1 and 255),

  permission_evaluated_at timestamptz null,

  -- ---- Work Correlation Context (summary; history lives in
  -- tact_execution_work_correlations) ----

  correlation_status text not null default 'pending'
    check (correlation_status in ('pending', 'matched', 'ambiguous', 'unresolved')),

  -- ---- Outcome Context (summary; history lives in
  -- tact_execution_outcomes) ----

  outcome_status text not null default 'unknown'
    check (outcome_status in ('unknown', 'asserted')),

  outcome_kind text null
    check (outcome_kind is null or char_length(outcome_kind) between 1 and 255),

  -- ---- Time ----

  provider_occurred_at timestamptz null,

  observed_at timestamptz not null,

  persisted_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

create unique index if not exists idx_tact_canonical_executions_idempotency
  on public.tact_canonical_executions (user_id, provider, external_event_id);

create index if not exists idx_tact_canonical_executions_user_id_persisted_at
  on public.tact_canonical_executions (user_id, persisted_at desc);

create index if not exists idx_tact_canonical_executions_work_id
  on public.tact_canonical_executions (work_id)
  where work_id is not null;

create index if not exists idx_tact_canonical_executions_status
  on public.tact_canonical_executions (status);

create index if not exists idx_tact_canonical_executions_permission_status
  on public.tact_canonical_executions (permission_status);

create index if not exists idx_tact_canonical_executions_correlation_status
  on public.tact_canonical_executions (correlation_status);

create index if not exists idx_tact_canonical_executions_outcome_status
  on public.tact_canonical_executions (outcome_status);

create or replace function public.set_tact_canonical_executions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_canonical_executions_updated_at on public.tact_canonical_executions;
create trigger trg_tact_canonical_executions_updated_at
  before update on public.tact_canonical_executions
  for each row
  execute function public.set_tact_canonical_executions_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security — SELECT only. Writes are always the service-role
-- Adapter boundary (packages/runs-core/tact-execution/store.ts); no
-- authenticated-role INSERT/UPDATE/DELETE policy is defined.
-- ---------------------------------------------------------------------

alter table public.tact_canonical_executions enable row level security;

drop policy if exists "tact_canonical_executions_select_own" on public.tact_canonical_executions;
create policy "tact_canonical_executions_select_own"
  on public.tact_canonical_executions for select
  using (auth.uid() = user_id);
