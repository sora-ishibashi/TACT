# Yolna Runs — Cloud Resource Creation Plan (SOR-135 Phase 4A)

Consolidated summary for Human Owner approval before any cloud resource is
created. Full procedural detail lives in `supabase-provisioning-runbook.md`
and `vercel-deployment.md` — this document is the approval checklist.

**Nothing in this document has been executed.** Cloud Supabase project
creation and cloud Vercel project creation are both explicitly out of scope
for SOR-135 Phase 4A (section 20).

## Supabase

| Item | Proposal |
|---|---|
| Project name (Production) | `yolna-runs-production` (candidate — Human Owner naming decision) |
| Project name (Staging) | `yolna-runs-staging` (candidate) |
| Region | Same region as Yolna's existing Supabase project, to minimize latency for any future cross-product telemetry call (candidate — confirm against Yolna's actual project region at provisioning time, not assumed here) |
| Required env (consumed from this project) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — see `lib/env/runtimeEnvContract.ts` |
| Migration command | `npx supabase db push` against `products/yolna-runs/supabase/migrations/` only (8 files, Phase 3 baseline) — see `supabase-provisioning-runbook.md` step 2 |
| Auth configuration | `auth-redirect-design.md` |
| Rollback / destroy plan | `supabase-provisioning-runbook.md` "Rollback / destroy" section |
| Expected cost tier | Staging: Free tier. Production: Pro tier minimum (dedicated backups, no inactivity pausing) — final tier is a Human Owner budget decision |
| Staging / Production structure | Two separate projects, never sharing a service-role key (see runbook) |

## Vercel

| Item | Proposal |
|---|---|
| Project name | `yolna-runs` (candidate) |
| Root Directory | `products/yolna-runs` |
| Build command | `npm run build` (`vercel.json`) |
| Install command | `npm ci` (`vercel.json`) |
| Environment variables | Same 3 required + 1 optional as the Supabase table above — set per-environment (Production/Preview/Development), never shared |
| Domain strategy | Dedicated subdomain, separate from any existing Yolna domain (`vercel-deployment.md`) |
| Preview / Production separation | Standard Vercel per-branch Preview + a single Production branch — see `vercel-deployment.md` |
| Rollback strategy | Vercel's immutable-deployment "Promote to Production" (`vercel-deployment.md`) |

## What Human Owner approves by approving this plan

1. Creating the two Supabase projects above (names/region as proposed or
   amended).
2. Creating the one Vercel project above (name as proposed or amended).
3. Running `supabase-provisioning-runbook.md` against the new Supabase
   projects (migration apply, auth config, seed verification, synthetic
   A/B test, browser login test).
4. Setting the 3–4 environment variables in Vercel per `vercel-deployment.md`.

Nothing else — this plan does not include Staging data migration (see
`staging-data-migration-recommendation.md`, separately decided) or any change
to Yolna's own existing Supabase/Vercel projects.
