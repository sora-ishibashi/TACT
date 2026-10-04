# Yolna Runs — Staging Data Migration Recommendation (SOR-135 Phase 4A)

**No data migration has been performed.** This is a recommendation only, per
explicit instruction ("推奨案と理由だけ報告してください... Human Owner承認まで
data migrationはしないでください"). Existing TACT Staging is unchanged.

## Options considered

- **A. Fresh start** — new Runs Staging/Production begins with an empty
  database (Phase 3's 8 baseline migrations only, no imported rows).
- **B. Regenerate synthetic fixtures only** — re-run whatever process created
  SOR-44's synthetic test data against the new project, producing equivalent
  (not identical) fixture rows.
- **C. One-time ETL of existing Runs tables** — copy rows from TACT Staging's
  current `tact_canonical_executions`/`tact_execution_*` tables into the new
  project.
- **D. Other** — not identified; no variant of A–C was found inadequate.

## Recommendation: A, with B as the practical follow-up

**Fresh start (A).** Regenerate synthetic fixtures (B) afterward, as needed
for testing, rather than migrating existing rows.

## Reasoning

1. **No real customer data exists to preserve.** SOR-135's own parent issue
   frames Runs as explicitly pre-PoC — the release rule states real customer
   data / external production use only begins after this issue and the
   downstream Security gate chain (SOR-5 → SOR-8 → SOR-32) complete. What
   exists in TACT Staging today is SOR-44's synthetic test fixtures, not
   anything with retention value.

2. **Schema shape changed in Phase 3 in ways ETL would need to handle
   carefully.** `work_id`/`connection_id` and related columns went from
   FK-constrained references into Yolna's own tables to opaque,
   unconstrained `uuid` columns, and two new tables
   (`tact_runs_work_projection`, `tact_runs_conversation_link_projection`)
   were added that have no equivalent in Staging's current schema at all. An
   ETL (option C) would need a non-trivial mapping/backfill step for data
   that is disposable test fixtures anyway — the effort is not justified by
   what it would preserve.

3. **A fresh empty database is exactly what Phase 3's own acceptance test
   already proved works end-to-end.** The 22-check Synthetic A/B E2E reality
   test (`scripts/dbRealityTest.ts`) already demonstrates the full product
   flow — Capture, Permission, Correlation, Attention, Outcome, Human
   Reclassification, tenant isolation — starting from empty. Choosing "fresh
   start" means Staging's first real exercise is the same path already
   verified, not an unverified ETL path.

4. **Lower risk, reversible if wrong.** If Human Owner later decides specific
   historical Staging rows are worth preserving after all, option C remains
   available as a later, deliberate, scoped ETL — nothing about choosing A
   now forecloses it. The reverse is not true: an ETL run now, if done
   carelessly, could carry forward incorrect pre-Phase-3 assumptions (e.g.
   rows whose `work_id` pointed at a Yolna `tact_works` row that database no
   longer resolves the same way).

## What this recommendation does not cover

- Production data migration (separate question, not addressed here — no
  Runs Production has ever held real customer data to migrate).
- The actual cloud Supabase project creation this recommendation would apply
  to (see `cloud-resource-plan.md` — also not yet approved/executed).
