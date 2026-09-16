-- =====================================================================
-- Migration: Conversation Origin Boundary — Phase 2 (Enforcement)
-- =====================================================================
--
-- 前提(Deployment Contract、20261013000000migrationのコメント参照):
--   このmigrationは、以下がすべて完了した後にのみ適用すること。
--     1. 20261013000000_add_origin_to_tact_conversations.sql(Phase1)
--        を適用済み
--     2. origin列・backfill・indexが期待通りであることを確認済み
--     3. 新アプリケーションコード(Research/Core/Slackの全Conversation
--        作成経路がoriginを明示的に書き込む版)をdeploy済み
--     4. 新コードが実際に全経路でoriginを書き込んでいることを確認済み
--     5. 以下のクエリが0件を返すことを確認済み:
--          select count(*) from public.tact_conversations
--          where origin is null;
--
--   Phase1と本Phase2を1つのmigrationに戻さないこと——Rolling Deploy/
--   Serverless Deployのいずれでも「新schemaが適用された直後、まだ旧
--   コード(originを渡さないINSERT)が動いている」瞬間が必ず存在し、
--   その瞬間にNOT NULL制約があるとConversation作成そのものが落ちる
--   (Integration Phase監査Section6/8参照)。
--
-- 安全策(Section7「NOT NULLを設定する前に、repositoryのmigration
-- styleが対応していればpreconditionをassert/includeする」):
--   本repositoryのmigrationにはこれまでDO blockによる明示的assertion
--   の前例が無いが、今回はDeployment Contractの手順ミス(Step5の確認を
--   怠ったまま本migrationを流した場合)を、Postgresの一般的な制約違反
--   エラーではなく、原因が一目でわかるメッセージとして検出できるように
--   するため、標準的なPL/pgSQL DO blockで明示的にNULL件数を確認してから
--   ALTER TABLEへ進む(新しいmigration frameworkや外部ツールは導入せず、
--   標準SQLの範囲内で完結させる)。
--
-- =====================================================================

do $$
declare
  null_origin_count bigint;
begin

  select count(*)
  into null_origin_count
  from public.tact_conversations
  where origin is null;

  if null_origin_count > 0 then
    raise exception
      'tact_conversations.origin still has % NULL row(s). '
      'Deploy the application code that writes origin on every creation '
      'path (Research/Core/Slack) and confirm '
      '"select count(*) from public.tact_conversations where origin is null" '
      'returns 0 before applying this migration.',
      null_origin_count;
  end if;

end $$;

alter table public.tact_conversations
  alter column origin set not null;
