-- CONTEXT-P1: extend the closed audit taxonomy without changing prior migrations.
alter table public.tact_audit_events
  drop constraint if exists tact_audit_events_category_check;

alter table public.tact_audit_events
  add constraint tact_audit_events_category_check
  check (category in (
    'work', 'task', 'policy', 'human_interaction',
    'approval', 'clarification', 'execution', 'provider', 'context'
  ));

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
    'context.requested', 'context.retrieved', 'context.failed'
  ));
