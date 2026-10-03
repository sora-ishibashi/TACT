-- SOR-8A: Runs-owned authenticated telemetry source metadata. Secrets are
-- deliberately resolved only from deployment secret management, never here.
create table public.tact_telemetry_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text not null unique check (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  provider text not null check (provider in ('openai','anthropic','mcp','slack','gmail','google_calendar','notion','microsoft365','salesforce','custom')),
  source_type text not null check (source_type in ('webhook','poll','manual_report','sdk_callback','runtime_dispatch')),
  connection_id uuid null,
  observation_mode text null check (observation_mode is null or observation_mode in ('inline','instrumented','reconciled')),
  pre_execution_visible boolean not null default false,
  trust_level text not null check (trust_level in ('UNTRUSTED','AUTHENTICATED','INTERNAL')),
  status text not null check (status in ('ACTIVE','DISABLED','REVOKED')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), revoked_at timestamptz null,
  unique (id, user_id)
);
create table public.tact_telemetry_source_keys (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null, user_id uuid not null,
  key_id text not null check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  status text not null check (status in ('ACTIVE','RETIRED','REVOKED')),
  valid_from timestamptz null, valid_until timestamptz null, revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  foreign key (source_id, user_id) references public.tact_telemetry_sources(id, user_id) on delete cascade,
  unique (source_id, key_id), unique (id, user_id)
);
alter table public.tact_telemetry_sources enable row level security;
alter table public.tact_telemetry_source_keys enable row level security;
create policy "tact_telemetry_sources_select_own" on public.tact_telemetry_sources for select using (auth.uid() = user_id);
create policy "tact_telemetry_source_keys_select_own" on public.tact_telemetry_source_keys for select using (auth.uid() = user_id);
