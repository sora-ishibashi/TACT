-- =====================================================================
-- Migration: Read-only accessor for Supabase's own applied-migration
-- history (TACT SEC-P0-4: Pre-Live Remediation)
-- =====================================================================
--
-- 背景(docs/architecture/pre-live-full-audit.md P0 finding #4):
--   過去実際に、Production Supabaseへtact_clarifications・
--   tact_audit_events・allowed_approver_idsが未適用のまま気づかずに
--   運用していた事故が発生した。repository上には「repoが期待する
--   migrationがremote DBに未適用」を検知する仕組みが存在しなかった。
--
-- 方針(絶対条件、automatic migration applyはしない):
--   Supabase CLIは既に`supabase_migrations.schema_migrations`という
--   システムテーブルへ、適用済みmigrationのversion(このrepositoryの
--   命名規則そのままの`YYYYMMDDHHMMSS`文字列)を自動的に記録している
--   (CLIで`supabase migration up`/dashboard経由で適用した場合の
--   いずれも)。新しいtracking機構は作らず、この既存の仕組みを
--   そのまま読むだけにする。
--
--   ただし`supabase_migrations`スキーマはPostgRESTへ公開されていない
--   ため、`@supabase/supabase-js`から直接selectすることはできない。
--   このmigrationは、それを読むための最小限のSECURITY DEFINER
--   関数を1つだけ追加する(読み取り専用、書き込みは一切行わない)。
--
--   Supabase自身のこの記録機構を書き換える権限は誰にも与えない
--   (関数はSELECTのみ)。実行権限はservice_roleにのみ付与し、
--   anon/authenticatedには一切公開しない(migration version文字列
--   自体はsecretではないが、内部運用情報を不必要に公開しない、
--   念のための最小権限の原則)。
-- =====================================================================

create or replace function public.tact_check_applied_migrations()
returns table (version text)
language sql
security definer
set search_path = public
as $$
  select version
  from supabase_migrations.schema_migrations
  order by version;
$$;

revoke all on function public.tact_check_applied_migrations() from public;
revoke all on function public.tact_check_applied_migrations() from anon;
revoke all on function public.tact_check_applied_migrations() from authenticated;
grant execute on function public.tact_check_applied_migrations() to service_role;
