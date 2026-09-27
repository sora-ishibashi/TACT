-- =====================================================================
-- Migration: Allow approval_required Permission Status (SOR-51 M-0)
-- =====================================================================
--
-- 背景 (SOR-51 M-0、Notion Permission Registry): 既存のPermission
-- Observation基盤(20261020000000/20261021000000migration)は
-- allowed/denied/unknownの3値のみを許容していた。M-0のNotion Test
-- Permission Matrixは、UPDATE_PAGEのように「実行可能性の可否ではなく
-- 人間承認が必須」という、denied/deniedのどちらとも異なる独立した
-- 状態を必要とする(絶対条件「Do not flatten approval into denied」、
-- core/tact-execution/permission/types.tsのPermissionDecisionStatus
-- コメント参照)。
--
-- 対象は2つのCHECK制約(いずれも値を1つ追加するだけの最小拡張、
-- 既存行・既存column・既存indexは一切変更しない):
--   1. tact_canonical_executions.permission_status
--      (SOR-50、「最新decisionの要約」列)
--   2. tact_execution_permission_decisions.status
--      (SOR-51、append-only history列)
--
-- 20260917000000_allow_notion_tact_connections.sqlと同じ
-- 「drop constraint if exists → add constraint」パターンを踏襲する。
--
-- =====================================================================

alter table public.tact_canonical_executions
  drop constraint if exists tact_canonical_executions_permission_status_check;

alter table public.tact_canonical_executions
  add constraint tact_canonical_executions_permission_status_check
    check (permission_status in ('pending', 'allowed', 'denied', 'unknown', 'approval_required'));

alter table public.tact_execution_permission_decisions
  drop constraint if exists tact_execution_permission_decisions_status_check;

alter table public.tact_execution_permission_decisions
  add constraint tact_execution_permission_decisions_status_check
    check (status in ('allowed', 'denied', 'unknown', 'approval_required'));
