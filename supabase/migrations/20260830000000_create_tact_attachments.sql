-- =====================================================================
-- TACT Research Attachment Architecture: Phase 1 (PDF only)
-- =====================================================================

create table if not exists public.tact_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  mime_type text not null check (mime_type = 'application/pdf'),
  file_size_bytes bigint not null check (file_size_bytes > 0 and file_size_bytes <= 10485760),
  storage_bucket text not null check (storage_bucket = 'tact-attachments'),
  storage_path text not null unique,
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'processing', 'ready', 'failed', 'unavailable')),
  extracted_text text null,
  extracted_text_truncated boolean not null default false,
  extraction_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz null,
  check (
    (extraction_status = 'ready' and extracted_text is not null and deleted_at is null)
    or extraction_status <> 'ready'
  )
);

create index if not exists idx_tact_attachments_user_created_at
  on public.tact_attachments (user_id, created_at desc);

create index if not exists idx_tact_attachments_cleanup
  on public.tact_attachments (expires_at, extraction_status)
  where deleted_at is null;

create table if not exists public.tact_conversation_message_attachments (
  message_id uuid not null
    references public.tact_conversation_messages (id) on delete cascade,
  attachment_id uuid not null
    references public.tact_attachments (id) on delete restrict,
  position smallint not null check (position >= 0 and position < 4),
  created_at timestamptz not null default now(),
  primary key (message_id, attachment_id),
  unique (message_id, position)
);

create index if not exists idx_tact_conversation_message_attachments_attachment_id
  on public.tact_conversation_message_attachments (attachment_id);

-- A user message, its attachment links, and the transition from orphan to
-- linked retention must be all-or-nothing. tact_conversation_messages is
-- deliberately append-only, so client-side compensation cannot safely delete
-- a partially-created message.
create or replace function public.append_tact_conversation_message_with_attachments(
  p_conversation_id uuid,
  p_content text,
  p_attachment_ids uuid[]
)
returns public.tact_conversation_messages
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_message public.tact_conversation_messages;
  v_attachment_count integer;
  v_total_file_size bigint;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if coalesce(cardinality(p_attachment_ids), 0) < 1
     or cardinality(p_attachment_ids) > 4
     or cardinality(p_attachment_ids) <> (
       select count(distinct attachment_id)
       from unnest(p_attachment_ids) as attachment_id
     ) then
    raise exception 'invalid attachment ids' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.tact_conversations
    where id = p_conversation_id and user_id = auth.uid()
  ) then
    raise exception 'conversation is not available' using errcode = '42501';
  end if;

  select count(*), coalesce(sum(file_size_bytes), 0)
  into v_attachment_count, v_total_file_size
  from public.tact_attachments
  where id = any(p_attachment_ids)
    and user_id = auth.uid()
    and extraction_status = 'ready'
    and deleted_at is null
    and expires_at > now();

  if v_attachment_count <> cardinality(p_attachment_ids)
     or v_total_file_size > 20971520 then
    raise exception 'attachments are not available' using errcode = '22023';
  end if;

  insert into public.tact_conversation_messages (conversation_id, role, content)
  values (p_conversation_id, 'user', p_content)
  returning * into v_message;

  insert into public.tact_conversation_message_attachments (message_id, attachment_id, position)
  select v_message.id, attachment_id, position - 1
  from unnest(p_attachment_ids) with ordinality as items(attachment_id, position);

  update public.tact_attachments
  set expires_at = now() + interval '30 days'
  where id = any(p_attachment_ids)
    and user_id = auth.uid();

  update public.tact_conversations
  set updated_at = now()
  where id = p_conversation_id
    and user_id = auth.uid();

  return v_message;
end;
$$;

revoke all on function public.append_tact_conversation_message_with_attachments(uuid, text, uuid[]) from public;
grant execute on function public.append_tact_conversation_message_with_attachments(uuid, text, uuid[]) to authenticated;

create or replace function public.set_tact_attachments_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_attachments_updated_at on public.tact_attachments;
create trigger trg_tact_attachments_updated_at
before update on public.tact_attachments
for each row
execute function public.set_tact_attachments_updated_at();

alter table public.tact_attachments enable row level security;
alter table public.tact_conversation_message_attachments enable row level security;

create policy "tact_attachments_select_own"
  on public.tact_attachments for select
  using (auth.uid() = user_id);

create policy "tact_attachments_insert_own"
  on public.tact_attachments for insert
  with check (auth.uid() = user_id);

create policy "tact_attachments_update_own"
  on public.tact_attachments for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "tact_attachments_delete_own"
  on public.tact_attachments for delete
  using (auth.uid() = user_id);

create policy "tact_conversation_message_attachments_select_own"
  on public.tact_conversation_message_attachments for select
  using (
    exists (
      select 1
      from public.tact_conversation_messages m
      join public.tact_conversations c on c.id = m.conversation_id
      where m.id = message_id and c.user_id = auth.uid()
    )
  );

create policy "tact_conversation_message_attachments_insert_own"
  on public.tact_conversation_message_attachments for insert
  with check (
    exists (
      select 1
      from public.tact_conversation_messages m
      join public.tact_conversations c on c.id = m.conversation_id
      where m.id = message_id and c.user_id = auth.uid()
    )
    and exists (
      select 1 from public.tact_attachments a
      where a.id = attachment_id and a.user_id = auth.uid()
    )
  );

create policy "tact_conversation_message_attachments_delete_own"
  on public.tact_conversation_message_attachments for delete
  using (
    exists (
      select 1
      from public.tact_conversation_messages m
      join public.tact_conversations c on c.id = m.conversation_id
      where m.id = message_id and c.user_id = auth.uid()
    )
  );

insert into storage.buckets (id, name, public)
values ('tact-attachments', 'tact-attachments', false)
on conflict (id) do update set public = false;

create policy "tact_attachments_storage_select_own"
  on storage.objects for select
  using (
    bucket_id = 'tact-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "tact_attachments_storage_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'tact-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "tact_attachments_storage_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'tact-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
