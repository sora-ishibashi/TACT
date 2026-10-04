-- =====================================================================
-- SOR-178 / SEC-8D — Immutable Security Finding -> Realtime Attention
-- =====================================================================
--
-- Strictly additive relative to migrations 00001-00014, except the two
-- explicitly-approved evolutions of the existing Attention table (the
-- UNIQUE(execution_id) index and the reason CHECK constraint — both
-- widened, never narrowed, per the Human Owner design decisions below).
--
-- Human Owner final architecture decisions (binding):
--   A. SecurityFinding is Execution-bound in v0.1 (execution_id non-null).
--      CaptureGap (SOR-136) stays its own independent ledger — never
--      converted into a SecurityFinding here.
--   B. approval_required is governance workflow, not a security
--      violation. No APPROVAL_REQUIRED finding type exists; the existing
--      approval_required Attention path is untouched.
--   C. A resolved Attention + a new eligible Finding must re-alert: at
--      most ONE ACTIVE (open/acknowledged) Attention episode exists per
--      Execution at a time, but an Execution may have many historical
--      episodes over time. Never reopen a resolved episode, never
--      regress acknowledged -> open.
--   D. A Downstream Permission Conflict Finding preserves BOTH the
--      selected Runs PermissionDecision reference AND the specific
--      DownstreamPermissionEvidence reference — they are not mutually
--      exclusive alternatives.
--   E. UNKNOWN alerting stays narrow: only built-in high-impact actions
--      (send/delete/share/execute) or an explicitly configured rule
--      (default rule set is empty, no DB-backed policy engine here).
--   F. No severity/escalation engine — findingType + eligibilityBasis are
--      the only classification.
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Minimum supporting unique indexes on existing tables (additive —
--    required BEFORE the composite FKs below so tact_execution_security_
--    findings can reference these exact column sets; also needed by the
--    link table in step 4).
-- ---------------------------------------------------------------------

alter table public.tact_execution_permission_decisions
  add constraint tact_execution_permission_decisions_id_execution_id_unique unique (id, execution_id);

alter table public.tact_execution_downstream_permission_evidence
  add constraint tact_execution_downstream_permission_evidence_id_exec_user_unique unique (id, execution_id, user_id);

alter table public.tact_execution_attentions
  add constraint tact_execution_attentions_id_user_id_unique unique (id, user_id);

-- ---------------------------------------------------------------------
-- 2. tact_execution_security_findings (append-only, no UPDATE/DELETE
--    surface anywhere in application code — see
--    packages/runs-core/tact-execution/securityFinding/store.ts)
-- ---------------------------------------------------------------------

