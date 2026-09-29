-- =====================================================================
-- Migration: Attention Lifecycle Audit Fields (SOR-48 / SOR-18)
-- =====================================================================
--
-- 背景 (SOR-48): tact_execution_attentions(20261027000000migration)は
-- 当初からstatus CHECK制約に'acknowledged'/'resolved'を含めていた
-- (将来のlifecycle workflowのための拡張余地、当時のmigrationコメント
-- 参照)が、実際にその状態へ遷移させる仕組みは一切実装されていなかった
-- ——このmigrationは、その遷移を後から正しく説明できるようにする
-- ための最小限の加算的audit列を追加するだけであり、status列自体や
-- 既存CHECK制約・既存行は一切変更しない。
--
-- 4列構成にした理由(Human Owner承認済み設計、docs/ai等参照不要
-- ——この会話内のPhase4判断): updated_at(既存、trigger式)は
-- 「直近の更新」しか表さず、acknowledgeとresolveが両方起きた場合、
-- 更新のたびに上書きされるため、acknowledgeが実際にいつ起きたかを
-- 永久に失う。acknowledged_at/resolved_atという別々の列だけがこれを
-- 保存できる。acknowledged_by/resolved_byは「誰が」の記録
-- (将来の複数reviewer対応やaudit要件への備え、v1-minimalのUIでは
-- 表示しない——tact_execution_attentions.user_idと同一人物にしか
-- なり得ないため)。
--
-- 既存行への影響(絶対条件、forward-only): 4列すべてNULL許容・
-- default無しの加算的列のみ。既存の全'open'行はこの4列がNULLのまま
-- 残る(preserve existing Attention rows as open)。既存constraint・
-- 既存index・既存trigger・既存RLS policyはいずれも変更しない
-- ——書き込みは引き続きservice role専用(insert/update policy無し)、
-- 遷移(UPDATE)もcore/tact-execution/permission/attentionStore.tsの
-- transitionExecutionAttention()からservice role経由でのみ行う。
--
-- =====================================================================

alter table public.tact_execution_attentions
  add column if not exists acknowledged_at timestamptz null;

alter table public.tact_execution_attentions
  add column if not exists acknowledged_by uuid null references auth.users (id) on delete set null;

alter table public.tact_execution_attentions
  add column if not exists resolved_at timestamptz null;

alter table public.tact_execution_attentions
  add column if not exists resolved_by uuid null references auth.users (id) on delete set null;
