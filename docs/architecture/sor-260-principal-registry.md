# Standalone Runs — Principal Registry (SOR-260 Phase 1)

Status: describes the Phase 1 implementation as actually landed. This is an
architecture reference, not a design proposal — the full design audit and
its revisions live in the SOR-260 Linear issue and this repository's PR
history, not here. This document records what exists, not what is planned.

## 1. Problem this phase closes

Standalone Runs and root Yolna are separate Supabase projects. Before this
phase, six Standalone Runs tables stored a caller-supplied `user_id` as a
**direct foreign key to Runs' own `auth.users`**:

```
tact_canonical_executions.user_id
tact_execution_permission_rules.user_id
tact_governance_invocations.user_id
tact_governance_decisions.user_id
tact_governance_invocation_execution_links.user_id
tact_governance_approval_requests.user_id
```

An external caller (root Yolna, asserting its own tenant user id through the
signed Governance Preflight/Complete envelope) has no reason to have a
matching row in Runs' own `auth.users` — by design, Standalone Runs never
mirrors another product's auth users into its own (see SOR-260's own
rationale: per-producer auth-user sync, Runs-local login identity confused
with external/root principal identity, and unclear cross-project delete
semantics are all rejected outcomes). Without a Principal Registry, an
external Preflight/Complete call against those six tables fails on an
ordinary foreign-key violation.

## 2. What this phase adds

`tact_runs_principals` (new table,
`products/yolna-runs/supabase/migrations/20270101000019_create_tact_runs_principals.sql`):

```
id                 uuid primary key default gen_random_uuid()
namespace          text not null   -- stable logical source identity
external_subject_id text not null  -- opaque subject id within that namespace
local_auth_user_id uuid null references auth.users(id) on delete set null
principal_kind     text not null   -- 'local_runs_user' | 'external_subject'
created_at         timestamptz not null default now()

unique (namespace, external_subject_id)
unique index on local_auth_user_id where local_auth_user_id is not null
```

The six tables above are retargeted (one migration, `DROP CONSTRAINT IF
EXISTS` / `ADD CONSTRAINT ... REFERENCES tact_runs_principals(id) ON DELETE
RESTRICT`) to reference this table instead of `auth.users` directly.
`RESTRICT`, not the previous `CASCADE` — deleting a principal is not a normal
operation, and should never silently cascade away governance/execution
history.

## 3. Namespace vs. keyId — do not conflate

Governance's existing HMAC transport (`runsGovernanceAuth.ts`,
`RUNS_GOVERNANCE_HMAC_KEYS_JSON`, keyed `"<callerId>:<keyId>"`) already
separates two identities that this phase now also treats as distinct:

- **`callerId`** — the registered deployment's stable logical source
  identity (e.g. `"yolna-root-staging"`). This becomes a Principal's
  `namespace`. It must survive key rotation, process restart, and deployment
  replacement.
- **`keyId`** — the rotatable credential used only to select which HMAC key
  verifies a given request's signature. It has no bearing on `namespace` and
  may change independently.

A Reality-Test fixture caller id (e.g. `sor-138-3a4-local`) is a `keyId`-like
operational detail, never a permanent `namespace` value — using it as one
would create a second, spurious principal for what is really the same
logical source once the real producer's caller id is wired in.

## 4. Resolution flow

Both Governance routes (`app/api/tact/runs/governance/preflight/route.ts`,
`.../complete/route.ts`) now resolve a principal between authentication and
the Core call:

```
HMAC verify() -> { callerId, keyId }      (keyId used only to pick the verification key)
                     |
                     v
resolveOrCreateExternalPrincipal(callerId, envelope.onBehalfOfUserId)
                     |
                     v
              principal.id
                     |
                     v
       preflight(envelope.request, principal.id)
       complete(envelope.request, principal.id, trustedDeps)
```

`preflight()`/`complete()` themselves are unchanged — they already treated
their `userId` argument as an opaque trusted string, never validating it
against `auth.users` directly. Only the two route handlers changed.

