# Yolna Runs — Standalone Supabase Auth Redirect Design (SOR-135 Phase 4A)

Defines the Supabase Auth URL Configuration for a future Standalone Runs
Supabase project, so it is never left unset or misconfigured the way SOR-44
found Yolna's own Password Recovery redirect to be. **No cloud project exists
yet; nothing here is applied to any real Supabase project this phase.**

## Scope boundary vs. SOR-146

This document defines only the **configuration** (Site URL, redirect
allowlist). It does not implement or change any Password Recovery UI/flow
code. As of this audit, `products/yolna-runs/app/login/page.tsx` has sign-in
and sign-up only — **no "forgot password" UI exists yet in Standalone Runs**.
Adding that UI (a "Forgot password?" link, a reset-request form, a new-password
form) is SOR-146's responsibility, not done here. What this document provides
is the redirect-URL groundwork so that whenever SOR-146 adds that UI, the
Supabase project's allowlist already has a working target instead of 404ing
the way the SOR-44 incident did.

## Site URL

The canonical app URL for the active environment (one value per Supabase
project/environment — see `supabase-provisioning-runbook.md`'s recommendation
of separate Staging/Production projects):

- Production: `https://<runs-production-domain>` (exact domain: Human Owner
  naming decision, see `vercel-deployment.md`)
- Staging: `https://<runs-staging-domain>`

## Login URL

`<Site URL>/login` — matches this app's existing route
(`products/yolna-runs/app/login/page.tsx`).

## Password Recovery callback URL

`<Site URL>/login` for now, matching every other auth action in this app
(sign-in/sign-up land on `/login` or `/` — see `app/login/page.tsx`). When
SOR-146 adds a dedicated recovery-completion route (e.g. `/login/reset`), add
that exact path to the Redirect URLs list below and update this document —
do not leave a stale redirect target configured.

## Additional Redirect URLs (full allowlist)

Supabase's "Redirect URLs" field accepts multiple entries; each environment
needs its own localhost + preview + production set so local development and
Vercel Preview deployments keep working without widening the Production
project's allowlist:

| Environment | Redirect URL(s) |
|---|---|
| Localhost (dev) | `http://localhost:3000/login`, `http://localhost:3000/` |
| Vercel Preview | `https://*.vercel.app/login`, `https://*.vercel.app/` (Supabase supports wildcard subdomain patterns for Preview; confirm current Supabase dashboard support at provisioning time — this is a known-working pattern as of this audit, not guaranteed unchanged) |
| Production | `https://<runs-production-domain>/login`, `https://<runs-production-domain>/` |

## Why this exists as its own document

SOR-44 is cited directly in the Phase 4A task driving this document: Yolna's
own Supabase project had its Password Recovery redirect misconfigured/unset in
a way that only surfaced once a real user tried the flow in production. Runs
gets its own, separate Supabase project (per this phase's goal) — the correct
moment to configure Auth redirects correctly is project creation time (runbook
step 3), not after the first incident.
