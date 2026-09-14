-- =====================================================================
-- TIME-P1c — Connection model audit (Section 6): prepared, LOCAL-ONLY
-- migration. NOT applied to any database as part of this phase.
-- =====================================================================
--
-- Audit finding: tact_connections.service is a fail-closed CHECK-constraint
-- allowlist (supabase/migrations/20260907000000_create_tact_connections.sql,
-- extended for gmail/notion by 20260915000000/20260916000000/20260917000000).
-- Extending it is the exact same one-line-allowlist-addition shape used for
-- every prior service; no other part of the Connection model (ownership,
-- RLS, provider, status) needs to change to represent a Calendar
-- connection's existence.
--
-- Update (TIME-P1c Calendar Wiring phase): the verified Composio
-- GOOGLECALENDAR_FIND_FREE_SLOTS adapter/mapper
-- (core/tact-integration/providers/composio/mappings/googleCalendar.ts,
-- googleCalendarFindFreeSlotsContract.ts) and the read-only Connection /
-- Policy / Provisioning / CapabilityBinding wiring for
-- "google_calendar" now exist in code (core/tact-integration/types.ts's
-- IntegrationService union, policy.ts's POLICY_ALLOWLIST, provisioning.ts,
-- connectionLink.ts, providers/composio/adapter.ts,
-- core/tact-orchestrator/capabilityPlan.ts). This migration is the one
-- remaining step to let a real "google_calendar" row exist in
-- tact_connections — it is still LOCAL-ONLY / NOT applied to any
-- database (including Preview/Production) as part of this phase; see the
-- final report's migration preflight review for the recommended
-- deployment order.
--
-- The identifier is "google_calendar" (not "calendar"), matching the
-- existing product-name convention for this column ("gmail", not "email";
-- "notion", not "workspace_notes"). This is the Connection.service
-- identifier only — a different concept from the canonical Capability name
-- "calendar.availability.read" added in core/tact-work/types.ts, which
-- Section 5 explicitly required to stay provider-neutral.

alter table public.tact_connections
  drop constraint if exists tact_connections_service_check;

alter table public.tact_connections
  add constraint tact_connections_service_check
    check (service in ('slack', 'gmail', 'notion', 'google_calendar'));
