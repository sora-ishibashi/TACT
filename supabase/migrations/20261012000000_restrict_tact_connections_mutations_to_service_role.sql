-- TIME-P1c calendar wiring hardening.
--
-- A tact_connections row carries a provider_connection_ref and an active
-- status, both of which are execution authority. Authenticated clients may
-- continue to read only their own rows through the existing SELECT policy,
-- but may never manufacture or mutate connection authority directly.
-- Canonical server provisioning uses the Supabase service-role client.

alter table public.tact_connections enable row level security;

drop policy if exists "tact_connections_insert_own" on public.tact_connections;
drop policy if exists "tact_connections_update_own" on public.tact_connections;
drop policy if exists "tact_connections_delete_own" on public.tact_connections;

revoke insert, update, delete on table public.tact_connections from anon;
revoke insert, update, delete on table public.tact_connections from authenticated;
