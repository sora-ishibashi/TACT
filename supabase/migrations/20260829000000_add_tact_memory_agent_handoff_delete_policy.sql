-- =========================================================================
-- tact_memory: Agent Handoff用の限定DELETEポリシー追加(Phase103)
-- =========================================================================
--
-- 背景(Phase102 Reality Testで実際に確認した問題):
-- core/tact-agent/(Phase101)は、既存のtact_memoryテーブルを
-- type='task' + content.recordKind('development_task'|'agent_handoff')
-- として再利用する設計(core/codeAgent/store.tsのCodeTaskと同じ
-- type='task'バケツを共有し、recordKindで判別する)。
--
-- tact_memoryには元々SELECT/INSERT/UPDATEのStage 0ポリシー
-- (20260821000000_create_brain_memory_tables.sql)しか無く、DELETEが
-- 一切許可されていなかった。そのため、Phase102で作成したテスト用の
-- DevelopmentTask/HandoffStateを、anonキー経由では削除できないことが
-- 実際に確認された(削除APIはエラーを返さず、対象0件のまま残存する)。
--
-- 対応方針(Phase103 Step4の優先順位に従う):
-- - Service Role経路・既存の管理用DB操作パターンは存在しないことを
--   確認済み(grepでSERVICE_ROLE系の既存利用が無いことを確認)。
-- - anonユーザーへの無条件DELETE権限は追加しない(絶対条件)。
-- - 代わりに、DELETE対象を「content.recordKindが
--   'development_task'または'agent_handoff'であるレコードのみ」に
--   限定したポリシーを追加する。CodeTask(recordKindを持たない、
--   content->>'recordKind'がnullのためIN条件に一致しない)・
--   ImprovementProposal・fact/preference等の既存type値の行は、
--   このポリシーの対象に一切ならない(既存データへの影響ゼロ)。
--
-- これにより「誰が・どの条件で削除できるか」が明確になる:
-- anonキーを持つ任意のクライアントが、tact_memory内の
-- Agent Handoff由来レコード(DevelopmentTask/HandoffState)のみを
-- 削除できる。これはSELECT/INSERT/UPDATEが既に無条件(Stage 0)で
-- 許可されている既存の設計と整合的であり(同じテーブルに対して
-- DELETEだけがrecordKind条件付きで、他の操作より厳しい)、
-- 既存のCodeTask/ImprovementProposal等の削除経路を一切新設しない。

drop policy if exists "tact_memory_delete_agent_handoff_anon_stage0" on public.tact_memory;
create policy "tact_memory_delete_agent_handoff_anon_stage0"
  on public.tact_memory for delete
  using (content ->> 'recordKind' in ('development_task', 'agent_handoff'));
