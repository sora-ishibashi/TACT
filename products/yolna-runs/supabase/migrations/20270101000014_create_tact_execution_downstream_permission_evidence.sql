-- SOR-177 / SEC-8C: Downstream Permission Evidence is a fourth, independent
-- fact — separate from Observed Action (tact_canonical_executions), Runs
-- Registered Permission (tact_execution_permission_decisions), and Runs
-- Governance (tact_governance_*). It records what an external/downstream
-- system actually says about a permission, and is never summarized onto,
-- or derived into, any of those three existing tables.
--
-- Append-only, same shape as tact_governance_* (migration 00013): caller-
-- generated id, no update/delete surface, service-role write boundary only.
-- Multiple rows per execution are expected and intentional — a later
-- independent observation is always a new audit fact, never a replacement
-- for an earlier one. No natural-key uniqueness beyond the primary key.
--
-- Trust (trust_level) and authority (authority_level) are independent axes
-- (Human Owner section5): an AUTHENTICATED source can still be
-- NON_AUTHORITATIVE. AUTHORITATIVE is never inferred from trust_level — it
-- is only ever asserted explicitly by the caller.

create table public.tact_execution_downstream_permission_evidence (

  id uuid primary key,

  user_id uuid not null references auth.users(id) on delete cascade,

  execution_id uuid not null,

  target_provider text not null
    check (target_provider in ('openai','anthropic','mcp','slack','gmail','google_calendar','notion','microsoft365','salesforce','custom')),

  -- Opaque reference (no FK) — same convention as
  -- tact_execution_permission_rules.connection_id (migration 00003):
  -- nothing in Runs Core resolves Connection details beyond storing this id.
  connection_id uuid null,

  subject_kind text not null
    check (subject_kind in ('human','ai_agent','service','connector','system')),

  subject_id text null
    check (subject_id is null or char_length(subject_id) between 1 and 255),

  -- SOR-177 Human Owner section4: retained so two agents under the same
  -- principal are never silently conflated, matching how the Runs
  -- Permission Registry itself can scope rules by agent_id.
  agent_id text null
    check (agent_id is null or char_length(agent_id) between 1 and 255),

  action_category text not null
    check (action_category in ('read','create','update','send','delete','share','execute','approve','unknown')),

  operation text not null
    check (char_length(operation) between 1 and 255),

  resource_type text null
    check (resource_type is null or char_length(resource_type) between 1 and 255),

  resource_identifier text null
    check (resource_identifier is null or char_length(resource_identifier) between 1 and 500),

  permission_state text not null
    check (permission_state in ('allowed','denied','unknown')),

  -- Free-form, provider-neutral evidence mechanism identifier (e.g.
  -- 'provider_acl', 'connector_assertion', 'actor_self_report',
  -- 'provider_audit'). Deliberately not a Core enum — no provider-specific
  -- ACL connector exists yet, and this column must not force one into
  -- existence prematurely.
  source_type text not null
    check (char_length(source_type) between 1 and 100),

  -- Opaque pointer into the evidence mechanism (e.g. an external ACL-check
  -- call id or audit-log row id). Never a credential — see the "no secret
  -- columns" check below.
  source_identifier text null
    check (source_identifier is null or char_length(source_identifier) between 1 and 500),

  authority_level text not null
    check (authority_level in ('AUTHORITATIVE','NON_AUTHORITATIVE','UNKNOWN')),

  trust_level text not null
    check (trust_level in ('UNTRUSTED','AUTHENTICATED','INTERNAL')),

  -- When the evidence source says this was true. Never claims "permission
  -- at execution time" — see compare.ts's temporal-relation comment and the
  -- SOR-164 boundary (transaction-bound authorization is explicitly out of
  -- scope here).
  observed_at timestamptz not null,

  -- Server-set only; never caller-supplied (SOR-177 section4).
  recorded_at timestamptz not null default now(),

  -- Bounded, guarded the same way as tact_execution_permission_decisions
  -- .metadata and tact_governance_decisions.runs_permission_snapshot
  -- (findSuspiciousExecutionMetadataKeys() in application code, 4096 bytes
  -- here).
  evidence_snapshot jsonb null
    check (evidence_snapshot is null or octet_length(evidence_snapshot::text) <= 4096),

  -- Tenant-safe composite FK, same pattern as tact_governance_invocations
  -- and tact_telemetry_receipt_execution_links: relies on
  -- tact_canonical_executions_id_user_id_unique (migration 00012).
  foreign key (execution_id, user_id) references public.tact_canonical_executions(id, user_id) on delete cascade

  -- Deliberately no unique index on (execution_id, source_type) or
  -- (execution_id, source_identifier): a later independent observation of
  -- the same execution/source is a new audit fact, not a duplicate to
  -- collapse (SOR-177 section9).

);

create index idx_downstream_evidence_execution_recorded_at
  on public.tact_execution_downstream_permission_evidence (execution_id, recorded_at desc);

create index idx_downstream_evidence_user_observed_at
  on public.tact_execution_downstream_permission_evidence (user_id, observed_at desc);

alter table public.tact_execution_downstream_permission_evidence enable row level security;

create policy "tact_execution_downstream_permission_evidence_select_own"
  on public.tact_execution_downstream_permission_evidence for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy for anon or authenticated roles — the
-- write boundary is the service-role store in store.ts only (same posture
-- as tact_governance_* in migration 00013).
