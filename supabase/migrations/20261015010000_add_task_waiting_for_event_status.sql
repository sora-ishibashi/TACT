-- EVENT-P1a: Add "waiting_for_event" Task Status
--
-- Adds a new non-terminal Task status distinguishing "this Task is
-- blocked on a pending tact_event_waits row" from every other existing
-- Task status. Mirrors 20260930000000_add_task_waiting_for_retry_status.sql
-- exactly: a separate migration from the table-creation migration
-- (20261015000000_create_tact_event_model.sql) so the two concerns -
-- "the EventWait tables exist" and "Task.status may reference them" -
-- can be reasoned about and reverted independently.
--
-- Architecture Decision (EVENT-P1a): Task.status = "waiting_for_event"
-- is a lifecycle projection, not the source of truth. The canonical
-- waiting-condition record is the tact_event_waits row itself
-- (status = "pending"). A Task may only enter "waiting_for_event" while
-- a pending tact_event_waits row exists for it; this migration does not
-- enforce that invariant at the database level (no trigger/constraint is
-- added) - enforcing it is the responsibility of the future write path
-- that transitions a Task into this status (EVENT-P1b/c scope, not yet
-- implemented). This is the same division of responsibility already
-- used for "waiting_for_retry" (RUNS-P1b): the DB only widens the set of
-- allowed values, application code owns the actual transition rules.
--
-- "waiting_for_event" does NOT mean "will resume automatically" - no
-- matching engine, wait claim, or resume dispatch is introduced by this
-- migration or by any EVENT-P1a application code. It only means "a new
-- Run for this Task is semantically blocked until a matching
-- ExternalEvent satisfies the associated EventWait."
--
-- Postgres auto-names an inline column CHECK constraint as
-- "<table>_<column>_check" (tact_tasks.status here) - same convention
-- already relied on by 20260930000000_add_task_waiting_for_retry_status.sql.
ALTER TABLE public.tact_tasks
  DROP CONSTRAINT IF EXISTS tact_tasks_status_check;

ALTER TABLE public.tact_tasks
  ADD CONSTRAINT tact_tasks_status_check
  CHECK (status IN ('pending', 'running', 'waiting_for_retry', 'waiting_for_event', 'completed', 'failed', 'cancelled'));
