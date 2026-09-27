-- =====================================================================
-- Migration: Historical explainability for Registry-backed decisions (SOR-47)
-- =====================================================================
--
-- 背景 (SOR-47、Human Owner指示section3「Historical explainability」):
-- tact_execution_permission_rulesはmutableな行である(admin/user CRUD、
-- app/api/tact/permission-rules/経由で編集され得る)。既存の
-- policy_id(文字列、rule identifierをそのまま保持)だけでは、rule行が
-- 編集された後に過去のdecisionを正しく説明できない——ある時点で
-- identifier="X"のruleがdecision="approval_required"としてmatchした
-- としても、後でそのidentifierの行がdecision="denied"へ編集されて
-- しまうと、policy_idを手掛かりに「現在のrule行」を見ても当時の
-- 判定根拠を再現できない。
--
-- 最小の追加(Human Owner承認済みdesign): registry_rule_id(matchした
-- 行そのものへのFK、行が後で削除されてもON DELETE SET NULLで
-- decision自体は残る)とregistry_rule_revision(match時点でのその行の
-- revision値)の2列を追加する。加えて、match時点の全match-relevant
-- fieldのsnapshotは、既存のmetadata jsonb列(このtableに既に存在し、
-- 既にsize/suspicious-key guardの対象)へ記録する——新しいjsonb列は
-- 増やさない。
--
-- 過去のdecisionを説明する際、現在のtact_execution_permission_rules行
-- (mutable)を参照する必要は一切ない——このmigrationの2列 +
-- 既存policy_id/reason_code/evaluator_version + metadata snapshotだけで
-- 自己完結する(絶対条件、Human Owner指示)。
--
-- 既存行への影響皆無(NULL許容の加算的列のみ、既存constraintは
-- 変更しない)。SOR-51由来の静的allowlist経由のdecision(Phase1では
-- 引き続きこちらが本番既定)は、この2列を常にNULLのまま残す
-- (Registry未経由であることをそのまま表す)。
--
-- =====================================================================

alter table public.tact_execution_permission_decisions
  add column if not exists registry_rule_id uuid null
    references public.tact_execution_permission_rules (id) on delete set null;

alter table public.tact_execution_permission_decisions
  add column if not exists registry_rule_revision integer null
    check (registry_rule_revision is null or registry_rule_revision >= 1);

-- 「このruleが実際にどのdecisionを生んだか」を後から辿るための
-- 検索path(rule行が削除されてもregistry_rule_idはNULLへ落ちるため、
-- この用途では削除前に辿る前提)。
create index if not exists idx_tact_execution_permission_decisions_registry_rule_id
  on public.tact_execution_permission_decisions (registry_rule_id)
  where registry_rule_id is not null;
