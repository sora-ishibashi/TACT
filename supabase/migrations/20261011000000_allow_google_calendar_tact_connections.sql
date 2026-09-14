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
-- This file exists so the change is ready when a verified Composio Google
-- Calendar adapter actually lands (TIME-P1c Section 7 requires verifying
-- GOOGLECALENDAR_FIND_FREE_SLOTS's exact schema before implementing that
-- adapter; this phase could not verify it — see the final report's
-- COMPOSIO_SCHEMA_UNVERIFIED finding). Deliberately NOT paired with a
-- core/tact-integration/types.ts IntegrationService union change in this
-- phase: adding the type value with no adapter/provisioning/policy/mapper
-- behind it would let something claim a "google_calendar" connection that
-- nothing can actually service — that pairing is left until the adapter is
-- real (TIME-P1c Section 13: no partial production wiring).
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
