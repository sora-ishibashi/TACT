-- =====================================================================
-- Yolna Runs Standalone — Baseline Migration 2/8
-- Permission Registry + Permission Decisions (SOR-135 Phase 3)
-- =====================================================================
--
-- Consolidated from root's 20261030000000_create_tact_execution_
-- permission_rules.sql, 20261021000000_create_tact_execution_permission_
-- decisions.sql, and 20261031000000_add_registry_fields_to_tact_execution_
-- permission_decisions.sql. Logic/vocabulary unchanged.
--
-- Cross-product FK removal: tact_execution_permission_rules.connection_id
-- referenced Yolna's tact_connections. Here it is a plain `uuid null`
-- opaque reference — no FK. Nothing in Runs Core currently resolves
-- Connection details beyond storing this id for optional future
-- connection-scoped rule overrides (SOR-47 v1 does not implement that
-- resolution either, per the root migration's own comment) — there is no
-- Connection Projection to join against yet, and none is added here
-- speculatively.
--
-- registry_rule_id (on permission_decisions) stays a real FK — it points
-- at this schema's OWN tact_execution_permission_rules, not a
-- cross-product table, so it is not a boundary violation.
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. tact_execution_permission_rules
-- ---------------------------------------------------------------------

create table if not exists public.tact_execution_permission_rules (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid null references auth.users (id) on delete cascade,

  identifier text not null
    check (char_length(identifier) between 1 and 255),

  revision integer not null default 1
    check (revision >= 1),

  subject_kind text null
    check (subject_kind is null or subject_kind in ('human', 'ai_agent', 'service', 'connector', 'system')),

  actor_id text null
    check (actor_id is null or char_length(actor_id) between 1 and 255),

  agent_id text null
    check (agent_id is null or char_length(agent_id) between 1 and 255),

  provider text null
    check (provider is null or provider in ('openai', 'anthropic', 'mcp', 'slack', 'gmail', 'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom')),

  target_provider text null
    check (target_provider is null or target_provider in ('openai', 'anthropic', 'mcp', 'slack', 'gmail', 'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom')),

  resource_type text null
    check (resource_type is null or char_length(resource_type) between 1 and 255),

  action_category text null
    check (action_category is null or action_category in ('read', 'create', 'update', 'send', 'delete', 'share', 'execute', 'approve', 'unknown')),

  decision text not null
    check (decision in ('allowed', 'denied', 'approval_required')),

  reason_code text not null
    check (char_length(reason_code) between 1 and 255),

  requires_known_actor_id boolean not null default false,

  requires_known_agent_id boolean not null default false,

  -- Opaque reference (see header comment) — no FK.
  connection_id uuid null,

  priority integer not null default 0
    check (priority >= 0),

  valid_from timestamptz null,
  valid_until timestamptz null,

  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()

);

create unique index if not exists idx_tact_execution_permission_rules_tenant_identifier
  on public.tact_execution_permission_rules (user_id, identifier)
  where user_id is not null;

create unique index if not exists idx_tact_execution_permission_rules_global_identifier
  on public.tact_execution_permission_rules (identifier)
  where user_id is null;

create index if not exists idx_tact_execution_permission_rules_lookup
  on public.tact_execution_permission_rules (user_id, enabled, priority);

create index if not exists idx_tact_execution_permission_rules_validity
  on public.tact_execution_permission_rules (valid_from, valid_until);

alter table public.tact_execution_permission_rules enable row level security;

drop policy if exists "tact_execution_permission_rules_select_own_or_global" on public.tact_execution_permission_rules;
create policy "tact_execution_permission_rules_select_own_or_global"
  on public.tact_execution_permission_rules for select
  using (user_id = auth.uid() or user_id is null);

-- Seed: same global-fallback rule set as the root Yolna schema (this is
-- Runs' own default policy baseline, not Yolna business logic — it
-- reproduces registryEvaluate.ts's expected seeded-registry equivalence).
insert into public.tact_execution_permission_rules
  (user_id, identifier, subject_kind, provider, target_provider, resource_type, action_category, decision, reason_code, requires_known_actor_id, requires_known_agent_id, priority)
values
  (null, 'human-slack-mention-allowed', 'human', 'slack', null, 'slack_message', 'create', 'allowed', 'human_slack_mention_allowed', false, false, 0),
  (null, 'ai-agent-slack-channel-read-allowed', 'ai_agent', 'slack', null, 'slack_channel', 'read', 'allowed', 'ai_agent_slack_channel_read_allowed', false, false, 1),
  (null, 'ai-agent-slack-message-send-denied', 'ai_agent', 'slack', null, 'slack_message', 'send', 'denied', 'ai_agent_slack_message_send_denied', false, false, 2),
  (null, 'notion-ai-agent-read-allowed', 'ai_agent', null, 'notion', null, 'read', 'allowed', 'notion_m0_read_allowed', true, true, 3),
  (null, 'notion-ai-agent-create-page-allowed', 'ai_agent', null, 'notion', null, 'create', 'allowed', 'notion_m0_create_page_allowed', true, true, 4),
  (null, 'notion-ai-agent-update-page-approval-required', 'ai_agent', null, 'notion', null, 'update', 'approval_required', 'notion_m0_update_page_approval_required', true, true, 5),
  (null, 'notion-ai-agent-delete-page-denied', 'ai_agent', null, 'notion', null, 'delete', 'denied', 'notion_m0_delete_page_forbidden', true, true, 6)
on conflict (identifier) where user_id is null do nothing;

-- ---------------------------------------------------------------------
-- 2. tact_execution_permission_decisions (history, source of truth)
-- ---------------------------------------------------------------------

create table if not exists public.tact_execution_permission_decisions (

  id uuid not null primary key default gen_random_uuid(),

  execution_id uuid not null references public.tact_canonical_executions (id) on delete cascade,

  -- 'approval_required' included from the start (root schema added it via
  -- a later ALTER — SOR-51 M-0's "Do not flatten approval into denied").
  status text not null
    check (status in ('allowed', 'denied', 'unknown', 'approval_required')),

  reason_code text not null
    check (char_length(reason_code) between 1 and 255),

  policy_id text not null
    check (char_length(policy_id) between 1 and 255),

  evaluator_version text not null
    check (char_length(evaluator_version) between 1 and 100),

  metadata jsonb null,

  -- Real FK to this schema's OWN permission_rules table (not
  -- cross-product) — historical explainability (SOR-47).
  registry_rule_id uuid null
    references public.tact_execution_permission_rules (id) on delete set null,

  registry_rule_revision integer null
    check (registry_rule_revision is null or registry_rule_revision >= 1),

  evaluated_at timestamptz not null default now()

);

create unique index if not exists idx_tact_execution_permission_decisions_idempotency
  on public.tact_execution_permission_decisions (execution_id, evaluator_version, policy_id);

create index if not exists idx_tact_execution_permission_decisions_execution_id_evaluated_at
  on public.tact_execution_permission_decisions (execution_id, evaluated_at desc);

create index if not exists idx_tact_execution_permission_decisions_status
  on public.tact_execution_permission_decisions (status);

create index if not exists idx_tact_execution_permission_decisions_registry_rule_id
  on public.tact_execution_permission_decisions (registry_rule_id)
  where registry_rule_id is not null;

alter table public.tact_execution_permission_decisions enable row level security;

drop policy if exists "tact_execution_permission_decisions_select_own" on public.tact_execution_permission_decisions;
create policy "tact_execution_permission_decisions_select_own"
  on public.tact_execution_permission_decisions for select
  using (
    exists (
      select 1 from public.tact_canonical_executions e
      where e.id = execution_id and e.user_id = auth.uid()
    )
  );
