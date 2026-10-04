# Yolna Runs — Standalone Supabase Project Provisioning Runbook (SOR-135 Phase 4A)

**No cloud Supabase project has been created yet.** This runbook is the exact
procedure Phase 4B follows once Human Owner approves cloud resource creation
(SOR-135 Phase 4A section 15/20/21 — cloud project creation is explicitly out
of scope for this phase). Every step below has already been exercised against
a disposable local Supabase instance in Phase 3 (`products/yolna-runs/supabase/`,
`scripts/dbIndependenceCheck.sh`, `scripts/dbRealityTest.ts`) — this runbook
is that same procedure pointed at a real cloud project instead of `localhost`.

## Prerequisites

- Human Owner approval to create a new Supabase organization/project.
- Decision on project name and region (candidates in `cloud-resource-plan.md`).
- This repo's `products/yolna-runs/supabase/migrations/` (8 files, Phase 3) —
  unmodified, no new migration needed to execute this runbook.

## Steps

1. **Create the Supabase project**
   Via the Supabase dashboard or `supabase projects create`. Record the
   project ref, region, and the generated DB password (store in Human
   Owner's secret manager, never in this repo).

2. **Apply Runs migrations only**
   ```
   cd products/yolna-runs
   npx supabase link --project-ref <new-project-ref>
   npx supabase db push
   ```
   This applies exactly the 8 files under `supabase/migrations/` — the same
   set already verified in Phase 3 to build a complete Runs datastore on an
   empty database with 0 Yolna-owned tables and 0 cross-product foreign keys
   (`scripts/dbIndependenceCheck.sh`). Do not run any root Yolna migration
   against this project.

3. **Auth configuration**
   In Supabase Dashboard → Authentication → URL Configuration, set the values
   from `auth-redirect-design.md` (Site URL, Redirect URLs for localhost,
   Preview, and Production). Do this *before* any real user signs up — SOR-44
   already hit a production incident from an unset/misconfigured Password
   Recovery redirect; this runbook exists specifically so a new project never
   repeats it.

4. **Redirect URLs**
   Confirm the exact list in `auth-redirect-design.md` is entered verbatim
   (every entry, including the `/auth/callback`-style path this app's
   `components/auth/AuthProvider.tsx` / `app/login/page.tsx` actually use —
   verify against that code at execution time, not just this doc, in case it
   has since changed).

5. **RLS confirmation**
   ```
   docker exec <none — this is a cloud project, use the Supabase SQL Editor or psql against the cloud DB_URL>
   ```
   Run (via SQL Editor or `psql "$DB_URL"`):
   ```sql
   select tablename, rowsecurity from pg_tables
   where schemaname = 'public' and tablename like 'tact_%';
   ```
   Every row must show `rowsecurity = true`. Cross-check against the 10
   Runs-owned tables listed in `scripts/dbIndependenceCheck.sh`'s
   `RUNS_OWNED_TABLES`.

6. **Permission seed confirmation**
   ```sql
   select identifier, decision from public.tact_execution_permission_rules
   where user_id is null order by priority;
   ```
   Expect exactly the 7 global rules seeded by migration
   `20270101000003_create_tact_execution_permission.sql`.

7. **Observation Registry seed confirmation**
   ```sql
   select provider, provider_label, action_category, verification_status
   from public.tact_execution_observation_registry order by provider, action_category;
   ```
   Expect the SOR-130 seed rows from migration
   `20270101000007_create_tact_execution_observation_registry.sql` (Notion,
   Slack, GitHub as documented in that migration's own comments).

8. **Service Role secret setup**
   Copy the project's `service_role` key into the deployment's secret store
   (Vercel env var `SUPABASE_SERVICE_ROLE_KEY`, see `vercel-deployment.md`) —
   never into this repo, never into a committed `.env` file, never into a
   client-bundled (`NEXT_PUBLIC_`) variable. See
   `scripts/verify/runsClientServerBoundary.ts` for the static check that no
   browser-bundled code can reach this value.

9. **A/B synthetic user test**
   Point `scripts/dbRealityTest.ts`'s `SUPABASE_URL`/`SUPABASE_ANON_KEY`/
   `SUPABASE_SERVICE_ROLE_KEY` env vars at the new cloud project (instead of
   the local disposable instance) and run `npm run db:reality-test`. All 22
   checks (Synthetic User A/B, Capture-without-Work, Projection Lag, tenant
   isolation, etc.) must pass against the real cloud project before anyone
   depends on it.

10. **Browser login test**
    Deploy (or run locally with the cloud project's env vars) and manually
    sign up/sign in through `app/login/page.tsx`, confirm the session
    persists, confirm Password Recovery email delivery and redirect land on
    the correct page (not a 404/blank page — the exact SOR-44 failure mode).

## Rollback / destroy

- Code rollback: see `vercel-deployment.md`.
- DB rollback within a project: migrations in this project are additive-only
  by design (no destructive `ALTER`/`DROP` exists in any of the 8 baseline
  files) — a bad deploy can be rolled back at the code layer without an
  incompatible DB state in the common case.
- Full project destroy: `supabase projects delete <project-ref>` (or via
  dashboard) — only after Human Owner confirms no data must be retained.
  Irreversible; requires the same confirmation discipline as any other
  destructive action in this codebase's standing instructions.

## Expected cost tier

Supabase's free tier covers a disposable/staging project. A production
project handling real customer data should move to at minimum the Pro tier
(dedicated backups, no project pausing on inactivity) — exact tier selection
is a Human Owner budget decision, not made here.

## Staging / Production project structure

Recommend two separate Supabase projects (Staging, Production), mirroring
this runbook for each — never share one project's service-role key across
both environments. See `cloud-resource-plan.md` for naming.
