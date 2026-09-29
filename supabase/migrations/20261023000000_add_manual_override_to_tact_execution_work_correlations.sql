-- =====================================================================
-- Migration: Manual Override / Reclassification Boundary
-- (SOR-52 Closeout Hardening Part3)
-- =====================================================================
--
-- 背景: Codex監査でSOR-52 Completion Reportの「manual override/
-- reclassificationはfuture design」という記述が指摘され、SOR-53
-- Timelineへ進む前に正式なdomain/store boundaryだけを実装することに
-- なった(UIは不要)。
--
-- tact_execution_work_correlations自体は変更しない設計方針
-- (「新しいhistory概念は作らない」、SOR-52 Closeout Hardening指示
-- Section4)——既存のappend-only historyへ、method='manual_override'の
-- 行を追加できるようにするための、最小限の追加列のみを行う。
--
-- 絶対条件(「silent overwrite禁止」): 「なぜ・誰が・何から何へ変更
-- したか」を追跡可能にするため、previous_work_id(変更前のwork_id)と
-- changed_by_actor_kind/id(変更を行ったactor)を追加する。auto
-- pipeline(explicit/structural/temporal_participant/ai_assisted)の
-- 結果ではいずれも常にnullのまま(意味を持つのはmethod=
-- 'manual_override'の行のみ)。
--
-- =====================================================================

alter table public.tact_execution_work_correlations
  add column if not exists previous_work_id uuid null references public.tact_works (id) on delete set null;

alter table public.tact_execution_work_correlations
  add column if not exists changed_by_actor_kind text null;

alter table public.tact_execution_work_correlations
  drop constraint if exists tact_execution_work_correlations_changed_by_actor_kind_check;

alter table public.tact_execution_work_correlations
  add constraint tact_execution_work_correlations_changed_by_actor_kind_check
  check (
    changed_by_actor_kind is null
    or changed_by_actor_kind in ('human', 'ai_agent', 'service', 'connector', 'system')
  );

alter table public.tact_execution_work_correlations
  add column if not exists changed_by_actor_id text null;

alter table public.tact_execution_work_correlations
  drop constraint if exists tact_execution_work_correlations_changed_by_actor_id_check;

alter table public.tact_execution_work_correlations
  add constraint tact_execution_work_correlations_changed_by_actor_id_check
  check (changed_by_actor_id is null or char_length(changed_by_actor_id) between 1 and 255);

-- methodへmanual_overrideを追加する(既存のCHECK制約を置き換える、
-- 既存migration(20261022000000)と同じ「drop/add constraint」方式)。
alter table public.tact_execution_work_correlations
  drop constraint if exists tact_execution_work_correlations_method_check;

alter table public.tact_execution_work_correlations
  add constraint tact_execution_work_correlations_method_check
  check (method in ('explicit', 'structural', 'temporal_participant', 'ai_assisted', 'manual_override'));

create index if not exists idx_tact_execution_work_correlations_method
  on public.tact_execution_work_correlations (method);
