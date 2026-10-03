-- SOR-136: Runs-owned observation surfaces and append-only capture gaps.
-- No cross-product foreign keys: user ownership is the tenancy boundary.
create table if not exists public.tact_observation_surfaces (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (char_length(source) between 1 and 255),
  provider text not null check (provider in ('openai','anthropic','mcp','slack','gmail','google_calendar','notion','microsoft365','salesforce','custom')),
  observation_mode text not null check (observation_mode in ('INLINE','INSTRUMENTED','RECONCILED','OTHER')),
  connection_ref text null, scope_ref text null, observable_capabilities jsonb not null default '[]'::jsonb,
  identity_transport text null, work_context_transport text null, permission_precheck_available boolean not null default false,
  last_seen_at timestamptz null, health text not null default 'UNKNOWN' check (health in ('UNKNOWN','HEALTHY','DEGRADED','OUTAGE')),
  coverage_status text not null default 'UNKNOWN' check (coverage_status in ('UNKNOWN','PARTIAL','COVERED','OUTAGE')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index if not exists idx_tact_observation_surfaces_user_updated on public.tact_observation_surfaces(user_id, updated_at desc);

create table if not exists public.tact_capture_gaps (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  observation_surface_id uuid not null,
  detected_at timestamptz not null, affected_from timestamptz null, affected_to timestamptz null, affected_scope text null,
  reason text not null check (char_length(reason) between 1 and 500), detection_method text not null check (char_length(detection_method) between 1 and 100),
  confidence text not null check (confidence in ('LOW','MEDIUM','HIGH')), status text not null check (status in ('UNKNOWN','PARTIAL','OUTAGE','GAP_DETECTED','RESOLVED')),
  resolved_at timestamptz null, evidence_ref text null, provenance jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
  check ((status = 'RESOLVED') = (resolved_at is not null)),
  foreign key (observation_surface_id, user_id) references public.tact_observation_surfaces(id, user_id) on delete restrict
);
create index if not exists idx_tact_capture_gaps_user_detected on public.tact_capture_gaps(user_id, detected_at desc);
create index if not exists idx_tact_capture_gaps_surface_detected on public.tact_capture_gaps(observation_surface_id, detected_at desc);

alter table public.tact_observation_surfaces enable row level security;
alter table public.tact_capture_gaps enable row level security;
create policy "tact_observation_surfaces_select_own" on public.tact_observation_surfaces for select using (auth.uid() = user_id);
create policy "tact_capture_gaps_select_own" on public.tact_capture_gaps for select using (auth.uid() = user_id);
-- No browser write policy: service-role application code scopes every write by user_id.
