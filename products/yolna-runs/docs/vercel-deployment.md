# Yolna Runs — Standalone Staging Vercel Deployment (SOR-135 Phase 4B)

Phase 4B created the independent `yolna-runs-staging` Vercel project and
Runs-only Supabase project. This runbook records the Staging procedure;
it does not approve Production resources, Production env, customer data,
custom domains, DNS changes, or a production deployment.

## Audited Staging resources (2026-10-02)

- Vercel project: `yolna-runs-staging`
  (`prj_IGbM0i4d5wc9txvpPAVvpcoGdw2y`).
- Supabase project: `yolna-runs-staging` (`fddbtgzisbhlpjdqejzu`),
  ap-northeast-1; ACTIVE_HEALTHY, 8 Runs migrations, 10 Runs-owned tables
  with RLS, zero Yolna-owned tables and zero cross-product foreign keys.
- The closeout deployment `dpl_44WgnQUcQujk7GT8HdtTsA2NAPy2` is READY with
  target Preview. Find its current URL in this project's deployment list;
  an ephemeral deployment URL is not a canonical product endpoint. Its
  smoke check returned 200 for `/` and `/login`, and 401 for unauthenticated
  activity and both ingestion endpoints.
- An earlier closeout Preview attempt (`dpl_J6QtUw843hDKoNmjmCVuD5zEmrV1`)
  failed closed before `next build` when newly observed Vercel build-worker
  credential names were not yet in the exact conditional platform list.
  The successful retry preserved the broad-prefix prohibition and allows
  only the six observed exact names in non-Production Vercel context.
- A prior, failed first deployment was recorded by Vercel with target
  `production`, despite the CLI invocation not specifying `--prod`.
  It ended in ERROR. There is no READY Production deployment in the audited
  project. Do not describe this as zero Production-target history.
- Cloud E2E 22/22 and synthetic user A/B isolation were reported in the
  Phase 4B Linear checkpoint. The closeout audit inspected cloud state
  read-only; it did not rerun migrations or cloud data-writing tests.
  Organization-level tenancy is not proven.

## Project and build settings

| Setting | Value |
|---|---|
| Root Directory | `products/yolna-runs` |
| Include source files outside Root Directory | ON (`sourceFilesOutsideRootDirectory: true`, confirmed by project API) |
| Framework Preset | Next.js |
| Install Command | The three `npm ci` commands below, from `vercel.json` |
| Build Command | `npm run build`, from `vercel.json` |
| Output Directory | `.next` |
| Vercel Project Setting | Node 20.x; overridden by the package runtime contract |
| Canonical local regression runtime | Node 22 (closeout: 22.23.3) |
| Runtime contract | `products/yolna-runs` and `packages/runs-core` declare Node `22.x`; the READY Preview build log confirms Vercel selected Node 22.x. |

The Phase 4B CLI deployment was linked and uploaded from the repository
root so sibling `packages/**` were available. Build/install run in
`products/yolna-runs`. This uploads build source from the monorepo; it does
not mean the root Yolna application is installed or bundled in Runs.
The independent clean-install proof copies only `packages/execution-contract`,
`packages/runs-core`, and `products/yolna-runs`, excluding local env files,
`.vercel`, CLI state, node_modules, and build output.

The two `file:` dependencies resolve imports from their real package paths,
so installing only the application left `packages/runs-core` unable to
resolve `@supabase/supabase-js` during the first cloud build. The successful
configuration installs each shared package before installing Runs:

```sh
npm ci --prefix ../../packages/execution-contract && npm ci --prefix ../../packages/runs-core && npm ci
npm run build
```

The closeout audit repeated these exact install commands and build in a
clean isolated directory with Node 22 and non-secret placeholders. No root
Yolna package install is needed. `scripts/verify/standaloneCleanInstall.sh`
uses locked `npm ci` for all three packages and excludes local env files,
Vercel/Supabase CLI state, installed dependencies, and build output before
running canonical `verify` and `security` in the isolated tree.

## Staging environment scope

Set only these application variables, matching `lib/env/runtimeEnvContract.ts`
and `.env.example`. Never copy credentials from Yolna's project.

| Variable | Visibility | Authorized Vercel targets |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public, Runs Staging project URL | Preview, Development |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public, Runs Staging anon key | Preview, Development |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only, sensitive | Preview, Development |
| `RUNS_PROJECTION_INGESTION_TOKEN` | Server-only, sensitive | Preview, Development |

The read-only audit found exactly these four names in each target and no
Production env entries. It found no Yolna-only, LLM, Composio, or customer
SaaS credential names. Never place a service-role or ingestion credential
in a `NEXT_PUBLIC_` variable or commit local env/CLI state.

`npm run verify:env -- --mode=production|development` loads the same env-file
set and precedence as Next.js through `@next/env`, then checks the combined
file and shell environment without printing values. `prebuild`, `prestart`,
and `predev` enforce it before Next starts. Unknown credential-like names
fail closed. Exact Vercel build-worker credentials observed in Preview
(`TURBO_CI_VENDOR_ENV_KEY`, `VERCEL_ARTIFACTS_TOKEN`,
`VERCEL_AUTOMATION_BYPASS_SECRET`, `VERCEL_DEPLOYMENT_KEY`,
`VERCEL_ENV_ENC_KEY`, and `VERCEL_OIDC_TOKEN`) are accepted only when
`VERCEL=1` and the environment is Preview or Development. A locally pulled
value, an unknown `VERCEL_*` credential, and any Production context still
fail.

The repository-root `.vercelignore` is a positive source allowlist. A deploy
may upload only `products/yolna-runs`, `packages/execution-contract`, and
`packages/runs-core`; nested env files, `.vercel`, installed dependencies,
build output, and Supabase CLI state are denied again after the allow rules.
The closeout dry-run selected 120 files, with zero secret-state paths, zero
root Yolna application paths, and zero paths outside that source allowlist.

## Preview safety and rollback

The closeout used an explicit `--target preview` and verified the resulting
deployment metadata reported `target=preview`. Any future deployment requires
the same explicit target and post-deploy verification. Do not assume omitting
`--prod` prevents a first production-target attempt.

For Staging code rollback, select a previous known-good Preview artifact
or redeploy its reviewed commit explicitly to Preview using Runs-only
Staging env. Do not use Promote to Production. Keep the additive database
schema in place and verify compatibility first; do not reset or destroy the
cloud database. See `supabase-provisioning-runbook.md` for database ownership
and rollback considerations. Production rollback requires a separate future
approval and runbook.

## Closeout gates and limitations

The product-local `npm run verify` and `npm run security` gates run without
Yolna application source. The Node 22 cleanroom passed locked installs,
typecheck, lint, build, forbidden package/import/route checks, client/server
service-role reachability, resolved-dependency and deployment-artifact audits,
and shell / `.env.local` / `.env.production.local` / startup secret negatives.
Full and production dependency audits report zero vulnerabilities for both
Standalone Runs and `runs-core` after the patch-only Next.js update.

SOR-135 remains In Progress pending resolution and independent remote
checkpoint review. SOR-5 / SOR-136 / SOR-8 implementation has not started.
Request signing, replay protection, and key rotation remain SOR-8 scope.
Production provisioning, domains, DNS, customer data, and repo split are
outside this Staging closeout.
