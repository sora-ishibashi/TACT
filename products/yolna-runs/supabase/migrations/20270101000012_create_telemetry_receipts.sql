-- SOR-8A: accepted signed receipt is the permanent replay claim.
alter table public.tact_canonical_executions
  add constraint tact_canonical_executions_id_user_id_unique unique (id, user_id);
create table public.tact_telemetry_receipts (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  telemetry_source_id uuid not null, telemetry_source_key_id uuid not null,
  received_at timestamptz not null default now(), request_timestamp timestamptz not null,
  nonce_hash text not null check (nonce_hash ~ '^[a-f0-9]{64}$'), content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  auth_scheme text not null default 'hmac-sha256-v1' check (auth_scheme = 'hmac-sha256-v1'),
  trust_level_snapshot text not null check (trust_level_snapshot in ('UNTRUSTED','AUTHENTICATED','INTERNAL')),
  source_id_snapshot text not null, key_id_snapshot text not null, created_at timestamptz not null default now(),
  foreign key (telemetry_source_id, user_id) references public.tact_telemetry_sources(id, user_id) on delete restrict,
  foreign key (telemetry_source_key_id, user_id) references public.tact_telemetry_source_keys(id, user_id) on delete restrict,
  unique (telemetry_source_id, telemetry_source_key_id, nonce_hash), unique (id, user_id)
);
create table public.tact_telemetry_receipt_execution_links (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  receipt_id uuid not null, execution_id uuid not null, linked_at timestamptz not null default now(),
  foreign key (receipt_id, user_id) references public.tact_telemetry_receipts(id, user_id) on delete restrict,
  foreign key (execution_id, user_id) references public.tact_canonical_executions(id, user_id) on delete restrict,
  unique (receipt_id, execution_id), unique (receipt_id)
);
alter table public.tact_telemetry_receipts enable row level security;
alter table public.tact_telemetry_receipt_execution_links enable row level security;
create policy "tact_telemetry_receipts_select_own" on public.tact_telemetry_receipts for select using (auth.uid() = user_id);
create policy "tact_telemetry_receipt_execution_links_select_own" on public.tact_telemetry_receipt_execution_links for select using (auth.uid() = user_id);
