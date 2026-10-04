-- =====================================================================
-- Yolna Runs Standalone — Baseline Migration 4/8
-- Work Correlation history + RPCs (SOR-135 Phase 3)
-- =====================================================================
--
-- Consolidated from root's 20261022000000 (table + correlation_status),
-- 20261023000000 (manual_override columns), and 20261025000000
-- (apply_execution_work_correlation / reclassify_execution_work RPCs +
-- enforce_tact_execution_work_assignment trigger). Correlation algorithm
-- semantics (explicit/structural/temporal_participant/ai_assisted/
-- manual_override, matched/ambiguous/unresolved, CAS, optimistic
-- concurrency, decision_fingerprint idempotency) are unchanged.
--
-- Cross-product FK removal: work_id/previous_work_id referenced Yolna's
-- tact_works. Here they are plain `uuid null` opaque references — no FK.
--
-- RPC redesign (SOR-135 Phase 3 non-negotiable): apply_execution_work_
-- correlation() and reclassify_execution_work() both validated the target
-- Work by querying `public.tact_works` directly. They now query this
-- schema's OWN public.tact_runs_work_projection instead. "Target not
-- found" now means "no projection row for that external_work_id in THIS
-- database" rather than "Work does not exist in Yolna" — Runs cannot and
-- must not tell the two apart (Never Guess Rule); both fail the
-- correlation attempt identically (target_work_not_found), exactly as
-- the root schema already treated "does not exist" and "wrong tenant"
-- identically for the same reason.
--
-- Dropped entirely: enforce_tact_execution_work_assignment (the trigger
-- that ran `select ... from tact_works ... for share` before every
-- INSERT/UPDATE of tact_canonical_executions.work_id/user_id). SOR-135
-- Phase 3 section 5's design principle — "work_id を Runs projection
-- table への必須FKにして Capture を止める設計も避けてください" — rules
-- out an equivalent trigger against tact_runs_work_projection too: a
-- Capture carrying an explicit workId must succeed even when the
-- projection for that Work has not arrived yet (normal lag, not an
-- error), so no DB-level gate may block the write. The application layer
-- (packages/runs-core's resolveTargetWorkForCorrelation(), already
-- registry-based and already fail-safe since SOR-135 Phase 1) remains the
-- only pre-flight check on captureExecution(workId) — it drops an
-- unresolvable workId rather than blocking the row, and that behavior
-- needs no DB trigger to enforce it. The correlation RPCs below still
-- validate their OWN target (that validation is a correlation DECISION,
-- which may legitimately refuse an unknown target — unlike capture,
-- which must never be blocked).
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. tact_canonical_executions.correlation_status already exists
-- (created with the table in migration 20270101000001 — the root schema
-- added it via a later ALTER TABLE; this baseline includes it from the
-- start).
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 2. tact_execution_work_correlations (history, source of truth)
-- ---------------------------------------------------------------------

