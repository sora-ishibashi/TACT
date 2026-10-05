-- =====================================================================
-- Yolna Runs Standalone — Connection Projection (SOR-212)
-- =====================================================================
--
-- Runs' OWN full-snapshot copy of the minimum Connection data it needs to
-- render "権限/接続・観測" (SOR-187). Populated by an explicit Yolna ->
-- Runs projection writer (@tact/execution-contract's
-- ConnectionProjectionWriter.replaceSnapshot, implemented by this app's
-- own products/yolna-runs/lib/projection/postgresConnectionProjectionAdapter.ts),
-- never by a live cross-database join into root Yolna's tact_connections.
-- No FK references that table because, in a standalone deployment, it
-- does not exist in this database at all.
--
-- Full snapshot, not an event-only upsert (unlike
-- tact_runs_work_projection in migration 2): a projection table that has
-- never received anything, and a projection table whose canonical source
-- genuinely has zero Connections, must be distinguishable. See
-- tact_runs_connection_projection_state below — that distinction lives
-- there, not in this table's row count.
--
-- Data minimization (same non-negotiable rule as every other projection
-- table in this schema): this table holds ONLY
-- id/service/status/provider/timestamps. It must never receive
-- providerConnectionRef, metadata, provider raw status, tokens,
-- credentials, redirect URLs, or any Composio Connected Account ID — see
-- @tact/execution-contract's Connection Projection Contract header comment
-- for the authoritative forbidden-field list. There is deliberately no
-- column for any of that.
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. tact_runs_connection_projection
-- ---------------------------------------------------------------------
--
-- Primary key is the external_connection_id itself (= canonical
-- Connection.id) — the projection writer replaces rows by this value, same
-- "no separate surrogate id to keep in sync" reasoning as
-- tact_runs_work_projection's external_work_id.

create table if not exists public.tact_runs_connection_projection (

  external_connection_id uuid not null primary key,

  user_id uuid not null references auth.users (id) on delete cascade,

  service text not null
    check (char_length(service) between 1 and 100),

  -- Mirrors @tact/execution-contract's ConnectionProjectionStatus /
  -- core/tact-integration/types.ts's ConnectionStatus exactly.
  status text not null
    check (status in ('pending', 'active', 'failed', 'revoked')),

  provider text not null
    check (char_length(provider) between 1 and 100),

  -- The underlying canonical Connection row's own created_at/updated_at —
  -- distinct from projected_at below (when THIS snapshot wrote this row).
  source_created_at timestamptz not null,

  source_updated_at timestamptz not null,

  projected_at timestamptz not null default now()

);

create index if not exists idx_tact_runs_connection_projection_user_id
  on public.tact_runs_connection_projection (user_id);

alter table public.tact_runs_connection_projection enable row level security;

drop policy if exists "tact_runs_connection_projection_select_own" on public.tact_runs_connection_projection;
create policy "tact_runs_connection_projection_select_own"
  on public.tact_runs_connection_projection for select
  using (auth.uid() = user_id);

-- insert/update/delete policy intentionally absent — writes happen only
-- through replace_tact_runs_connection_projection_snapshot() below (service
-- role / SECURITY DEFINER), never a browser session, same discipline as
-- every other Runs projection table.

-- ---------------------------------------------------------------------
-- 2. tact_runs_connection_projection_state
-- ---------------------------------------------------------------------
--
-- Absolute condition (SOR-212, this migration's whole reason for
-- existing): one row per user, created ONLY once that user's first full
-- snapshot has successfully completed. Its presence is the
-- connectionReadState="available" signal; its absence is "unavailable" —
-- "a snapshot was never initialized", never confused with "zero
-- Connections". See replace_tact_runs_connection_projection_snapshot()
-- below for the ordering guarantee that keeps this row's existence/value
-- honest (it is written only after every item in that snapshot has been
-- written, within the same function/transaction).

