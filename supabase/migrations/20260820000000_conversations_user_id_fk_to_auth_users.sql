-- =====================================================================
-- Migration: conversations.user_id FKをauth.usersへ向け直す
-- =====================================================================
--
-- 背景 (STEP131〜133):
--   STEP131/132でSupabase Authによる認証基盤(getAuthenticatedUser())を
--   実装し、server側で検証したuserId(auth.users.id)をconversationsへ
--   保存しようとしたところ、以下のFK違反が発生することがSTEP132の
--   実機E2Eテストで確認された。
--
--     insert or update on table "conversations" violates
--     foreign key constraint "conversations_user_id_fkey"
--     Key is not present in table "users".
--
--   原因: conversations.user_idは、当初の想定(20260811120000の
--   マイグレーションのコメント参照)通りpublic.users(id)へのFKとして
--   作成されていたが、Supabase Authが作成するユーザーはauth.usersに
--   のみ存在し、public.usersには反映されない
--   (STEP130で確認済みの通り、public.usersは現在のConversation
--   フローから一切使われていない未使用テーブル)。
--
-- 対応方針 (STEP133):
--   TACTの認証主体はSupabase Auth(auth.users)であるため、
--   conversations.user_idの参照先をpublic.users(id)から
--   auth.users(id)へ変更する。public.usersとの同期Trigger等の
--   追加レイヤーは新設しない(第一候補として不採用と判断済み)。
--
-- 事前確認 (STEP133、anonキーでの読み取りにより確認):
--   - conversations総数: 117件
--   - user_idが非nullの行: 0件
--   したがって、既存データが新FK制約に抵触することはない
--   (削除・書き換えが必要なデータは存在しない)。
--
-- 型の整合性:
--   auth.users.id / public.users.id / conversations.user_id は
--   いずれもuuid型であり、型変更は不要
--   (20260811120000マイグレーションの列定義をそのまま維持する)。
--
-- スコープ外(今回行わないこと):
--   - public.usersテーブル自体の削除・スキーマ変更
--   - auth.users → public.usersの同期Trigger新設
--   - RLSポリシーの全面変更(既存のStage 0許可的ポリシーは維持する)
--   - conversations列の型変更
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 既存FK制約の削除(public.users参照)
-- ---------------------------------------------------------------------

alter table public.conversations
  drop constraint if exists conversations_user_id_fkey;


-- ---------------------------------------------------------------------
-- 2. 新FK制約の追加(auth.users参照)
-- ---------------------------------------------------------------------
--
-- 元の定義(20260811120000)と同じくnullable・ON DELETE SET NULLを
-- 維持する(未認証Conversationはuser_id = nullのまま存続でき、
-- Authユーザーが削除された場合もconversations自体は消さない)。

alter table public.conversations
  add constraint conversations_user_id_fkey
  foreign key (user_id)
  references auth.users (id)
  on delete set null;


-- ---------------------------------------------------------------------
-- 3. RLS / public.users について
-- ---------------------------------------------------------------------
--
-- 既存のRLSポリシー(20260811120000で作成した
-- conversations_*_anon_stage0等、USING(true)の許可的ポリシー)は
-- 一切変更しない。RLSの本格導入(auth.uid() = user_id への差し替え)は
-- STEP133のスコープ外。
--
-- public.usersテーブル自体もこのマイグレーションでは一切変更しない
-- (削除・列追加・Trigger新設のいずれも行わない)。
