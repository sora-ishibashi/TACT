-- TIME-P1a: Temporal State Foundation
--
-- Adds the minimum set of explicit, typed temporal fields needed to
-- represent "when" as first-class Work/Task state, without introducing
-- any scheduler, timer, or automatic transition:
--
--   tact_works.deadline       - "this Work is expected to be completed
--                                by this time" (not a scheduler trigger;
--                                just a represented/validated fact).
--   tact_tasks.wait_until     - "do not resume this Task before this
--                                timestamp" (a gating condition read by
--                                a future caller, never enforced here).
--   tact_tasks.next_retry_at  - "the earliest time a retryable
--                                waiting_for_retry Task may claim
--                                another Run" (tied to RUNS-P1's
--                                Task.status = 'waiting_for_retry';
--                                does not itself authorize a retry -
--                                core/tact-work/taskRunReconciliation.ts's
--                                evaluateTaskRetryEligibility() combines
--                                it with the existing non-temporal
--                                conditions).
--
-- All three are nullable timestamptz (this repo's existing convention
-- for every other future-facing gate timestamp - see tact_approvals.
-- expires_at and tact_clarifications.expires_at, both timestamptz null,
-- from 20260905000000_create_tact_work_tables.sql and
-- 20260910000000_create_tact_clarifications.sql). No CHECK constraint
-- is needed (these are timestamps, not enums). No index is added -
-- nothing in this phase queries "all Tasks whose next_retry_at has
-- passed" at scale; a future scheduling phase (TIME-P1b or later)
-- should add one only once it actually needs that query.
--
-- No backfill: every existing row gets NULL for all three columns,
-- which is exactly "no deadline set" / "no wait gate" / "no retry
-- scheduled" - the correct default for rows that predate this concept.
-- ADD COLUMN ... NULL never rewrites existing table storage and never
-- fails existing-row validation (unlike a CHECK constraint change).

ALTER TABLE public.tact_works
  ADD COLUMN IF NOT EXISTS deadline timestamptz NULL;

ALTER TABLE public.tact_tasks
  ADD COLUMN IF NOT EXISTS wait_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz NULL;