create table public.tact_execution_security_findings (

  id uuid primary key,

  user_id uuid not null references auth.users(id) on delete cascade,

  -- Opaque alongside the composite FK below (same convention as every
  -- other tact_execution_* table in this schema) — never a bare FK to
  -- tact_canonical_executions(id) alone.
  execution_id uuid not null,

  finding_type text not null
    check (finding_type in (
      'RUNS_REGISTERED_PERMISSION_MISMATCH',
      'RUNS_REGISTERED_PERMISSION_UNKNOWN',
      'DOWNSTREAM_PERMISSION_CONFLICT'
    )),

  -- Fixed, product-neutral reasonCode vocabulary (never the underlying
  -- PermissionDecision/evidence's own free-form reasonCode) — see
  -- securityFinding/types.ts's SECURITY_FINDING_REASON_CODES.
  reason_code text not null
    check (char_length(reason_code) between 1 and 255),

  eligibility_basis text not null
    check (eligibility_basis in (
      'DEFINITE_MISMATCH', 'HIGH_IMPACT_UNKNOWN', 'CONFIGURED_UNKNOWN', 'DOWNSTREAM_CONFLICT'
    )),

  evaluator_version text not null
    check (char_length(evaluator_version) between 1 and 100),

  -- Source-observed instant (the PermissionDecision's evaluated_at, or the
  -- DownstreamPermissionEvidence's observed_at) — never execution time, and
  -- never a guessed "permission at execution time" claim (SOR-164
  -- boundary).
  detected_at timestamptz not null,

  -- Server-set only, never caller-supplied (same convention as
  -- tact_execution_downstream_permission_evidence.recorded_at).
  recorded_at timestamptz not null default now(),

  -- Non-null for ALL current finding types (section3 absolute condition).
  permission_decision_id uuid not null,

  -- Null for MISMATCH/UNKNOWN, required for DOWNSTREAM_PERMISSION_CONFLICT
  -- (enforced by CHECK below).
  downstream_permission_evidence_id uuid null,

  -- Plain text, not uuid: ConfiguredUnknownAlertRule.id is a pure
  -- in-memory configuration contract (section4), never a DB-backed row.
  -- Required only for eligibility_basis=CONFIGURED_UNKNOWN (CHECK below).
  configured_unknown_rule_id text null
    check (configured_unknown_rule_id is null or char_length(configured_unknown_rule_id) between 1 and 255),

  unique (id, user_id),

  -- Tenant-safe composite FK, same pattern as every other
  -- tact_execution_* table (relies on
  -- tact_canonical_executions_id_user_id_unique, migration 00012).
  foreign key (execution_id, user_id) references public.tact_canonical_executions(id, user_id) on delete cascade,

  -- Proves the referenced PermissionDecision belongs to the SAME
  -- Execution (relies on the new supporting unique index added below).
  foreign key (permission_decision_id, execution_id) references public.tact_execution_permission_decisions(id, execution_id) on delete cascade,

  -- MATCH SIMPLE (Postgres default): satisfied trivially when
  -- downstream_permission_evidence_id is null, exactly like the nullable
  -- effective_governance_decision_id composite FK in migration 00013.
  foreign key (downstream_permission_evidence_id, execution_id, user_id) references public.tact_execution_downstream_permission_evidence(id, execution_id, user_id) on delete cascade,

  check (
    (finding_type = 'DOWNSTREAM_PERMISSION_CONFLICT' and downstream_permission_evidence_id is not null)
    or (finding_type in ('RUNS_REGISTERED_PERMISSION_MISMATCH', 'RUNS_REGISTERED_PERMISSION_UNKNOWN') and downstream_permission_evidence_id is null)
  ),

  check (
    (eligibility_basis = 'CONFIGURED_UNKNOWN' and configured_unknown_rule_id is not null)
    or (eligibility_basis <> 'CONFIGURED_UNKNOWN' and configured_unknown_rule_id is null)
  ),

  check (
    (finding_type = 'RUNS_REGISTERED_PERMISSION_MISMATCH' and eligibility_basis = 'DEFINITE_MISMATCH')
    or (finding_type = 'RUNS_REGISTERED_PERMISSION_UNKNOWN' and eligibility_basis in ('HIGH_IMPACT_UNKNOWN', 'CONFIGURED_UNKNOWN'))
    or (finding_type = 'DOWNSTREAM_PERMISSION_CONFLICT' and eligibility_basis = 'DOWNSTREAM_CONFLICT')
  )

);

-- section7 idempotency, two independent source-backed uniqueness layers
-- (never a broad natural key across execution/provider/action/time —
-- different source evidence rows are always different Findings):
create unique index idx_security_findings_permission_source
  on public.tact_execution_security_findings (permission_decision_id, finding_type)
  where downstream_permission_evidence_id is null;

create unique index idx_security_findings_downstream_source
  on public.tact_execution_security_findings (downstream_permission_evidence_id, finding_type)
  where downstream_permission_evidence_id is not null;

create index idx_security_findings_execution_detected_at
  on public.tact_execution_security_findings (execution_id, detected_at desc);

alter table public.tact_execution_security_findings enable row level security;

create policy "tact_execution_security_findings_select_own"
  on public.tact_execution_security_findings for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy for anon or authenticated roles — the
-- write boundary is the service-role store
-- (packages/runs-core/tact-execution/securityFinding/store.ts) only, same
-- posture as tact_execution_downstream_permission_evidence (migration
-- 00014) and tact_governance_* (migration 00013).

-- ---------------------------------------------------------------------
-- 3. tact_execution_attentions evolution (section9/section10 — the only
--    two explicitly-approved changes to a pre-existing migration's
--    constraints in this file; both widen, never narrow).
-- ---------------------------------------------------------------------

-- A resolved episode must allow a later, independent episode for the same
-- Execution (DECISION C) — UNIQUE(execution_id) cannot remain. Replaced
-- with a partial unique index guaranteeing at most one ACTIVE
-- (open/acknowledged) episode per Execution at a time. No reopen
-- lifecycle is added; acknowledged/resolved CAS transition logic
-- (transitionExecutionAttention() in attentionStore.ts) is unchanged.
drop index if exists public.idx_tact_execution_attentions_execution_id;

create unique index idx_tact_execution_attentions_active_per_execution
  on public.tact_execution_attentions (execution_id)
  where status in ('open', 'acknowledged');

-- reason is the TRIGGER that created the episode, not the aggregate of all
-- Findings later attached to it (section10). Widened from 2 to 4 values;
-- stays NOT NULL (never made nullable).
alter table public.tact_execution_attentions
  drop constraint if exists tact_execution_attentions_reason_check;

alter table public.tact_execution_attentions
  add constraint tact_execution_attentions_reason_check
  check (reason in ('permission_mismatch', 'approval_required', 'permission_unknown', 'downstream_permission_conflict'));

-- ---------------------------------------------------------------------
-- 4. tact_execution_attention_findings (section11 — Finding <-> Attention
--    link; each Finding links to at most ONE Attention, enforced by the
--    primary key being finding_id itself; each Attention may have N
--    Findings).
-- ---------------------------------------------------------------------

create table public.tact_execution_attention_findings (

  finding_id uuid primary key,

  attention_id uuid not null,

  user_id uuid not null references auth.users(id) on delete cascade,

  linked_at timestamptz not null default now(),

  foreign key (finding_id, user_id) references public.tact_execution_security_findings(id, user_id) on delete cascade,

  foreign key (attention_id, user_id) references public.tact_execution_attentions(id, user_id) on delete cascade

);

create index idx_attention_findings_attention_id
  on public.tact_execution_attention_findings (attention_id);

alter table public.tact_execution_attention_findings enable row level security;

create policy "tact_execution_attention_findings_select_own"
  on public.tact_execution_attention_findings for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy for anon or authenticated roles — the
-- only writer is the ensure_security_finding_attention_link() RPC below,
-- itself restricted to service_role.

-- ---------------------------------------------------------------------
-- 5. ensure_security_finding_attention_link (section12 — atomic
--    Finding -> Attention ensure/link; the partial unique index created
--    in step 3 is the final concurrency barrier for "at most one ACTIVE
--    episode per Execution", exactly as apply_execution_work_correlation()
--    (migration 00004) uses its own unique indexes the same way).
-- ---------------------------------------------------------------------

create or replace function public.ensure_security_finding_attention_link(
  p_user_id uuid,
  p_finding_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_finding public.tact_execution_security_findings%rowtype;
  v_reason text;
  v_attention_id uuid;
  v_created boolean;
  v_linked_attention_id uuid;
begin

  select * into v_finding
  from public.tact_execution_security_findings
  where id = p_finding_id and user_id = p_user_id;

  if not found then
    return jsonb_build_object('outcome', 'finding_not_found');
  end if;

  -- Idempotent: a Finding that is already linked (duplicate RPC call,
  -- e.g. a retried observe.ts invocation) returns its existing link
  -- without attempting a second one.
  select attention_id into v_linked_attention_id
  from public.tact_execution_attention_findings
  where finding_id = p_finding_id and user_id = p_user_id;

  if v_linked_attention_id is not null then
    return jsonb_build_object('outcome', 'already_linked', 'attentionId', v_linked_attention_id);
  end if;

  -- reason is derived server-side from finding_type only (section12: "Do
  -- not accept arbitrary reason/status from the caller") — the mapping
  -- mirrors packages/runs-core/tact-execution/permission/attention.ts's
  -- AttentionReason vocabulary exactly.
  v_reason := case v_finding.finding_type
    when 'RUNS_REGISTERED_PERMISSION_MISMATCH' then 'permission_mismatch'
    when 'RUNS_REGISTERED_PERMISSION_UNKNOWN' then 'permission_unknown'
    when 'DOWNSTREAM_PERMISSION_CONFLICT' then 'downstream_permission_conflict'
  end;

  if v_reason is null then
    raise exception 'ensure_security_finding_attention_link: unknown finding_type %', v_finding.finding_type;
  end if;

  -- permission_decision_id comes from the Finding itself (never from the
  -- caller, section12). If another transaction wins the race for the
  -- partial unique active-episode index first, this INSERT does nothing
  -- and v_attention_id stays null below — never raises, never retries in
  -- a loop.
  insert into public.tact_execution_attentions (user_id, execution_id, permission_decision_id, reason)
  values (p_user_id, v_finding.execution_id, v_finding.permission_decision_id, v_reason)
  on conflict (execution_id) where (status in ('open', 'acknowledged'))
  do nothing
  returning id into v_attention_id;

  if v_attention_id is not null then

    v_created := true;

  else

    v_created := false;

    -- Lost the race (or a legacy approval_required Attention is already
    -- the ACTIVE episode) — resolve to the current ACTIVE episode and
    -- attach this Finding to it (section12: "Handle unique conflict by
    -- selecting the active row and continuing").
    select id into v_attention_id
    from public.tact_execution_attentions
    where execution_id = v_finding.execution_id
      and user_id = p_user_id
      and status in ('open', 'acknowledged')
    order by created_at desc
    limit 1;

  end if;

  if v_attention_id is null then
    -- Should not happen: the ON CONFLICT target guarantees an ACTIVE row
    -- exists whenever this INSERT did not itself win it. Never fabricate
    -- a link to a nonexistent episode.
    return jsonb_build_object('outcome', 'attention_resolution_failed');
  end if;

  insert into public.tact_execution_attention_findings (finding_id, attention_id, user_id)
  values (p_finding_id, v_attention_id, p_user_id)
  on conflict (finding_id) do nothing;

  return jsonb_build_object('outcome', 'linked', 'attentionId', v_attention_id, 'episodeCreated', v_created);

end;
$$;

revoke all on function public.ensure_security_finding_attention_link(uuid, uuid) from public;
revoke all on function public.ensure_security_finding_attention_link(uuid, uuid) from anon;
revoke all on function public.ensure_security_finding_attention_link(uuid, uuid) from authenticated;
grant execute on function public.ensure_security_finding_attention_link(uuid, uuid) to service_role;