`resolveOrCreateExternalPrincipal()`
(`packages/runs-core/tact-execution/principal/store.ts`) always creates
`principal_kind: 'external_subject'`, `local_auth_user_id: null` — a
Governance caller can never choose `principal_kind` or claim a
`local_auth_user_id`. It rejects the reserved namespace
`'runs-local-auth'` before any database call, and the migration's own CHECK
constraint enforces the same boundary structurally as a second, independent
layer.

## 5. Trust boundary (exact claim)

Resolving or creating a principal proves only:

> **An authenticated source asserted a subject identifier within its own
> namespace.**

It does **not** independently prove that subject exists in the source
product. A verified HMAC caller plus a signed `onBehalfOfUserId` is a trusted
caller assertion inside a trusted namespace — never an independently
verified human identity. Keep this distinction in any future documentation,
test, or support content that describes Principal resolution.

## 6. Local-auth compatibility

Every existing Runs-local Supabase Auth user is backfilled into exactly one
principal, with `principal.id` pinned to `auth.users.id`:

```
namespace            = 'runs-local-auth'   (reserved, see Section 4)
external_subject_id  = auth.users.id::text
local_auth_user_id   = auth.users.id
principal_kind       = 'local_runs_user'
```

Because the value never changes — only which table validates it — every
existing `auth.uid() = user_id` RLS policy on the six retargeted tables
continues to work unmodified. If the underlying `auth.users` row is later
deleted, `local_auth_user_id` is set to `NULL` (not cascaded); the principal
row, and all governance/execution history keyed off its `id`, persist.

## 7. Row Level Security

`tact_runs_principals` has RLS enabled with **zero** policies — the same
"no policy for an operation nobody is meant to use directly" convention used
by every other Runs governance/projection table. Principal resolution is
service-role-only.

## 8. Scope boundary — what this phase deliberately does not touch

This is **Option B**: governance-only. Deliberately unchanged:

- Work Projection, Conversation Link Projection, Connection Projection
  (`tact_runs_work_projection`, `tact_runs_conversation_link_projection`,
  `tact_runs_connection_projection*`) and their ingestion routes/auth
  (`RUNS_PROJECTION_INGESTION_TOKEN`, a single shared bearer secret with no
  per-caller namespace) — a known, separately-scoped weaker trust shape than
  Governance's HMAC transport, not something this phase silently redesigns.
- Telemetry identity, attention provenance, ingestion/capture coverage,
  security findings, downstream permission evidence — the remaining 16 of
  the 22 `auth.users`-coupled columns in this schema, left for a future
  phase.
- Workspace/Membership/RBAC (SOR-224) — a separate, later tenant-boundary
  layer this phase does not anticipate or encode assumptions about.

**Consequence:** `resolveTargetWorkForCorrelation()` (used by
`captureExecution()`) matches `tact_runs_work_projection` on
`(external_work_id, user_id)`. A Work Projection row written under the old
identity will not match a Canonical Execution captured under a new
`principal.id`. This is not a defect introduced here — `captureExecution()`
already treats a failed Work resolution as a normal, logged, non-blocking
event (Capture First) and persists with `work_id = null`. A future SOR-138
Reality Test against an external principal may therefore prove the full
Preflight → Decision → Complete → Canonical Execution → Governance
Execution Link → Approval Request chain without proving
`CanonicalExecution.work_id` continuity — that claim is explicitly out of
scope for this phase.

## 9. Related work

- **SOR-260** — this phase's own tracking issue (Principal Registry,
  Phase 1).
- **SOR-138 Slice 3A-4** — the Reality Test this phase unblocks; its PASS
  claim boundary is Section 8 above.
- **SOR-224** — Workspace/Membership/RBAC; a later, separate tenant-boundary
  layer, not extended or assumed by this phase.
- A future phase may retarget the remaining 16 `auth.users`-coupled columns
  (Section 8) and/or revisit Work Projection identity (Option A) — neither
  is implemented here.
