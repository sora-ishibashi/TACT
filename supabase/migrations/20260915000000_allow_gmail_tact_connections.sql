-- =====================================================================
-- Migration: Allow the canonical Gmail Connection service
-- =====================================================================
--
-- LIVE-1A added `gmail` to TACT's canonical IntegrationService union.
-- Keep the original Slack service valid and extend only this existing
-- table-level allowlist. Connection ownership, RLS, provider, and status
-- constraints are deliberately unchanged.

alter table public.tact_connections
  drop constraint tact_connections_service_check,
  add constraint tact_connections_service_check
    check (service in ('slack', 'gmail'));
