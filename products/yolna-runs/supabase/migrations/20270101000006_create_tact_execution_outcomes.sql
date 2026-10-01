-- =====================================================================
-- Yolna Runs Standalone — Baseline Migration 6/8
-- Execution Outcome (SOR-135 Phase 3)
-- =====================================================================
--
-- Consolidated from root's 20261104000000_create_tact_execution_
-- outcomes.sql (outcome_status/outcome_kind summary columns already
-- included on tact_canonical_executions since migration
-- 20270101000001 — the root schema added them via a later ALTER TABLE,
-- this baseline includes them from the start).
--
-- Cross-product FK removal: artifact_id referenced Yolna's tact_artifacts
-- (Yolna-owned business content, per the SOR-10 audit — Artifacts are
-- Core/Yolna, not Runs). Here it is a plain `uuid null` opaque reference
-- — no FK. No Runs Core code currently resolves Artifact details (no
-- ArtifactProjectionRepository exists), so nothing is lost; if a future
-- phase needs to show Artifact context for an Outcome, it will need its
-- own neutral projection, same pattern as Work/ConversationLink.
--
-- =====================================================================

create table if not exists public.tact_execution_outcomes (

  id uuid not null primary key default gen_random_uuid(),

  execution_id uuid not null references public.tact_canonical_executions (id) on delete cascade,

  status text not null
    check (status in ('asserted', 'unknown')),

  outcome_kind text null
    check (outcome_kind is null or char_length(outcome_kind) between 1 and 255),

  check (
    (status = 'asserted' and outcome_kind is not null)
    or (status = 'unknown' and outcome_kind is null)
  ),

  summary text null
    check (summary is null or char_length(summary) <= 500),

  -- Opaque reference (see header comment) — no FK.
  artifact_id uuid null,

  method text not null
    check (method in ('adapter_asserted', 'manual_override')),

  reason_code text null
    check (reason_code is null or char_length(reason_code) between 1 and 255),

  asserted_by_actor_kind text null
    check (
      asserted_by_actor_kind is null
      or asserted_by_actor_kind in ('human', 'ai_agent', 'service', 'connector', 'system')
    ),

  asserted_by_actor_id text null
    check (asserted_by_actor_id is null or char_length(asserted_by_actor_id) between 1 and 255),

  metadata jsonb null,

  asserted_at timestamptz not null default now()

);

create index if not exists idx_tact_execution_outcomes_execution_id_asserted_at
  on public.tact_execution_outcomes (execution_id, asserted_at desc);

create index if not exists idx_tact_execution_outcomes_status
  on public.tact_execution_outcomes (status);

create index if not exists idx_tact_execution_outcomes_artifact_id
  on public.tact_execution_outcomes (artifact_id)
  where artifact_id is not null;

alter table public.tact_execution_outcomes enable row level security;

drop policy if exists "tact_execution_outcomes_select_own" on public.tact_execution_outcomes;
create policy "tact_execution_outcomes_select_own"
  on public.tact_execution_outcomes for select
  using (
    exists (
      select 1 from public.tact_canonical_executions e
      where e.id = execution_id and e.user_id = auth.uid()
    )
  );