create table if not exists public.tact_runs_connection_projection_state (

  user_id uuid not null primary key references auth.users (id) on delete cascade,

  -- The snapshotAt value the producer asserted for the most recently
  -- successfully completed snapshot (@tact/execution-contract's
  -- ConnectionProjectionSnapshotInput.snapshotAt) — not this row's own
  -- write time (see projected_at below for that).
  last_snapshot_at timestamptz not null,

  projected_at timestamptz not null

);

alter table public.tact_runs_connection_projection_state enable row level security;

drop policy if exists "tact_runs_connection_projection_state_select_own" on public.tact_runs_connection_projection_state;
create policy "tact_runs_connection_projection_state_select_own"
  on public.tact_runs_connection_projection_state for select
  using (auth.uid() = user_id);

-- insert/update/delete policy intentionally absent, same reasoning as the
-- table above — this row is written only by
-- replace_tact_runs_connection_projection_snapshot().

-- ---------------------------------------------------------------------
-- 3. replace_tact_runs_connection_projection_snapshot (atomic full replace)
-- ---------------------------------------------------------------------
--
-- Connection Projection-specific RPC only — this function never reads from
-- or writes to any canonical Connection table (there is none in this
-- database) and has no effect on canonical Connection semantics anywhere.
--
-- Atomicity (SOR-212 absolute condition "fail-closed, not fail-forward"):
-- a single function invocation is a single Postgres transaction. Delete +
-- re-insert of this user's projection rows, followed by advancing (or
-- creating) the state row, either all commit together or — if anything
-- raises (e.g. a malformed item) — none of it does, and the previously
-- visible snapshot (if any) remains exactly as it was. The state row is
-- the LAST statement in this function specifically so a partial item
-- write can never be paired with an advanced last_snapshot_at.
--
-- p_connections is a JSON array of objects shaped exactly like
-- @tact/execution-contract's ConnectionProjectionItem (camelCase keys,
-- matching the wire payload the ingestion route already validated before
-- calling this function — this function performs its own structural
-- validation too, defense in depth, since SECURITY DEFINER functions are
-- reachable by any caller holding the service_role grant).

create or replace function public.replace_tact_runs_connection_projection_snapshot(
  p_user_id uuid,
  p_snapshot_at timestamptz,
  p_connections jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_count integer := 0;
begin

  if p_connections is null or jsonb_typeof(p_connections) <> 'array' then
    raise exception 'replace_tact_runs_connection_projection_snapshot: p_connections must be a JSON array';
  end if;

  delete from public.tact_runs_connection_projection where user_id = p_user_id;

  for v_item in select * from jsonb_array_elements(p_connections)
  loop

    if v_item->>'externalConnectionId' is null
      or v_item->>'service' is null
      or v_item->>'status' is null
      or v_item->>'provider' is null
      or v_item->>'createdAt' is null
      or v_item->>'updatedAt' is null
    then
      raise exception 'replace_tact_runs_connection_projection_snapshot: connection item missing a required field';
    end if;

    insert into public.tact_runs_connection_projection (
      external_connection_id, user_id, service, status, provider,
      source_created_at, source_updated_at, projected_at
    ) values (
      (v_item->>'externalConnectionId')::uuid,
      p_user_id,
      v_item->>'service',
      v_item->>'status',
      v_item->>'provider',
      (v_item->>'createdAt')::timestamptz,
      (v_item->>'updatedAt')::timestamptz,
      now()
    );

    v_count := v_count + 1;

  end loop;

  insert into public.tact_runs_connection_projection_state (user_id, last_snapshot_at, projected_at)
  values (p_user_id, p_snapshot_at, now())
  on conflict (user_id) do update
    set last_snapshot_at = excluded.last_snapshot_at,
        projected_at = excluded.projected_at;

  return jsonb_build_object('outcome', 'replaced', 'count', v_count);

end;
$$;

revoke all on function public.replace_tact_runs_connection_projection_snapshot(uuid, timestamptz, jsonb) from public;

grant execute on function public.replace_tact_runs_connection_projection_snapshot(uuid, timestamptz, jsonb) to service_role;
