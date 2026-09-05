-- =====================================================================
-- Migration: Add UPDATE policy to tact_tasks (Architecture Migration
-- Phase B2)
-- =====================================================================
--
-- 背景: Phase B1(20260905000000migration)は、core/tact-work/store.ts
-- がTask作成(select/insert)のみを行う前提で、tact_tasksへselect/insert
-- policyだけを定義していた(tact_conversation_messages/
-- tact_execution_recordsと同じ「使わない操作のpolicyを先回りで
-- 作らない」既存方針)。
--
-- Phase B2でCanonical Work ModelをOrchestrator実行へ接続するにあたり、
-- core/tact-work/store.tsへupdateTaskStatus()を追加し、実Executionの
-- 進行に合わせてTask.status(pending→running→completed/failed/
-- cancelled)を更新する必要が生じたため、この1操作分のpolicyだけを
-- 追加する。
--
-- 既存のtact_tasks select/insert policy、および他テーブルのRLSは
-- 一切変更しない。

drop policy if exists "tact_tasks_update_own" on public.tact_tasks;
create policy "tact_tasks_update_own"
  on public.tact_tasks for update
  using (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );
