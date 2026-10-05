revoke execute on function public.replace_tact_runs_connection_projection_snapshot(
  uuid, timestamptz, jsonb
) from public;

revoke execute on function public.replace_tact_runs_connection_projection_snapshot(
  uuid, timestamptz, jsonb
) from anon;

revoke execute on function public.replace_tact_runs_connection_projection_snapshot(
  uuid, timestamptz, jsonb
) from authenticated;

grant execute on function public.replace_tact_runs_connection_projection_snapshot(
  uuid, timestamptz, jsonb
) to service_role;
