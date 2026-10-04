-- =====================================================================
-- SOR-148 — Restrict correlation RPC execution to service_role
-- =====================================================================
--
-- The two correlation functions are intentional SECURITY DEFINER internal
-- primitives. Their body, owner, and fixed search_path remain unchanged.
-- This additive migration closes the separately observed live ACL drift:
-- neither PostgREST's anon nor authenticated role may invoke them, while
-- the Runs ingestion/correlation service-role path remains available.
--
-- Use full identity signatures so a future overload cannot accidentally
-- inherit this function's hardening assumptions.
--

revoke execute on function public.apply_execution_work_correlation(
  uuid, uuid, text, text, text, text, text, uuid, real, uuid[], jsonb
) from public;

revoke execute on function public.apply_execution_work_correlation(
  uuid, uuid, text, text, text, text, text, uuid, real, uuid[], jsonb
) from anon;

revoke execute on function public.apply_execution_work_correlation(
  uuid, uuid, text, text, text, text, text, uuid, real, uuid[], jsonb
) from authenticated;

grant execute on function public.apply_execution_work_correlation(
  uuid, uuid, text, text, text, text, text, uuid, real, uuid[], jsonb
) to service_role;

revoke execute on function public.reclassify_execution_work(
  uuid, uuid, uuid, uuid, text, text, text, jsonb
) from public;

revoke execute on function public.reclassify_execution_work(
  uuid, uuid, uuid, uuid, text, text, text, jsonb
) from anon;

revoke execute on function public.reclassify_execution_work(
  uuid, uuid, uuid, uuid, text, text, text, jsonb
) from authenticated;

grant execute on function public.reclassify_execution_work(
  uuid, uuid, uuid, uuid, text, text, text, jsonb
) to service_role;
