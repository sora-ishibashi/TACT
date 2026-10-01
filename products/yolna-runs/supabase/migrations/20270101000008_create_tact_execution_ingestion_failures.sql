-- =====================================================================
-- Yolna Runs Standalone — Baseline Migration 8/8
-- Ingestion Pipeline Failure Telemetry (SOR-135 Phase 3)
-- =====================================================================
--
-- Consolidated from root's 20261102000000_create_tact_execution_
-- ingestion_failures.sql. Unchanged except cross-product FK removal:
-- connection_id referenced Yolna's tact_connections. Here it is a plain
-- `uuid null` opaque reference — no FK.
--
-- =====================================================================

create table if not exists public.tact_execution_ingestion_failures (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid not null references auth.users (id) on delete cascade,

  provider text not null
    check (provider in (
      'openai', 'anthropic', 'mcp', 'slack', 'gmail',
      'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom'
    )),

  -- Opaque reference (see header comment) — no FK.
  connection_id uuid null,

  adapter_version text not null
    check (char_length(adapter_version) between 1 and 100),

  stage text not null
    check (stage in ('normalization', 'capture', 'permission_evaluation', 'work_correlation')),

  error_kind text not null
    check (char_length(error_kind) between 1 and 255),

  occurred_at timestamptz not null default now()

);

create index if not exists idx_tact_execution_ingestion_failures_user_id_occurred_at
  on public.tact_execution_ingestion_failures (user_id, occurred_at desc);

create index if not exists idx_tact_execution_ingestion_failures_provider
  on public.tact_execution_ingestion_failures (provider);

alter table public.tact_execution_ingestion_failures enable row level security;

drop policy if exists "tact_execution_ingestion_failures_select_own" on public.tact_execution_ingestion_failures;
create policy "tact_execution_ingestion_failures_select_own"
  on public.tact_execution_ingestion_failures for select
  using (auth.uid() = user_id);
