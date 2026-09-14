-- RUNS-P1b: Retryable Task Lifecycle
--
-- Adds an explicit, non-terminal Task status distinguishing "the most
-- recent Run failed but the Task itself is not terminally failed" from
-- the existing terminal "failed" status. This lets a retryable provider
-- failure (core/tact-integration/types.ts's IntegrationExecutionError.
-- retryable, already persisted since RUNS-P1 into tact_runs.external_ref)
-- project onto Task lifecycle without ever moving a Task backward out of
-- the terminal "failed" state (no non-monotonic transition is introduced
-- - "failed" remains reachable only once, and once reached it still means
-- exactly what it always meant: terminal, non-recoverable).
--
-- 'waiting_for_retry' does NOT mean "will retry automatically" - no
-- scheduler/timer/cron is introduced by this migration or by the
-- application code that uses this value (RUNS-P1b explicitly defers
-- WHEN a retry happens to a future TIME-P1 phase). It only means "a new
-- Run for this Task is semantically allowed; the Task is waiting for
-- that future attempt."
--
-- Postgres auto-names an inline column CHECK constraint as
-- "<table>_<column>_check" (tact_tasks.status here) - same convention
-- already relied on by 20260921000000_add_gmail_work_semantics.sql for
-- tact_works's array columns.
ALTER TABLE public.tact_tasks
  DROP CONSTRAINT IF EXISTS tact_tasks_status_check;

ALTER TABLE public.tact_tasks
  ADD CONSTRAINT tact_tasks_status_check
  CHECK (status IN ('pending', 'running', 'waiting_for_retry', 'completed', 'failed', 'cancelled'));
