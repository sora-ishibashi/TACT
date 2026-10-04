-- =====================================================================
-- Yolna Runs Standalone — Baseline Migration 2/8
-- Runs-owned Work / Conversation-Link Projection (SOR-135 Phase 3)
-- =====================================================================
--
-- These two tables are Runs' OWN copy of the minimum Work/Conversation
-- reference data it needs for display and correlation — populated by an
-- explicit Yolna -> Runs projection writer (packages/runs-core's
-- WorkProjectionWriter/ConversationLinkProjectionWriter contract,
-- @tact/execution-contract), never by a live cross-database join into
-- Yolna's tact_works/tact_bot_conversation_links. No FK references either
-- table because, in a standalone deployment, neither exists in this
-- database at all.
--
-- Data minimization (SOR-135 Phase 3 section 7, non-negotiable): these
-- tables hold ONLY identity/title/status/correlation-reference fields.
-- They must never receive prompt text, Slack/Notion/Gmail message bodies,
-- credentials, OAuth/SaaS access tokens, or other business document
-- content. There is deliberately no column for any of that — the writer
-- contract (packages/execution-contract) is typed to make adding one by
-- accident visible in review, not to rely on write-time filtering alone.
--
-- Projection lag is an expected, normal state, not an error (SOR-135
-- Phase 3 section 13): a row referenced by tact_canonical_executions.
-- work_id may not exist here yet (Yolna has not projected it), or may
-- never arrive (Yolna never will, e.g. a test fixture). Every reader of
-- this table (packages/runs-core's registry-backed
-- WorkProjectionRepository/ConversationLinkRepository, this schema's own
-- apply_execution_work_correlation/reclassify_execution_work RPCs in the
-- next migration) treats "no row" as "unknown to Runs right now", never
-- as "does not exist" or "is inactive" — it must never silently fabricate
-- either answer.
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. tact_runs_work_projection
-- ---------------------------------------------------------------------
--
-- Primary key is the external_work_id itself (the same opaque uuid value
-- tact_canonical_executions.work_id and tact_execution_work_correlations.
-- work_id/previous_work_id carry) — the projection writer upserts by this
-- value, there is no separate surrogate id to keep in sync with it.

create table if not exists public.tact_runs_work_projection (

  external_work_id uuid not null primary key,

  user_id uuid not null references auth.users (id) on delete cascade,

  title text null
    check (title is null or char_length(title) <= 500),

  -- Deliberately a plain string, not a CHECK-constrained enum: this
  -- schema does not own Yolna's (or any future projection source's)
  -- Work status vocabulary and must not need a migration every time that
  -- vocabulary changes. Readers (packages/runs-core's tact-runs-view)
  -- already treat an unrecognized status as a safe fallback, never a
  -- throw (@tact/execution-contract's KNOWN_WORK_STATUSES).
  status text not null,

  -- Opaque correlation key shared with
  -- tact_runs_conversation_link_projection.conversation_reference —
  -- not a foreign key to anything (see header comment); just the value
  -- Structural Correlation groups by.
  conversation_reference text null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

create index if not exists idx_tact_runs_work_projection_user_id_updated_at
  on public.tact_runs_work_projection (user_id, updated_at desc);

create index if not exists idx_tact_runs_work_projection_conversation_reference
  on public.tact_runs_work_projection (conversation_reference)
  where conversation_reference is not null;

create or replace function public.set_tact_runs_work_projection_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_runs_work_projection_updated_at on public.tact_runs_work_projection;
create trigger trg_tact_runs_work_projection_updated_at
  before update on public.tact_runs_work_projection
  for each row
  execute function public.set_tact_runs_work_projection_updated_at();

alter table public.tact_runs_work_projection enable row level security;

drop policy if exists "tact_runs_work_projection_select_own" on public.tact_runs_work_projection;
create policy "tact_runs_work_projection_select_own"
  on public.tact_runs_work_projection for select
  using (auth.uid() = user_id);

-- insert/update/delete policy intentionally absent — the projection
-- writer (packages/runs-core-backed, Yolna-side integration) always
-- writes via the service-role client, never an authenticated user
-- session (same "no policy for an operation nobody is meant to use
-- directly" discipline as every other Runs table).

-- ---------------------------------------------------------------------
-- 2. tact_runs_conversation_link_projection
-- ---------------------------------------------------------------------
--
-- Minimum external channel/thread reference needed for Structural
-- Correlation (today: Slack channel/thread -> conversation_reference).
-- No message content, no participant list, no channel name/topic — only
-- the identifiers needed to look up a conversation_reference.

create table if not exists public.tact_runs_conversation_link_projection (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid not null references auth.users (id) on delete cascade,

  -- Mirrors @tact/execution-contract's ConversationLinkLookupInput.channel
  -- union (currently "slack" only — extend this CHECK, not the shape,
  -- when a second channel's Structural Correlator is added).
  channel text not null
    check (channel in ('slack')),

  external_workspace_id text null
    check (external_workspace_id is null or char_length(external_workspace_id) between 1 and 255),

  external_conversation_id text not null
    check (char_length(external_conversation_id) between 1 and 255),

  external_thread_id text null
    check (external_thread_id is null or char_length(external_thread_id) between 1 and 255),

  conversation_reference text not null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

create unique index if not exists idx_tact_runs_conversation_link_projection_lookup
  on public.tact_runs_conversation_link_projection (
    channel,
    coalesce(external_workspace_id, ''),
    external_conversation_id,
    coalesce(external_thread_id, '')
  );

create index if not exists idx_tact_runs_conversation_link_projection_conversation_reference
  on public.tact_runs_conversation_link_projection (conversation_reference);

create or replace function public.set_tact_runs_conversation_link_projection_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_runs_conversation_link_projection_updated_at
  on public.tact_runs_conversation_link_projection;
create trigger trg_tact_runs_conversation_link_projection_updated_at
  before update on public.tact_runs_conversation_link_projection
  for each row
  execute function public.set_tact_runs_conversation_link_projection_updated_at();

alter table public.tact_runs_conversation_link_projection enable row level security;

drop policy if exists "tact_runs_conversation_link_projection_select_own" on public.tact_runs_conversation_link_projection;
create policy "tact_runs_conversation_link_projection_select_own"
  on public.tact_runs_conversation_link_projection for select
  using (auth.uid() = user_id);

-- insert/update/delete policy intentionally absent (service-role writer
-- only, same reasoning as tact_runs_work_projection above).
