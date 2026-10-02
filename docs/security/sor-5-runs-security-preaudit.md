# SOR-5 — Runs-only Supabase security pre-audit

**Status:** READY FOR REVIEW — SOR-5 remains **In Progress**  
**Audit date:** 2026-10-02  
**Cloud mutations:** 0  
**Repository mutation:** this report only

## Scope and method

This is a read-only audit of the standalone Runs Supabase project:

| Item | Value |
| --- | --- |
| Project | `yolna-runs-staging` |
| Project ref | `fddbtgzisbhlpjdqejzu` |
| Cloud operations | Security Advisor, migration metadata, table metadata, and read-only PostgreSQL catalog queries only |
| Excluded | Migration/policy/function/Auth/user/data/secret changes, reset, seed, Vercel, and production |
| Repository base | `15208bb403e10f35df3aad2d09a03cfddd8dfafe` (SOR-135 Phase 4B) |
| Migration owner | `products/yolna-runs/supabase/migrations/**` |

The project has eight Runs-owned cloud migrations (`20270101000001` through
`20270101000008`). No root Yolna migration appears in that hosted migration
history, and the Runs migration tree has no cross-product foreign key.

The relevant durable product decision is Observation-first / Execution
Path-first: Runs observes and explains execution; it does not choose execution
or become an authorization owner. This limits the conclusions below: source
authentication, signing, replay control, and credential custody are handed to
SOR-8 rather than asserted here.

## Executive verdict

The standalone data boundary and the ten-table user-read/service-write model
are present. All ten Runs tables have RLS enabled, each has at least one SELECT
policy, and none exposes authenticated mutation through RLS policies.

However, this audit found a **P0 blocker** in the live project: the two
`SECURITY DEFINER` correlation RPCs can currently be executed by both `anon`
and `authenticated`. The live Security Advisor and privilege catalog conflict
with the checked-in Runs migration, which explicitly revokes public execution
and grants only `service_role`. Do not treat the source migration as proof that
the hosted ACL is hardened; remediate and re-audit in SOR-8/SOR-32 review.

Leaked-password protection is disabled. It is a **P1 before-beta** Auth
hardening decision; its enablement was intentionally not changed in this audit.

## Security Advisor findings

| Finding | Live count | Classification | Verdict |
| --- | ---: | --- | --- |
| `anon_security_definer_function_executable` | 2 | P0 BLOCKER | `apply_execution_work_correlation` and `reclassify_execution_work` are exposed to unauthenticated callers. |
| `authenticated_security_definer_function_executable` | 2 | P0 BLOCKER | The same privileged RPCs are exposed to every signed-in caller. |
| `function_search_path_mutable` | 4 | P2 HARDENING | Four update-timestamp trigger functions do not fix `search_path`. |
| `auth_leaked_password_protection` | 1 | P1 BEFORE BETA | Enable after confirming plan/provider implications and completion flow. |

Advisor results are live observations from 2026-10-02. They supersede the
older shared-DB baseline in SOR-5 (14 policy-less tables and 8 mutable-path
functions), which must not be copied into this standalone Runs verdict.

## Runs table access classification

All ten tables are **A — USER_READ_SERVICE_WRITE**. RLS is enabled on each;
the only user-facing policies are SELECT policies. `service_role` is the
expected writer and bypasses RLS by design. No table is presently classified
as SERVICE_ONLY, USER_SELF_SERVICE, or UNKNOWN / NEEDS DESIGN.

| Table | RLS / policies | User reader | User mutation | Expected writer | Ownership / leakage assessment |
| --- | --- | --- | --- | --- | --- |
| `tact_canonical_executions` | enabled; 1 SELECT | owner | none | service role ingestion | `user_id`; static user isolation predicate is `auth.uid() = user_id`. |
| `tact_runs_work_projection` | enabled; 1 SELECT | owner | none | service role projection | `user_id`; `external_work_id` is globally keyed, so writers must bind its owner before upsert. |
| `tact_runs_conversation_link_projection` | enabled; 1 SELECT | owner | none | service role projection | `user_id`; external conversation/workspace IDs are application-bound, not an RLS substitute. |
| `tact_execution_permission_rules` | enabled; 1 SELECT | owner plus global rules | none | service role | `user_id`, with deliberate `user_id IS NULL` global fallback. |
| `tact_execution_permission_decisions` | enabled; 1 SELECT | owner of parent execution | none | service role evaluator | ownership is enforced through `tact_canonical_executions.user_id`. |
| `tact_execution_work_correlations` | enabled; 1 SELECT | owner of parent execution | none | service role correlator | ownership is enforced through parent execution. |
| `tact_execution_attentions` | enabled; 1 SELECT | owner | none | service role | `user_id`. |
| `tact_execution_outcomes` | enabled; 1 SELECT | owner of parent execution | none | service role outcome writer | ownership is enforced through parent execution. |
| `tact_execution_observation_registry` | enabled; 1 SELECT | any authenticated user | none | service role | deliberately global, non-user record; confirm it never stores tenant-sensitive configuration. |
| `tact_execution_ingestion_failures` | enabled; 1 SELECT | owner | none | service role ingestion | `user_id`. |

The PostgreSQL catalog also shows broad table privileges for Data API roles.
With RLS enabled and no INSERT/UPDATE/DELETE policy, those grants do not create
a user mutation path. They are nevertheless a configuration dependency to keep
under review whenever a new policy is introduced.

## Service-role and user-isolation assessment

The service role is deliberately the only writer for ingestion, projections,
permission evaluation, correlation, attention, outcome, and failure records.
That bypass is **accepted by design only when the application boundary binds
the target `user_id` and external identifiers before the write**.

