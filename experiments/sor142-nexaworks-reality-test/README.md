# SOR-142 — NexaWorks isolated local Reality Test environment

This directory is a disposable, local-only testbed for the fictional company
NexaWorks. It is fixture infrastructure, not a product feature and not evidence
that TACT Runs observed any external execution.

## What is included

- A loopback-only Node runtime (`127.0.0.1:43142` by default).
- An isolated SQLite database under the ignored `.runtime/` directory.
- Stable, synthetic IDs for one company, three departments, six employees,
  three customers, four Works, documents, tasks, conversation fragments,
  meeting-like records, and expected execution cases.
- Expected success, failure, retry, explicit Work ID, and missing Work ID cases.
- Deterministic reset/reseed and integrity verification.
- A child-process environment allowlist that does not forward provider or cloud
  credentials.

The expected execution rows are labelled `fixture_expectation` and
`observed = 0`. They are comparison data for later Reality Tests; they are not
fabricated provider or Runs logs.

`export-ground-truth.mjs` is the explicit SOR-142 to SOR-143 mapping boundary:
it derives an independent JSONL ledger from stable employee, Work, scenario, and
expected-operation IDs. It does not read, write, or seed a Runs datastore.

## Reused repository assets and boundaries

The design reuses the SOR-130 reality-test principles:

- fail closed on non-local targets;
- never persist provider credentials or raw real-world payloads;
- never claim a Work correlation without an explicit carrier;
- report unavailable external paths as unsupported instead of faking success.

The fixture fields follow the existing `tact_works`, `tact_tasks`, `tact_runs`,
canonical execution, correlation, and outcome semantics in main's migrations.
They intentionally do not modify or copy those migrations. The testbed uses a
small dedicated schema because Docker and the Supabase CLI are not prerequisites
for this lane and because the database must be independently resettable.

`origin/main` does not contain the SOR-135 standalone Yolna Runs package. This
testbed therefore provides the isolated local runtime boundary, fixture data,
and datastore only. Wiring the future standalone Yolna Runs runtime is an
explicit post-SOR-135 dependency and is not copied from the SOR-135 worktree.

## Prerequisites

- Node.js 22.5 or newer with `node:sqlite` (Node.js 24 is recommended).
- No Docker, Supabase CLI, cloud project, OAuth app, or provider credential.

The commands must be run from the repository root. They do not use `.env` or
`.env.local`.

## Commands

Start and seed the runtime:

```powershell
node experiments/sor142-nexaworks-reality-test/cli.mjs start
```

Verify the database and runtime:

```powershell
node experiments/sor142-nexaworks-reality-test/cli.mjs verify
```

Reset to a clean database and deterministically reseed:

```powershell
node experiments/sor142-nexaworks-reality-test/cli.mjs reset
```

Stop the runtime:

```powershell
node experiments/sor142-nexaworks-reality-test/cli.mjs stop
```

Run focused tests:

```powershell
node --test experiments/sor142-nexaworks-reality-test/test.mjs
```

Export and validate the independent ledger without touching Runs:

```powershell
node experiments/sor142-nexaworks-reality-test/export-ground-truth.mjs --out $env:TEMP\\sor142-ground-truth.jsonl
npx tsx experiments/sor143-ground-truth/validate-ledger.ts $env:TEMP\\sor142-ground-truth.jsonl
```

Report external test availability without contacting providers:

```powershell
node experiments/sor142-nexaworks-reality-test/external-paths.mjs
```

## Local runtime and database architecture

`cli.mjs` is the only launcher. Before any action it rejects production/staging
environment labels, hosted Supabase URLs, and hosted Supabase project refs. For
runtime and one-shot database work it spawns `runtime.mjs` with an explicit
environment allowlist; tokens and credentials from the parent shell are omitted.

The runtime binds to `127.0.0.1` only. Its health endpoint returns counts and
fixture metadata, never fixture text. Reset and shutdown require a random
control token stored only in ignored local runtime state. Destructive reset
validates that the database path is exactly the expected file below `.runtime/`
before deleting it.

SQLite foreign keys and constraints enforce fixture consistency. A SHA-256 of
the checked-in fixture is stored as metadata so a later SOR-143 ledger can
identify the exact expected-data revision.

## Synthetic model

Departments: Sales, Product, and Operations.

Employees: Sales Lead, Sales Member, Product Manager, Engineer, Operations
Member, and Admin. Names are role labels, and every address uses the reserved
`.test` top-level domain.

Work scenarios:

1. Sales — customer research, proposal preparation, synthetic Slack-like
   confirmation, and document update.
2. Product/Development — synthetic Linear-like issue, code change, test
   failure, retry, and Git-like commit reference.
3. Operations — inquiry review, document lookup, and status update.
4. Sales follow-up — a second Work used to keep Work execution concurrent.

## External-service availability

| Path | Status in SOR-142 |
| --- | --- |
| Notion | Unsupported / not provisioned; no credential is consumed. |
| Slack | Unsupported / not provisioned; Slack-like fixture text only. |
| GitHub | Unsupported / not provisioned; Git-like fixture metadata only. |
| Linear | Unsupported / not provisioned for runtime execution. |

SOR-130 contains opt-in provider Reality Tests, but this environment does not
invoke them and does not create, mutate, or delete external resources.

## Secret and privacy boundary

The runtime never inherits Supabase service-role keys, Composio keys, Slack or
GitHub tokens, Notion credentials, customer OAuth, production API credentials,
or arbitrary parent environment variables. A required credential is never
replaced by a fake success: provider paths stay unsupported.

All checked-in people, companies, emails, messages, documents, and identifiers
are synthetic. There is no university, employee, customer, private Slack, or
other personal data in the fixture.

## Retention and deletion

The database, PID, control token, and runtime log live under ignored
`.runtime/`. `reset` deletes only the validated local SQLite file and recreates
it. `stop` ends the loopback process but retains the database for inspection.
To remove retained data after stopping, delete this experiment's `.runtime/`
directory. No cloud copy or backup is created by these tools.
