# Yolna Runs — Standalone Vercel Deployment (SOR-135 Phase 4A)

Defines how Standalone Runs deploys to Vercel as its own Project, separate from
Yolna's own Vercel Project. **No Vercel project has been created yet** — this
document is the configuration Human Owner approves before Phase 4B creates it.

## Project settings

| Setting | Value |
|---|---|
| Root Directory | `products/yolna-runs` |
| Include source files outside of the Root Directory in the Build | **ON** (required — `@tact/execution-contract` and `@tact/runs-core` are `file:../../packages/*` dependencies; Vercel must upload `packages/**` too, or `npm ci` fails) |
| Framework Preset | Next.js (auto-detected; `vercel.json` pins it explicitly) |
| Install Command | `npm ci` (from `vercel.json`) |
| Build Command | `npm run build` (from `vercel.json`) |
| Output Directory | `.next` (from `vercel.json`) |
| Node.js Version | `>=20.9.0` (from `package.json` `engines`; select 20.x LTS in Vercel's Project Settings) |

This repo stays a single monorepo for now (SOR-135's explicit interim decision —
repo split is a separate, later judgment call). The Root Directory + "include
outside" toggle is Vercel's documented mechanism for exactly this monorepo
shape; it does not require a separate repo.

## Environment variables (Vercel Project Settings → Environment Variables)

Set **only** the variables in `lib/env/runtimeEnvContract.ts` / `.env.example`.
Do not copy any variable from Yolna's own Vercel Project. `npm run verify:env`
is the machine check for this — run it as part of the build or a pre-deploy
step once wired (not yet wired to Vercel's build pipeline this phase; see
"What Phase 4B still needs to do" below).

| Variable | Scope | Environments |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Production, Preview, Development |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | Production, Preview, Development |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only (uncheck "Expose to Browser") | Production, Preview, Development |
| `RUNS_PROJECTION_INGESTION_TOKEN` | Server-only, optional | Production, Preview (only if/when Yolna is actually wired to call the ingestion endpoints) |

Each environment (Production/Preview/Development) should point at its own
Supabase project or branch — never share Production's `SUPABASE_SERVICE_ROLE_KEY`
into Preview.

## Domain strategy

- Production: a dedicated subdomain under Runs' own domain/project, separate
  from Yolna's production domain (exact domain name is a Human Owner naming
  decision, not made here).
- Preview: Vercel's automatic per-branch preview URLs — no custom domain
  needed.
- Do not reuse or alias any existing Yolna-owned domain for Runs.

## Preview / Production separation

Standard Vercel behavior once the Project exists: every non-production branch
gets an isolated Preview deployment with its own URL; Production deploys only
from the configured production branch (recommend: this repo's `main`, once
Runs' own commits land there — out of scope this phase, no merge to `main`
has happened). Point Preview environment variables at a disposable/staging
Supabase project, never at the Production Supabase project's service-role key.

## Rollback strategy

Vercel keeps every deployment immutable and addressable; "Promote to
Production" on a prior successful deployment is the rollback mechanism — no
destructive action needed. For a DB-schema-incompatible rollback (the deployed
code expects a migration that was already applied and can't be un-applied
safely), roll back code only and leave the DB ahead; Runs' additive-migration
discipline (see `supabase-provisioning-runbook.md`) is designed so this is
safe in the common case.

## What Phase 4B still needs to do (not done this phase)

1. Actually create the Vercel Project with the settings above (cloud resource
   creation — gated behind Human Owner approval, not done in Phase 4A).
2. Decide whether `npm run verify:env` runs as a Vercel "Ignored Build Step" /
   build command prefix, or as a separate CI gate before Vercel ever builds.
3. Register the real domain(s).
4. Wire `RUNS_PROJECTION_INGESTION_TOKEN` generation/rotation ownership (not
   designed this phase beyond the token's existence as an auth seam — see
   `lib/projection/ingestionAuth.ts`'s header comment).
