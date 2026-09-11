-- Remediate deployed databases whose service allowlist predates Notion.
-- Keep the canonical service set constrained while leaving all other
-- tact_connections columns and constraints unchanged.
alter table public.tact_connections
  drop constraint if exists tact_connections_service_check;

alter table public.tact_connections
  add constraint tact_connections_service_check
    check (service in ('slack', 'gmail', 'notion'));