The source design and static policies protect reads by user. The correlation
RPC source also checks an execution and its target work with the supplied user
ID. This is useful defense in depth, but it does not make an externally
callable `SECURITY DEFINER` RPC safe: a caller controls its arguments unless
the EXECUTE ACL is restricted.

No synthetic User A/B proof was run. Creating test users or rows would violate
the explicit no-user/no-data-write audit scope. Therefore:

- **User-level isolation:** statically supported by the live RLS predicates,
  but dynamic A/B proof is **not verified**.
- **Organization tenancy:** not established. `organization_id` and
  `workspace_id` exist on canonical executions, but the observed RLS policies
  are user-based; no organization-level tenancy claim is made.
- **Cross-product objects:** none found in the Runs migration ownership tree;
  no cross-product foreign key was observed in the Runs tables.

## Functions and RPCs

| Function | Mode / path | Live execution ACL | Assessment |
| --- | --- | --- | --- |
| `apply_execution_work_correlation` | `SECURITY DEFINER`; `search_path=public` | `anon`, `authenticated`, `service_role` | **P0** public privileged RPC. Intended source ACL is service-role-only. |
| `reclassify_execution_work` | `SECURITY DEFINER`; `search_path=public` | `anon`, `authenticated`, `service_role` | **P0** public privileged RPC. Intended source ACL is service-role-only. |
| `set_tact_canonical_executions_updated_at` | invoker trigger | default/public executable; mutable path | P2: trigger-only, but set an immutable safe path and revoke unnecessary execute. |
| `set_tact_runs_work_projection_updated_at` | invoker trigger | default/public executable; mutable path | P2: same. |
| `set_tact_runs_conversation_link_projection_updated_at` | invoker trigger | default/public executable; mutable path | P2: same. |
| `set_tact_execution_attentions_updated_at` | invoker trigger | default/public executable; mutable path | P2: same. |

### P0 attack path and remediation

**Evidence:** both live Security Advisor checks identify the two named RPCs as
callable through `/rest/v1/rpc/...` by `anon` and `authenticated`; catalog
inspection confirms `SECURITY DEFINER` and those grants. The reviewed source
migration (`20270101000004_create_tact_execution_correlation.sql`) instead
uses `revoke all ... from public` followed by `grant execute ... to
service_role`.

**Risk / attack path:** an unauthenticated or ordinary authenticated caller can
invoke a function that runs with elevated privileges and attempts to correlate
or reclassify executions. Although the function checks supplied owner IDs,
the live public entry point is an authorization-boundary failure and should not
rely on caller-provided IDs for containment.

**Recommendation / owner:** SOR-8 or SOR-32 should create a Runs-owned
forward-only migration that revokes `EXECUTE` from `PUBLIC`, `anon`, and
`authenticated`, grants only `service_role`, then repeats the Advisor and ACL
queries. Do not alter the historical migration or manually patch cloud state.

## Auth assessment

| Control | Verdict |
| --- | --- |
| Leaked-password protection | **Disabled; P1 before beta.** Record current state and enable through the approved Auth configuration workflow after reviewing free-tier/provider constraints. |
| Email confirmation, MFA, redirect allowlist, site URL, anonymous sign-in, password policy, session/JWT lifetime | **Not verified.** The available read-only audit surfaces did not expose these settings, and this audit did not attempt configuration changes. |

## Findings and handoffs

| Priority | Finding | Owner / next step |
| --- | --- | --- |
| P0 BLOCKER | Two correlation `SECURITY DEFINER` RPCs executable by `anon` and `authenticated`; live ACL drifts from migration intent. | SOR-8 / SOR-32: forward migration, then live ACL and Advisor re-audit. |
| P1 BEFORE BETA | Leaked-password protection disabled. | SOR-32: make and verify approved Auth setting decision. |
| P1 BEFORE BETA | Dynamic cross-user A/B isolation has not been evidenced because this audit forbids synthetic user/data writes. | SOR-32: controlled synthetic-user test with explicit approval. |
| P2 HARDENING | Four public trigger helpers have mutable `search_path`. | Runs-owned migration: set a safe fixed path and remove unneeded public EXECUTE grants; re-run Advisor. |
| ACCEPTED / BY DESIGN | Ten tables have no user mutation policies; service role is the writer. | Preserve this split; require application-level ownership/external-ID binding in every writer. |
| ACCEPTED / BY DESIGN | Observation registry is readable by any authenticated user. | Keep only non-sensitive registry content; reassess if tenant/provider-secret data is added. |
| ACCEPTED / BY DESIGN | Organization tenancy is not asserted by this Runs boundary. | Product/design decision before organization-scoped access is introduced. |

### SOR-8 handoff

Validate ingestion-source authentication, signing, nonce/replay prevention,
key rotation, ownership binding, and decision provenance. The service-role
writer model makes those controls the primary containment boundary.

### SOR-32 handoff

Include the P0 RPC exposure, service-role misuse, forged telemetry or
compromised-source paths, function abuse, Auth hardening, cross-user dynamic
tests, and retention/deletion review in the PoC Security Gate.

## Completion record

- Audited Supabase project: `yolna-runs-staging` / `fddbtgzisbhlpjdqejzu`.
- Cloud mutation count: **0**.
- Repo mutation: **one file** — this report.
- `npm run verify`: **not run**; this is documentation-only, read-only audit
  work with no application or migration change.
- `npm run security`: **not run**; no executable source/dependency change was
  made. Existing repository security status is not reclassified by this audit.

SOR-5 is **READY FOR REVIEW** and must remain **In Progress** pending the
separate SOR-8/SOR-32 remediation and verification decisions.
