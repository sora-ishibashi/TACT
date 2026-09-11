-- WORK-P1: persist bounded, provider-independent delegated Work semantics.
-- Context bodies and provider payloads remain out of tact_works; evidence_refs
-- contains only small canonical provenance references.
alter table public.tact_works
  add column if not exists subject text null,
  add column if not exists request_type text null,
  add column if not exists completion_conditions text[] null,
  add column if not exists required_capabilities text[] null,
  add column if not exists evidence_refs jsonb null,
  add column if not exists result_delivered_at timestamptz null;

alter table public.tact_works
  drop constraint if exists tact_works_request_type_check;

alter table public.tact_works
  add constraint tact_works_request_type_check
  check (request_type is null or request_type in ('inspect', 'prepare', 'act', 'monitor', 'unknown'));

alter table public.tact_works
  drop constraint if exists tact_works_completion_conditions_array_check;

alter table public.tact_works
  add constraint tact_works_completion_conditions_array_check
  check (
    completion_conditions is null or (
      cardinality(completion_conditions) <= 8 and
      completion_conditions <@ array[
        'subject_identified', 'organizational_context_checked',
        'communication_checked', 'result_synthesized', 'result_delivered'
      ]::text[]
    )
  );

alter table public.tact_works
  drop constraint if exists tact_works_required_capabilities_array_check;

alter table public.tact_works
  add constraint tact_works_required_capabilities_array_check
  check (
    required_capabilities is null or (
      cardinality(required_capabilities) <= 4 and
      required_capabilities <@ array[
        'organizational_context.read', 'communication.read'
      ]::text[]
    )
  );

alter table public.tact_works
  drop constraint if exists tact_works_evidence_refs_array_check;

alter table public.tact_works
  add constraint tact_works_evidence_refs_array_check
  check (evidence_refs is null or jsonb_typeof(evidence_refs) = 'array');

-- Extend the closed audit taxonomy without copying context content into audit.
alter table public.tact_audit_events
  drop constraint if exists tact_audit_events_event_type_check;

alter table public.tact_audit_events
  add constraint tact_audit_events_event_type_check
  check (event_type in (
    'work.created', 'work.intent.resolved', 'work.completion.evaluated',
    'work.completed', 'work.blocked', 'task.created', 'policy.evaluated',
    'approval.requested', 'approval.approved', 'approval.rejected',
    'clarification.requested', 'clarification.answered',
    'run.created', 'run.completed', 'run.failed',
    'provider.called', 'provider.completed', 'provider.failed',
    'context.requested', 'context.retrieved', 'context.failed',
    'context.resolution.planned', 'context.source.requested',
    'context.source.completed', 'context.source.failed',
    'context.pack.built'
  ));
