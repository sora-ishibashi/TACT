-- =====================================================================
-- Yolna Runs Standalone — Principal Registry (SOR-260 Phase 1)
-- =====================================================================
--
-- Separates "an authenticated source asserted this subject identifier"
-- (external_subject) from "a Runs-local Supabase Auth login"
-- (local_runs_user). Governance (Preflight/Complete) previously stored a
-- caller-supplied userId DIRECTLY as the user_id FK to auth.users on six
-- tables — which only worked when that id happened to already exist as a
-- Runs auth.users row. An external producer (e.g. root Yolna) asserting
-- its own tenant userId has no such row, by design (SOR-260: "do not
-- mirror external auth users into Runs' own auth.users").
--
-- Phase 1 scope (Option B, governance-only — SOR-260 design audit
-- Revision 2 §15): this migration creates the registry and retargets
-- EXACTLY the six user_id FKs on the Preflight -> Decision -> Complete ->
-- CanonicalExecution -> GovernanceExecutionLink -> ApprovalRequest path.
-- It does NOT touch Work/Connection/Conversation Projection, telemetry,
-- attention provenance, ingestion/capture coverage, security findings, or
-- downstream permission evidence — those remain Phase 2 (16 of the 22
-- auth.users-coupled columns catalogued in the design audit), and
-- Workspace/Membership/RBAC (SOR-224) remains a separate, later tenant
-- boundary this migration does not anticipate.
--
-- Trust boundary this registry formalizes (SOR-260 Human Owner decision
-- 10, exact wording to preserve in docs/tests — do not restate this more
-- strongly than it actually is): resolving a principal here proves only
-- that an authenticated source asserted a subject identifier within its
-- own namespace. It does NOT independently prove that subject exists in
-- the source product.
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. tact_runs_principals
-- ---------------------------------------------------------------------
--
-- namespace: a stable LOGICAL source-system identity (e.g. the root
-- Yolna deployment's registered governance callerId), never a rotatable
-- credential/keyId and never a per-request value. 'runs-local-auth' is
-- RESERVED for principals backed by a genuine Runs Supabase Auth login
-- (see steps 3/4) — an external governance caller can never resolve into
-- that namespace (enforced both by the CHECK constraint below and, as a
-- second independent layer, by packages/runs-core/tact-execution/
-- principal/store.ts's resolveOrCreateExternalPrincipal(), which always
-- inserts principal_kind='external_subject' and rejects that namespace
-- value before ever reaching this table).
--
-- external_subject_id: the subject identifier the authenticated source
-- asserts, opaque to Runs — never independently verified against the
-- source product.
--
-- local_auth_user_id: set only for principal_kind='local_runs_user',
-- linking back to this deployment's own auth.users row. ON DELETE SET
-- NULL (not CASCADE, not RESTRICT): deleting the Supabase Auth login
-- must never delete or block-delete the principal row itself, because
-- six history/evidence tables below now key off THIS table's id, not
-- auth.users directly — the whole point of this migration is that
-- deleting a login identity must stop cascading into governance/
-- execution history. The CHECK constraint below is written to tolerate
-- local_auth_user_id transitioning from the auth user's id to NULL
-- (detach) without the row ever violating a CHECK — it does not require
-- local_auth_user_id to stay NOT NULL once set.
create table public.tact_runs_principals (

  id uuid primary key default gen_random_uuid(),

  namespace text not null
    check (char_length(namespace) between 1 and 255
           and char_length(trim(namespace)) > 0),

  external_subject_id text not null
    check (char_length(external_subject_id) between 1 and 255
           and char_length(trim(external_subject_id)) > 0),

  local_auth_user_id uuid null
    references auth.users (id)
    on delete set null,

  principal_kind text not null
    check (principal_kind in ('local_runs_user', 'external_subject')),

  created_at timestamptz not null default now(),

  unique (namespace, external_subject_id),

  -- Local-auth detach lifecycle (SOR-260 Human Owner decision 3,
  -- correcting Revision 1's contradiction): a local_runs_user principal's
  -- own natural key is pinned to its own id (namespace='runs-local-auth',
  -- external_subject_id=id::text) for its entire lifetime regardless of
  -- local_auth_user_id. local_auth_user_id itself is allowed to be either
  -- still-linked (= id, the backfilled/initial state) or detached (null,
  -- after the underlying auth.users row is deleted) — both are valid
  -- states for the SAME row, so this CHECK can never be violated by the
  -- ON DELETE SET NULL above. An external_subject principal is barred
  -- from the reserved namespace and can never carry a local_auth_user_id.
  check (
    (
      principal_kind = 'local_runs_user'
      and namespace = 'runs-local-auth'
      and external_subject_id = id::text
      and (local_auth_user_id is null or local_auth_user_id = id)
    )
    or
    (
      principal_kind = 'external_subject'
      and namespace <> 'runs-local-auth'
      and local_auth_user_id is null
    )
  )

);

-- Separate partial unique index (PostgreSQL has no inline partial-UNIQUE
-- table-constraint form) — at most one principal row may still be linked
-- to a given auth.users row; once detached (null), any number of rows
-- may have previously detached from different/same former logins.
create unique index tact_runs_principals_local_auth_user_id_key
  on public.tact_runs_principals (local_auth_user_id)
  where local_auth_user_id is not null;

-- ---------------------------------------------------------------------
-- 2. RLS — service-role only (SOR-260 Human Owner decision 7)
-- ---------------------------------------------------------------------
--
-- Identity-sensitive by nature; ZERO anon/authenticated SELECT/INSERT/
-- UPDATE/DELETE policy in Phase 1 (same "no policy for an operation
-- nobody is meant to use directly" discipline as every other Runs
-- governance/projection table — e.g. tact_governance_invocations,
-- tact_runs_work_projection). Principal resolve/create stays
-- service-role-only; a future SOR-224 phase may add Workspace/
-- Membership-aware read semantics — not anticipated here.
alter table public.tact_runs_principals enable row level security;

-- ---------------------------------------------------------------------
-- 3. Future auth.users creation becomes Principal-safe (pre-commit
--    review fix — the migration-time backfill in step 4 below only
--    covers auth.users rows that exist AT MIGRATION TIME; Standalone
--    Runs has a real signup path — products/yolna-runs/components/auth/
--    AuthProvider.tsx's signUp(), supabase.auth.signUp() — and any
--    future auth-user-creation path (admin-created users, a future
--    Magic Link/OAuth flow) creates auth.users rows this migration can
--    never see. Without this trigger, a user created the moment AFTER
--    this migration commits would have no tact_runs_principals row,
--    and their first write into any of the six tables below would fail
--    the new FK in step 6 — a DB-owned invariant must cover every
--    future auth.users insert, not just a one-time snapshot, and not
--    only the one known UI entry point (AuthProvider.tsx is not and
--    must not become the enforcement boundary for this invariant).
-- ---------------------------------------------------------------------
--
-- Installed BEFORE the backfill (step 4) and BEFORE the FK retarget
-- (step 6), inside this same migration transaction, so no auth.users
-- row — existing or created after this point — can ever end up without
-- a matching principal once this migration commits.
--
-- security definer + fixed search_path (same convention as this schema's
-- existing internal primitives — see 20270101000004's
-- apply_execution_work_correlation/reclassify_execution_work): every
-- referenced relation is fully qualified, there is no dynamic SQL, and
-- EXECUTE is revoked from public/anon/authenticated below (defense in
-- depth — Postgres already refuses to let any role invoke a trigger
-- function directly outside trigger-firing context, since it returns
-- the pseudo-type `trigger`; this closes the privilege on the function
-- object itself rather than relying on that alone).
create function public.tact_runs_principals_bootstrap_local_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.tact_runs_principals;
begin

  -- NEW.id is exactly and only the new principal's id — never a fresh
  -- gen_random_uuid(), never caller-influenced (this function reads no
  -- argument, only the auth.users row Postgres itself just inserted).
  -- principal_kind is hardcoded 'local_runs_user'; this trigger can
  -- never create an external_subject row. ON CONFLICT targets the
  -- primary key only — it never touches the (namespace,
  -- external_subject_id) unique constraint, so it can only ever no-op
  -- against a PRE-EXISTING row at this exact id, never silently adopt
  -- or merge into an unrelated principal.
  insert into public.tact_runs_principals (id, namespace, external_subject_id, local_auth_user_id, principal_kind)
  values (new.id, 'runs-local-auth', new.id::text, new.id, 'local_runs_user')
  on conflict (id) do nothing;

  select * into v_existing from public.tact_runs_principals where id = new.id;

  -- Fail closed on an impossible id/natural-key conflict (pre-commit
  -- review requirement): the only way v_existing can fail this shape
  -- check is a pre-existing row at this exact uuid that is NOT the row
  -- this trigger itself just ensured — e.g. an external_subject
  -- principal whose DB-generated id happens to collide with this new
  -- auth.users.id (astronomically unlikely, never silently accepted),
  -- or a local_runs_user row already linked to a DIFFERENT auth user at
  -- this id (should be structurally impossible given auth.users.id is
  -- itself a primary key). Raising here aborts the triggering
  -- auth.users insert entirely — this trigger never overwrites, never
  -- relinks, and never reinterprets an incompatible existing row.
  if v_existing.namespace is distinct from 'runs-local-auth'
     or v_existing.external_subject_id is distinct from new.id::text
     or v_existing.principal_kind is distinct from 'local_runs_user'
     or v_existing.local_auth_user_id is distinct from new.id
  then
    raise exception
      'tact_runs_principals bootstrap: auth.users.id % already maps to an incompatible principal (namespace=%, principal_kind=%, local_auth_user_id=%)',
      new.id, v_existing.namespace, v_existing.principal_kind, v_existing.local_auth_user_id;
  end if;

  return new;

end;
$$;

revoke execute on function public.tact_runs_principals_bootstrap_local_auth_user() from public;
revoke execute on function public.tact_runs_principals_bootstrap_local_auth_user() from anon;
revoke execute on function public.tact_runs_principals_bootstrap_local_auth_user() from authenticated;

drop trigger if exists trg_tact_runs_principals_bootstrap_local_auth_user on auth.users;
create trigger trg_tact_runs_principals_bootstrap_local_auth_user
  after insert on auth.users
  for each row
  execute function public.tact_runs_principals_bootstrap_local_auth_user();

-- ---------------------------------------------------------------------
-- 4. Backfill — one principal per existing Runs-local auth user
-- ---------------------------------------------------------------------
--
-- id is explicitly pinned to auth.users.id (not left to the column
-- default) so principal.id = auth.users.id holds for every existing
-- local row — the invariant every existing `auth.uid() = user_id` RLS
-- policy on the six Phase-1 tables below depends on continuing to work
-- unchanged after the FK retarget in step 7. ON CONFLICT (id) DO NOTHING
-- makes this safe to run after step 3's trigger is already installed:
-- within this migration's own transaction no other session's insert is
-- visible here regardless, but this keeps the statement correct and
-- idempotent on its own terms rather than depending on that fact.
insert into public.tact_runs_principals (id, namespace, external_subject_id, local_auth_user_id, principal_kind)
select id, 'runs-local-auth', id::text, id, 'local_runs_user'
from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 5. Fail-fast backfill verification (before any FK is touched)
-- ---------------------------------------------------------------------
--
-- Every user_id value already present on the six Phase-1 tables was
-- already guaranteed to exist in auth.users by the FK being replaced
-- below, and step 4 (helped by step 3's trigger for anything created
-- since) ensures exactly one principal per auth.users row with
-- id = auth.users.id — so this should never actually fire. It
-- exists as a hard, named stop rather than letting a missed edge case
-- surface later as a confusing ALTER TABLE failure.
do $$
declare
  missing_count integer;
begin

  select count(*) into missing_count
  from (
    select user_id from public.tact_canonical_executions
    union
    select user_id from public.tact_execution_permission_rules where user_id is not null
    union
    select user_id from public.tact_governance_invocations
    union
    select user_id from public.tact_governance_decisions
    union
    select user_id from public.tact_governance_invocation_execution_links
    union
    select user_id from public.tact_governance_approval_requests
  ) as existing_user_ids
  left join public.tact_runs_principals p on p.id = existing_user_ids.user_id
  where p.id is null;

  if missing_count > 0 then
    raise exception
      'SOR-260 Phase 1 backfill incomplete: % existing Phase-1 user_id value(s) have no matching tact_runs_principals.id',
      missing_count;
  end if;

end $$;

-- ---------------------------------------------------------------------
-- 6. FK retarget — exactly the six Phase-1 columns, all RESTRICT
-- ---------------------------------------------------------------------
--
-- RESTRICT, not CASCADE (SOR-260 Human Owner decision 2, uniform across
-- all six): principal rows are not expected to be deleted in normal
-- operation; RESTRICT forces an explicit decision rather than silently
-- cascading away governance/execution evidence if one ever were. This
-- directly fixes the prior defect where the same six columns' ON DELETE
-- CASCADE against auth.users meant deleting a login identity deleted
-- that user's entire governance/execution history outright.
--
-- Composite intra-schema FKs that already key off these same tables'
-- own (id, user_id) unique constraints (e.g. tact_governance_decisions'
-- foreign key (invocation_id, user_id) references
-- tact_governance_invocations(id, user_id)) reference auth.users nowhere
-- and need no change here — they only require the same user_id value on
-- both sides of their own join, which is untouched by this retarget.
--
-- Original constraint names were never overridden at creation (inline
-- column-level `references`), so Postgres' default
-- <table>_<column>_fkey naming applies — `if exists` guards this
-- migration the same way 20260820000000_conversations_user_id_fk_to_
-- auth_users.sql already does for an equivalent retarget.

alter table public.tact_canonical_executions
  drop constraint if exists tact_canonical_executions_user_id_fkey,
  add constraint tact_canonical_executions_user_id_fkey
    foreign key (user_id) references public.tact_runs_principals (id) on delete restrict;

alter table public.tact_execution_permission_rules
  drop constraint if exists tact_execution_permission_rules_user_id_fkey,
  add constraint tact_execution_permission_rules_user_id_fkey
    foreign key (user_id) references public.tact_runs_principals (id) on delete restrict;

alter table public.tact_governance_invocations
  drop constraint if exists tact_governance_invocations_user_id_fkey,
  add constraint tact_governance_invocations_user_id_fkey
    foreign key (user_id) references public.tact_runs_principals (id) on delete restrict;

alter table public.tact_governance_decisions
  drop constraint if exists tact_governance_decisions_user_id_fkey,
  add constraint tact_governance_decisions_user_id_fkey
    foreign key (user_id) references public.tact_runs_principals (id) on delete restrict;

alter table public.tact_governance_invocation_execution_links
  drop constraint if exists tact_governance_invocation_execution_links_user_id_fkey,
  add constraint tact_governance_invocation_execution_links_user_id_fkey
    foreign key (user_id) references public.tact_runs_principals (id) on delete restrict;

alter table public.tact_governance_approval_requests
  drop constraint if exists tact_governance_approval_requests_user_id_fkey,
  add constraint tact_governance_approval_requests_user_id_fkey
    foreign key (user_id) references public.tact_runs_principals (id) on delete restrict;

-- ---------------------------------------------------------------------
-- 7. RLS on the six retargeted tables: unchanged, deliberately
-- ---------------------------------------------------------------------
--
-- Every existing `auth.uid() = user_id` SELECT-own policy on these six
-- tables continues to hold for Runs-local principals without editing a
-- single policy: steps 3/4 pin principal.id = auth.users.id (for future
-- and existing rows respectively), so the stored user_id value these
-- policies compare against auth.uid() never
-- changes — only which table validates that value via FK changes. No
-- policy on tact_canonical_executions, tact_execution_permission_rules,
-- tact_governance_invocations, tact_governance_decisions,
-- tact_governance_invocation_execution_links, or
-- tact_governance_approval_requests is touched by this migration.