create table if not exists public.tact_execution_work_correlations (

  id uuid not null primary key default gen_random_uuid(),

  execution_id uuid not null references public.tact_canonical_executions (id) on delete cascade,

  -- Opaque reference (see header comment) — no FK.
  work_id uuid null,

  status text not null
    check (status in ('matched', 'ambiguous', 'unresolved')),

  method text not null
    check (method in ('explicit', 'structural', 'temporal_participant', 'ai_assisted', 'manual_override')),

  confidence real null
    check (confidence is null or (confidence >= 0 and confidence <= 1)),

  reason_code text not null
    check (char_length(reason_code) between 1 and 255),

  correlator_version text not null
    check (char_length(correlator_version) between 1 and 100),

  candidate_work_ids uuid[] null,

  metadata jsonb null,

  -- Manual Override / Reclassification Boundary fields. Opaque reference,
  -- same reasoning as work_id.
  previous_work_id uuid null,

  changed_by_actor_kind text null
    check (
      changed_by_actor_kind is null
      or changed_by_actor_kind in ('human', 'ai_agent', 'service', 'connector', 'system')
    ),

  changed_by_actor_id text null
    check (changed_by_actor_id is null or char_length(changed_by_actor_id) between 1 and 255),

  -- Idempotency key for ambiguous/unresolved re-evaluation (see root
  -- migration 20261025000000's rationale) — NULL rows are exempt from the
  -- uniqueness check.
  decision_fingerprint text null
    check (decision_fingerprint is null or char_length(decision_fingerprint) between 1 and 128),

  correlated_at timestamptz not null default now()

);

create index if not exists idx_tact_execution_work_correlations_execution_id_correlated_at
  on public.tact_execution_work_correlations (execution_id, correlated_at desc);

create index if not exists idx_tact_execution_work_correlations_status
  on public.tact_execution_work_correlations (status);

create index if not exists idx_tact_execution_work_correlations_work_id
  on public.tact_execution_work_correlations (work_id)
  where work_id is not null;

create index if not exists idx_tact_execution_work_correlations_method
  on public.tact_execution_work_correlations (method);

create unique index if not exists idx_tact_execution_work_correlations_fingerprint
  on public.tact_execution_work_correlations (execution_id, decision_fingerprint)
  where decision_fingerprint is not null;

alter table public.tact_execution_work_correlations enable row level security;

drop policy if exists "tact_execution_work_correlations_select_own" on public.tact_execution_work_correlations;
create policy "tact_execution_work_correlations_select_own"
  on public.tact_execution_work_correlations for select
  using (
    exists (
      select 1 from public.tact_canonical_executions e
      where e.id = execution_id and e.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- 3. apply_execution_work_correlation (Auto Correlation)
-- ---------------------------------------------------------------------

create or replace function public.apply_execution_work_correlation(
  p_execution_id uuid,
  p_user_id uuid,
  p_status text,
  p_method text,
  p_reason_code text,
  p_correlator_version text,
  p_decision_fingerprint text,
  p_target_work_id uuid default null,
  p_confidence real default null,
  p_candidate_work_ids uuid[] default null,
  p_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_execution public.tact_canonical_executions%rowtype;
  v_work public.tact_runs_work_projection%rowtype;
  v_history_id uuid;
begin

  if p_status not in ('matched', 'ambiguous', 'unresolved') then
    raise exception 'apply_execution_work_correlation: invalid status %', p_status;
  end if;

  if p_status = 'matched' and p_target_work_id is null then
    raise exception 'apply_execution_work_correlation: target_work_id is required when status=matched';
  end if;

  if p_status <> 'matched' and p_target_work_id is not null then
    raise exception 'apply_execution_work_correlation: target_work_id must be null when status<>matched (Never Guess Rule)';
  end if;

  select * into v_execution
  from public.tact_canonical_executions
  where id = p_execution_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'execution_not_found');
  end if;

  if p_status = 'matched' then

    -- Target validated against THIS schema's own Work projection, not
    -- Yolna's tact_works (see header comment). "Not found" covers both
    -- "no projection row exists" (including normal projection lag) and
    -- "wrong tenant" identically, on purpose.
    select * into v_work
    from public.tact_runs_work_projection
    where external_work_id = p_target_work_id and user_id = p_user_id
    for update;

    if not found then
      return jsonb_build_object('outcome', 'target_work_not_found');
    end if;

    if v_work.status in ('completed', 'failed', 'cancelled') then
      return jsonb_build_object('outcome', 'target_work_not_correlatable');
    end if;

    if exists (
      select 1 from public.tact_execution_work_correlations
      where execution_id = p_execution_id
        and decision_fingerprint = p_decision_fingerprint
        and v_execution.work_id is null
    ) then
      return jsonb_build_object('outcome', 'duplicate_decision');
    end if;

    if v_execution.work_id is not null and v_execution.work_id <> p_target_work_id then
      return jsonb_build_object(
        'outcome', 'conflict_existing_other_work',
        'currentWorkId', v_execution.work_id
      );
    end if;

    -- Only a *confirmed* same-work match (correlation_status already
    -- 'matched') is a true idempotent retry of THIS RPC. work_id already
    -- equal to the target but correlation_status not yet 'matched' means
    -- the row reached this state via captureExecution()'s explicit-workId
    -- trusted-input path (which sets work_id directly at INSERT time and
    -- deliberately leaves correlation_status='pending' — see migration
    -- 20270101000001's header) and this RPC has never actually confirmed
    -- it yet; fall through to the normal insert+update path instead of
    -- short-circuiting (root schema's own SOR-53 Defect 2 fix, folded
    -- into this baseline from the start rather than left for this
    -- product's own future Staging to rediscover — found by this
    -- product's own Reality Test, scripts/dbRealityTest.ts, during
    -- SOR-135 Phase 3).
    if v_execution.work_id = p_target_work_id and v_execution.correlation_status = 'matched' then
      return jsonb_build_object(
        'outcome', 'already_same_work',
        'workId', v_execution.work_id
      );
    end if;

    insert into public.tact_execution_work_correlations (
      execution_id, work_id, status, method, confidence, reason_code,
      correlator_version, candidate_work_ids, metadata, correlated_at,
      decision_fingerprint
    ) values (
      p_execution_id, p_target_work_id, 'matched', p_method, p_confidence, p_reason_code,
      p_correlator_version, p_candidate_work_ids, p_metadata, now(),
      p_decision_fingerprint
    )
    returning id into v_history_id;

    -- Covers both: work_id transitioning from NULL for the first time,
    -- and work_id already equal to p_target_work_id but
    -- correlation_status not yet 'matched' (the explicit-workId case
    -- above).
    update public.tact_canonical_executions
    set work_id = p_target_work_id, correlation_status = 'matched'
    where id = p_execution_id;

    return jsonb_build_object(
      'outcome', 'correlated',
      'workId', p_target_work_id,
      'historyId', v_history_id
    );

  end if;

  -- ambiguous/unresolved path.

  if v_execution.work_id is not null then
    return jsonb_build_object(
      'outcome', 'already_matched',
      'workId', v_execution.work_id
    );
  end if;

  if exists (
    select 1 from public.tact_execution_work_correlations
    where execution_id = p_execution_id and decision_fingerprint = p_decision_fingerprint
  ) then
    return jsonb_build_object('outcome', 'duplicate_decision');
  end if;

  insert into public.tact_execution_work_correlations (
    execution_id, work_id, status, method, confidence, reason_code,
    correlator_version, candidate_work_ids, metadata, correlated_at,
    decision_fingerprint
  ) values (
    p_execution_id, null, p_status, p_method, p_confidence, p_reason_code,
    p_correlator_version, p_candidate_work_ids, p_metadata, now(),
    p_decision_fingerprint
  )
  returning id into v_history_id;

  update public.tact_canonical_executions
  set correlation_status = p_status
  where id = p_execution_id;

  return jsonb_build_object(
    'outcome', 'updated',
    'correlationStatus', p_status,
    'historyId', v_history_id
  );

end;
$$;

revoke all on function public.apply_execution_work_correlation(
  uuid, uuid, text, text, text, text, text, uuid, real, uuid[], jsonb
) from public;

grant execute on function public.apply_execution_work_correlation(
  uuid, uuid, text, text, text, text, text, uuid, real, uuid[], jsonb
) to service_role;

-- ---------------------------------------------------------------------
-- 4. reclassify_execution_work (Manual Override)
-- ---------------------------------------------------------------------

create or replace function public.reclassify_execution_work(
  p_execution_id uuid,
  p_user_id uuid,
  p_expected_previous_work_id uuid,
  p_new_work_id uuid,
  p_changed_by_actor_kind text,
  p_changed_by_actor_id text,
  p_reason_code text,
  p_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_execution public.tact_canonical_executions%rowtype;
  v_work public.tact_runs_work_projection%rowtype;
  v_history_id uuid;
  v_new_status text;
begin

  select * into v_execution
  from public.tact_canonical_executions
  where id = p_execution_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'execution_not_found');
  end if;

  if v_execution.work_id is distinct from p_expected_previous_work_id then
    return jsonb_build_object(
      'outcome', 'stale_revision',
      'actualWorkId', v_execution.work_id
    );
  end if;

  if p_new_work_id is not null then

    -- Target validated against THIS schema's own Work projection (see
    -- header comment) — a human cannot reclassify onto a Work Runs has
    -- never been told about, but "never told about" and "does not exist"
    -- are the same observable fact from here, by design.
    select * into v_work
    from public.tact_runs_work_projection
    where external_work_id = p_new_work_id and user_id = p_user_id
    for update;

    if not found then
      return jsonb_build_object('outcome', 'target_work_not_found');
    end if;

    if v_work.status in ('completed', 'failed', 'cancelled') then
      return jsonb_build_object('outcome', 'target_work_not_correlatable');
    end if;

    v_new_status := 'matched';

  else

    v_new_status := 'unresolved';

  end if;

  insert into public.tact_execution_work_correlations (
    execution_id, work_id, status, method, confidence, reason_code,
    correlator_version, candidate_work_ids, metadata, correlated_at,
    previous_work_id, changed_by_actor_kind, changed_by_actor_id
  ) values (
    p_execution_id, p_new_work_id, v_new_status, 'manual_override', null, p_reason_code,
    'manual-override-v1', null, p_metadata, now(),
    p_expected_previous_work_id, p_changed_by_actor_kind, p_changed_by_actor_id
  )
  returning id into v_history_id;

  update public.tact_canonical_executions
  set work_id = p_new_work_id, correlation_status = v_new_status
  where id = p_execution_id;

  return jsonb_build_object(
    'outcome', 'reclassified',
    'workId', p_new_work_id,
    'correlationStatus', v_new_status,
    'previousWorkId', p_expected_previous_work_id,
    'historyId', v_history_id
  );

end;
$$;

revoke all on function public.reclassify_execution_work(
  uuid, uuid, uuid, uuid, text, text, text, jsonb
) from public;

grant execute on function public.reclassify_execution_work(
  uuid, uuid, uuid, uuid, text, text, text, jsonb
) to service_role;
