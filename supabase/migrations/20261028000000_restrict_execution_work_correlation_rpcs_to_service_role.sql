-- =====================================================================
-- Migration: Restrict Execution Work Correlation RPCs to service_role
-- (SOR-53 hardening, discovered during SOR-56 real Supabase verification)
-- =====================================================================
--
-- 背景(SOR-56実Staging検証で発見): 20261025000000migrationが作成した
-- public.apply_execution_work_correlation() / public.reclassify_execution_work()
-- はSECURITY DEFINERで、function body自体はauth.uid()を検証せず、
-- caller-supplied p_user_idをそのまま信頼する設計(呼び出し元
-- core/tact-execution/correlation/store.tsがservice role client経由で
-- 呼ぶことを前提とする既存契約、20261025000000migrationのコメント
-- 「SECURITY DEFINERの理由」参照)。
--
-- 20261025000000migration自身は`revoke all on function ... from public`
-- (PUBLIC疑似ロールからの剥奪)を既に行っていたが、Supabaseの新規
-- project既定の"ALTER DEFAULT PRIVILEGES"設定により、anon/authenticated
-- ロールにはPUBLIC経由ではなく個別に直接EXECUTEが付与されるため、
-- PUBLICからのrevokeだけではanon/authenticatedのEXECUTE権限は
-- 消えない(実Staging上のpg_proc.proaclで確認済み:
-- anon/authenticated/postgres/service_roleいずれもEXECUTE権限を保持)。
--
-- 結果として、anon/authenticated権限しか持たない呼び出し元が、
-- 他tenantのuuidを知っていればp_user_idへ偽装値を渡し、SECURITY
-- DEFINERによってRLSを迂回したままcorrelation state(work_id/
-- correlation_status/履歴)を書き換えられる可能性があった。
--
-- このmigrationはこの権限境界だけを閉じる。対象は2関数のEXECUTE権限
-- のみ——絶対条件(Human Owner指示): RPC本体のbusiness logic /
-- transaction / concurrency semanticsは一切変更しない(CREATE OR
-- REPLACEし直さない)。SECURITY DEFINER・search_path=public・
-- p_user_id semanticsもすべて既存のまま。20261025000000migration
-- 自体も編集しない(Staging適用済みのため、forward-onlyで対応する)。
--
-- PostgreSQLのfunction privilegeはfunction名だけでは一意に定まらない
-- ため(overloadの可能性)、pg_get_function_identity_arguments()で
-- 実Staging上から確認したexact identity argumentsをそのまま指定する。
--
-- =====================================================================

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
