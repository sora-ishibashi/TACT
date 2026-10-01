pragma foreign_keys = on;

create table runtime_metadata (
  key text primary key,
  value text not null
);

create table companies (
  id text primary key,
  name text not null unique,
  slug text not null unique
);

create table departments (
  id text primary key,
  company_id text not null references companies(id) on delete cascade,
  name text not null,
  unique(company_id, name)
);

create table employees (
  id text primary key,
  company_id text not null references companies(id) on delete cascade,
  department_id text not null references departments(id),
  display_name text not null,
  email text not null unique check (email like '%.test'),
  role text not null
);

create table customers (
  id text primary key,
  company_id text not null references companies(id) on delete cascade,
  name text not null,
  contact_email text not null unique check (contact_email like '%.test'),
  status text not null check (status in ('active', 'prospect'))
);

create table works (
  id text primary key,
  company_id text not null references companies(id) on delete cascade,
  scenario text not null check (scenario in ('sales', 'product', 'operations')),
  title text not null,
  objective text not null,
  status text not null check (status in ('planning', 'running', 'waiting_for_input', 'completed', 'failed')),
  owner_employee_id text not null references employees(id),
  customer_id text references customers(id)
);

create table documents (
  id text primary key,
  work_id text not null references works(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null
);

create table tasks (
  id text primary key,
  work_id text not null references works(id) on delete cascade,
  description text not null,
  status text not null check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  sequence integer not null check (sequence >= 1),
  unique(work_id, sequence)
);

create table conversation_fragments (
  id text primary key,
  work_id text not null references works(id) on delete cascade,
  channel_kind text not null,
  speaker_employee_id text not null references employees(id),
  body text not null,
  ordinal integer not null check (ordinal >= 1),
  unique(work_id, channel_kind, ordinal)
);

create table meetings (
  id text primary key,
  work_id text not null references works(id) on delete cascade,
  title text not null,
  held_at text not null,
  summary text not null
);

create table expected_executions (
  id text primary key,
  work_id text references works(id) on delete cascade,
  task_id text references tasks(id) on delete cascade,
  fixture_type text not null check (fixture_type = 'fixture_expectation'),
  source_kind text not null,
  correlation_mode text not null check (correlation_mode in ('explicit_work_id', 'missing_work_id')),
  expected_outcome text not null check (expected_outcome in ('success', 'failure', 'retry_success')),
  attempt integer not null check (attempt >= 1),
  retry_of text references expected_executions(id),
  observed integer not null check (observed = 0),
  check (
    (correlation_mode = 'explicit_work_id' and work_id is not null) or
    (correlation_mode = 'missing_work_id' and work_id is null and task_id is null)
  ),
  check ((attempt = 1 and retry_of is null) or (attempt > 1 and retry_of is not null))
);
