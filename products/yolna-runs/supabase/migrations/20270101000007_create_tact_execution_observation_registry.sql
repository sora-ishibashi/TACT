-- =====================================================================
-- Yolna Runs Standalone — Baseline Migration 7/8
-- Integration & Observation Registry (SOR-135 Phase 3)
-- =====================================================================
--
-- Consolidated from root's 20261105000000_create_tact_execution_
-- observation_registry.sql. Unchanged except cross-product FK removal:
-- connection_id referenced Yolna's tact_connections for an optional
-- connection-scoped override (not implemented by any v1 code, per the
-- root migration's own comment). Here it is a plain `uuid null` opaque
-- reference — no FK.
--
-- =====================================================================

create table if not exists public.tact_execution_observation_registry (

  id uuid not null primary key default gen_random_uuid(),

  provider text not null
    check (provider in (
      'openai', 'anthropic', 'mcp', 'slack', 'gmail',
      'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom'
    )),

  provider_label text null,

  observation_path text not null,

  action_category text not null
    check (action_category in (
      'read', 'create', 'update', 'send', 'delete', 'share', 'execute', 'approve', 'unknown'
    )),

  observation_mode text null
    check (observation_mode is null or observation_mode in ('inline', 'instrumented', 'reconciled')),

  pre_execution_visible boolean not null default false,

  can_block_or_require_approval boolean not null default false,

  principal_attribution_available boolean not null default false,

  principal_attribution_confidence text null
    check (principal_attribution_confidence is null or principal_attribution_confidence in ('none', 'low', 'medium', 'high')),

  agent_attribution_available boolean not null default false,

  agent_attribution_confidence text null
    check (agent_attribution_confidence is null or agent_attribution_confidence in ('none', 'low', 'medium', 'high')),

  work_context_carrier text not null default 'none'
    check (work_context_carrier in ('none', 'explicit_claim', 'reconciled_correlation')),

  reconciliation_available boolean not null default false,

  excludes_raw_payload boolean not null default true,

  privacy_notes text null,

  credential_custody text null,

  verification_status text not null default 'unverified'
    check (verification_status in ('live_verified', 'mock_only', 'unverified')),

  verification_note text null,

  -- Opaque reference (see header comment) — no FK.
  connection_id uuid null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()

);

create unique index if not exists idx_tact_execution_observation_registry_unique_global
  on public.tact_execution_observation_registry (provider, coalesce(provider_label, ''), observation_path, action_category)
  where connection_id is null;

create unique index if not exists idx_tact_execution_observation_registry_unique_scoped
  on public.tact_execution_observation_registry (provider, coalesce(provider_label, ''), observation_path, action_category, connection_id)
  where connection_id is not null;

create index if not exists idx_tact_execution_observation_registry_provider
  on public.tact_execution_observation_registry (provider);

alter table public.tact_execution_observation_registry enable row level security;

create policy tact_execution_observation_registry_select_authenticated
  on public.tact_execution_observation_registry
  for select
  to authenticated
  using (true);

comment on table public.tact_execution_observation_registry is
  'SOR-14/SOR-135: per (provider, observation_path, action_category) declaration of what can be observed, how, and how confidently it has been verified. Runs-owned baseline, consolidated from the root Yolna schema with the connection_id cross-product FK removed.';

-- Seed: same SOR-130 live-reality-tested baseline as the root schema —
-- this describes what Runs itself can observe about each provider path,
-- independent of which product's database it lives in.
insert into public.tact_execution_observation_registry (
  provider, provider_label, observation_path, action_category,
  observation_mode, pre_execution_visible, can_block_or_require_approval,
  principal_attribution_available, principal_attribution_confidence,
  agent_attribution_available, agent_attribution_confidence,
  work_context_carrier, reconciliation_available,
  excludes_raw_payload, privacy_notes, credential_custody,
  verification_status, verification_note
) values
  ('notion', null, 'notion-mcp-v1', 'read',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'explicit_claim', false,
   true, 'page/database content excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'live_verified', 'SOR-130 real Notion sandbox test: GET /pages/{id}'),
  ('notion', null, 'notion-mcp-v1', 'create',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'explicit_claim', false,
   true, 'page content excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'live_verified', 'SOR-130 real Notion sandbox test: POST /pages'),
  ('notion', null, 'notion-mcp-v1', 'update',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'explicit_claim', false,
   true, 'page content excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'live_verified', 'SOR-130 real Notion sandbox test: PATCH /pages/{id}'),
  ('notion', null, 'notion-mcp-v1', 'delete',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'explicit_claim', false,
   true, 'page content excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'live_verified', 'SOR-130 real Notion sandbox test: PATCH /pages/{id} (archived=true)'),
  ('slack', null, 'slack-app-mention-v1', 'create',
   'reconciled', false, true,
   true, 'high', false, 'none',
   'none', false,
   true, 'message text excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'mock_only', 'normalizeSlackExecutionEvent.ts is not wired into a production webhook route; unit-tested only'),
  ('slack', null, 'slack-web-api-v1', 'read',
   'instrumented', false, true,
   true, 'medium', false, 'none',
   'none', false,
   true, null, 'user OAuth via Composio (tact_connections)',
   'live_verified', 'SOR-130 real Slack auth.test call'),
  ('slack', null, 'slack-web-api-v1', 'send',
   'instrumented', false, true,
   true, 'medium', false, 'none',
   'none', false,
   true, 'message text excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'unverified', 'SOR-130 did not have an approved test channel; adapter exists and is mock-tested but never called live'),
  ('custom', 'github', 'github-issue-v1', 'read',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'none', false,
   true, 'issue title/body excluded from source_metadata', 'user-provided fine-grained PAT, no tact_connections record',
   'live_verified', 'SOR-130 real GitHub sandbox repo test: GET /issues/{n}'),
  ('custom', 'github', 'github-issue-v1', 'create',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'none', false,
   true, 'issue title/body excluded from source_metadata', 'user-provided fine-grained PAT, no tact_connections record',
   'live_verified', 'SOR-130 real GitHub sandbox repo test: POST /issues'),
  ('custom', 'github', 'github-issue-v1', 'update',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'none', false,
   true, 'issue title/body excluded from source_metadata', 'user-provided fine-grained PAT, no tact_connections record',
   'live_verified', 'SOR-130 real GitHub sandbox repo test: PATCH /issues/{n} (close)')
on conflict do nothing;
