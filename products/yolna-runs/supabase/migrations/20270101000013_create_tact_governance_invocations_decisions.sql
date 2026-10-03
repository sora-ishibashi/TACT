-- SOR-8B: an attempt/decision ledger is intentionally separate from observed
-- Canonical Executions and their post-observation permission decisions.
create table public.tact_governance_invocations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid null,
  workspace_id uuid null,
  work_id uuid null,
  connection_id uuid null,
  actor_kind text not null check (actor_kind in ('human','ai_agent','service','connector','system')),
  actor_id text null check (actor_id is null or char_length(actor_id) between 1 and 255),
  agent_id text null check (agent_id is null or char_length(agent_id) between 1 and 255),
  on_behalf_of_actor_kind text null check (on_behalf_of_actor_kind is null or on_behalf_of_actor_kind in ('human','ai_agent','service','connector','system')),
  on_behalf_of_actor_id text null check (on_behalf_of_actor_id is null or char_length(on_behalf_of_actor_id) between 1 and 255),
  action_category text not null check (action_category in ('read','create','update','send','delete','share','execute','approve','unknown')),
  operation text not null check (char_length(operation) between 1 and 255),
  resource_type text null check (resource_type is null or char_length(resource_type) between 1 and 255),
  resource_identifier text null check (resource_identifier is null or char_length(resource_identifier) between 1 and 500),
  target_provider text null check (target_provider is null or target_provider in ('openai','anthropic','mcp','slack','gmail','google_calendar','notion','microsoft365','salesforce','custom')),
  attempted_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.tact_governance_decisions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  invocation_id uuid not null,
  evaluated_at timestamptz not null,
  actor_kind_snapshot text not null check (actor_kind_snapshot in ('human','ai_agent','service','connector','system')),
  actor_id_snapshot text null check (actor_id_snapshot is null or char_length(actor_id_snapshot) between 1 and 255),
  agent_id_snapshot text null check (agent_id_snapshot is null or char_length(agent_id_snapshot) between 1 and 255),
  on_behalf_of_actor_kind_snapshot text null check (on_behalf_of_actor_kind_snapshot is null or on_behalf_of_actor_kind_snapshot in ('human','ai_agent','service','connector','system')),
  on_behalf_of_actor_id_snapshot text null check (on_behalf_of_actor_id_snapshot is null or char_length(on_behalf_of_actor_id_snapshot) between 1 and 255),
  action_category_snapshot text not null check (action_category_snapshot in ('read','create','update','send','delete','share','execute','approve','unknown')),
  operation_snapshot text not null check (char_length(operation_snapshot) between 1 and 255),
  resource_type_snapshot text null check (resource_type_snapshot is null or char_length(resource_type_snapshot) between 1 and 255),
  resource_identifier_snapshot text null check (resource_identifier_snapshot is null or char_length(resource_identifier_snapshot) between 1 and 500),
  target_provider_snapshot text null check (target_provider_snapshot is null or target_provider_snapshot in ('openai','anthropic','mcp','slack','gmail','google_calendar','notion','microsoft365','salesforce','custom')),
  verdict text not null check (verdict in ('ALLOW','DENY','APPROVAL_REQUIRED','UNKNOWN')),
  reason_code text not null check (char_length(reason_code) between 1 and 255),
  evaluator_version text not null check (char_length(evaluator_version) between 1 and 100),
  decision_source text not null check (decision_source = 'runs_permission_registry'),
  trust_level_snapshot text not null check (trust_level_snapshot = 'INTERNAL'),
  policy_identifier_snapshot text null check (policy_identifier_snapshot is null or char_length(policy_identifier_snapshot) between 1 and 255),
  registry_rule_id_snapshot uuid null,
  registry_rule_revision_snapshot integer null check (registry_rule_revision_snapshot is null or registry_rule_revision_snapshot >= 1),
  runs_permission_snapshot jsonb not null check (octet_length(runs_permission_snapshot::text) <= 4096),
  policy_set_fingerprint text not null check (policy_set_fingerprint ~ '^[a-f0-9]{64}$'),
  approval_id text null check (approval_id is null or char_length(approval_id) between 1 and 255),
  approval_status text null check (approval_status is null or approval_status in ('approved','rejected')),
  approver_kind text null check (approver_kind is null or approver_kind in ('human','ai_agent','service','connector','system')),
  approver_id text null check (approver_id is null or char_length(approver_id) between 1 and 255),
  approved_at timestamptz null,
  created_at timestamptz not null default now(),
  foreign key (invocation_id, user_id) references public.tact_governance_invocations(id, user_id) on delete cascade,
  unique (id, user_id),
  unique (id, user_id, invocation_id)
);

create table public.tact_governance_invocation_execution_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  invocation_id uuid not null,
  effective_governance_decision_id uuid null,
  execution_id uuid not null,
  linked_at timestamptz not null default now(),
  foreign key (invocation_id, user_id) references public.tact_governance_invocations(id, user_id) on delete cascade,
  foreign key (effective_governance_decision_id, user_id, invocation_id) references public.tact_governance_decisions(id, user_id, invocation_id) on delete cascade,
  foreign key (execution_id, user_id) references public.tact_canonical_executions(id, user_id) on delete cascade,
  unique (execution_id)
);

create index idx_tact_governance_invocations_user_attempted_at on public.tact_governance_invocations(user_id, attempted_at desc);
create index idx_tact_governance_decisions_invocation_evaluated_at on public.tact_governance_decisions(invocation_id, evaluated_at desc);
create index idx_tact_governance_links_invocation_linked_at on public.tact_governance_invocation_execution_links(invocation_id, linked_at desc);

alter table public.tact_governance_invocations enable row level security;
alter table public.tact_governance_decisions enable row level security;
alter table public.tact_governance_invocation_execution_links enable row level security;
create policy "tact_governance_invocations_select_own" on public.tact_governance_invocations for select using (auth.uid() = user_id);
create policy "tact_governance_decisions_select_own" on public.tact_governance_decisions for select using (auth.uid() = user_id);
create policy "tact_governance_invocation_execution_links_select_own" on public.tact_governance_invocation_execution_links for select using (auth.uid() = user_id);
