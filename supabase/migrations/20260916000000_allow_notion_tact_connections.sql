-- Extend the existing canonical service allowlist only. Ownership, RLS,
-- status, and provider constraints deliberately remain unchanged.
alter table public.tact_connections
  drop constraint tact_connections_service_check,
  add constraint tact_connections_service_check
    check (service in ('slack', 'gmail', 'notion'));
