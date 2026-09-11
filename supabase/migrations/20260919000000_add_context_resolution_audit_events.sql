-- CONTEXT-P2: retain a closed, content-free audit taxonomy for bounded
-- multi-source context resolution. Prior migrations remain immutable.
alter table public.tact_audit_events
  drop constraint if exists tact_audit_events_event_type_check;

alter table public.tact_audit_events
  add constraint tact_audit_events_event_type_check
  check (event_type in (
    'work.created', 'task.created', 'policy.evaluated',
    'approval.requested', 'approval.approved', 'approval.rejected',
    'clarification.requested', 'clarification.answered',
    'run.created', 'run.completed', 'run.failed',
    'provider.called', 'provider.completed', 'provider.failed',
    'context.requested', 'context.retrieved', 'context.failed',
    'context.resolution.planned', 'context.source.requested',
    'context.source.completed', 'context.source.failed',
    'context.pack.built'
  ));
