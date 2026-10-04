-- SOR-138 Slice 2A (Human Owner approval, 2026-10-04): a separate, first-class
-- pre-execution Human Decision record. Never a widening of
-- tact_execution_attentions (that table stays POST-execution, execution_id
-- and permission_decision_id both NOT NULL by design) and never a mutation
-- of tact_governance_decisions (still append-only — this table only ever
-- references a decision, never writes into one).
--
-- Standalone Yolna Runs datastore only (this file). Not mirrored into the
-- root app's supabase/migrations/ — see SOR-189 for standalone Runs Cloud
-- Supabase provisioning, tracked separately and NOT approved by this slice.
--
-- Absolute condition (Human Owner decision 4): a row here, resolved or not,
-- is never an execution authorization token, lease, or replay/target/
-- transaction-bound grant — "approved"/"rejected" means only "a human
-- decision was recorded". Replay protection, expiry, and transaction/target
-- binding remain deferred to SOR-160 / SOR-164 / SOR-169 and later
-- mediation work; this table deliberately carries none of those columns.
create table public.tact_governance_approval_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Not a caller-chosen deterministic id (unlike tact_governance_decisions'
  -- own first-decision id) — this column's UNIQUE constraint below is the
  -- sole concurrency boundary for "at most one approval request per
  -- decision" (Human Owner decision, "CREATION SEMANTICS").
  governance_decision_id uuid not null,

  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),

  requested_at timestamptz not null default now(),

  resolved_at timestamptz null,
  -- Human-only (Human Owner correction 1, re-review): unlike every other
  -- actor_kind column in the governance tables (which accept the full
  -- human/ai_agent/service/connector/system vocabulary), this column is
  -- narrowed to the single literal 'human'. GovernanceApprovalRequest is a
  -- HUMAN approval record — an ai_agent/service/connector/system actor
  -- resolving one (self- or peer-approval) is never a legitimate outcome
  -- in this slice, so it is made unrepresentable at this layer too, not
  -- only at the TypeScript/validation layer
  -- (packages/runs-core/tact-execution/governance/types.ts's
  -- GovernanceApprovalResolver, validation.ts's
  -- validateGovernanceApprovalResolver()).
  resolved_by_actor_kind text null check (resolved_by_actor_kind is null or resolved_by_actor_kind = 'human'),
  -- Opaque text, deliberately not FK'd to auth.users (Human Owner
  -- decision): leaves room for a future externally-authenticated human
  -- identity (e.g. a Slack user id) to resolve a request without a schema
  -- change, while this CHECK still forbids it being empty/whitespace-only.
  resolved_by_actor_id text null check (resolved_by_actor_id is null or (char_length(resolved_by_actor_id) between 1 and 255 and char_length(trim(resolved_by_actor_id)) > 0)),

  created_at timestamptz not null default now(),

  foreign key (governance_decision_id, user_id) references public.tact_governance_decisions(id, user_id) on delete cascade,

  unique (governance_decision_id),

  -- Terminal-resolution coherence: a pending row has no resolver fields, a
  -- resolved row (approved/rejected) always has all three AND the resolver
  -- is specifically 'human' with a non-empty id. Prevents a terminal row
  -- from ever existing without a real human resolver identity (Human Owner
  -- decision, "RESOLVER IDENTITY" / correction 1) — enforced here as a
  -- second, DB-level guard in addition to the application-level check in
  -- packages/runs-core/tact-execution/governance/validation.ts.
  check (
    (status = 'pending' and resolved_at is null and resolved_by_actor_kind is null and resolved_by_actor_id is null)
    or
    (status != 'pending' and resolved_at is not null and resolved_by_actor_kind = 'human' and resolved_by_actor_id is not null and char_length(trim(resolved_by_actor_id)) > 0)
  )
);

create index idx_tact_governance_approval_requests_user_status on public.tact_governance_approval_requests(user_id, status);

alter table public.tact_governance_approval_requests enable row level security;

create policy "tact_governance_approval_requests_select_own"
  on public.tact_governance_approval_requests for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy, deliberately (Human Owner decision): all
-- writes stay behind the trusted service-role Runs Core boundary, same as
-- tact_governance_invocations/tact_governance_decisions/
-- tact_governance_invocation_execution_links in this same migration set.
