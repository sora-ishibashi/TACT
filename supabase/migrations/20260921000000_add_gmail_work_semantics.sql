-- GMAIL-P1: extend only the bounded canonical WORK-P1 semantic allowlists.
-- Existing values remain valid; no arbitrary strings are permitted.
ALTER TABLE public.tact_works
  DROP CONSTRAINT IF EXISTS tact_works_required_capabilities_array_check;

ALTER TABLE public.tact_works
  ADD CONSTRAINT tact_works_required_capabilities_array_check
  CHECK (
    required_capabilities IS NULL OR (
      cardinality(required_capabilities) <= 4 AND
      required_capabilities <@ ARRAY[
      'organizational_context.read',
      'communication.read',
      'communication.write'
      ]::text[]
    )
  );

ALTER TABLE public.tact_works
  DROP CONSTRAINT IF EXISTS tact_works_completion_conditions_array_check;

ALTER TABLE public.tact_works
  ADD CONSTRAINT tact_works_completion_conditions_array_check
  CHECK (
    completion_conditions IS NULL OR (
      cardinality(completion_conditions) <= 8 AND
      completion_conditions <@ ARRAY[
      'subject_identified',
      'organizational_context_checked',
      'communication_checked',
      'reply_prepared',
      'approval_granted',
      'communication_sent',
      'result_synthesized',
      'result_delivered'
      ]::text[]
    )
  );
