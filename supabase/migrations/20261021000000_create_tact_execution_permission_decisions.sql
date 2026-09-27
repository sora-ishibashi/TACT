-- =====================================================================
-- Migration: Canonical Execution Permission Decisions (SOR-51)
-- =====================================================================
--
-- 背景 (SOR-51): SOR-50のtact_canonical_executionsに対する、
-- Permission Observation(「起きてよいことか」の事後観測)を永続化する。
--
-- Core Principle(SOR-51指示、最重要): Executionは「実際に起きた事実」、
-- Permission Policyは「起きてよいこと」——この2つを混ぜない。
-- tact_canonical_executions本体にはpolicyそのものを埋め込まず、この
-- 新tableへ「そのExecutionを、いつ・どのpolicy/evaluator versionで
-- 評価し、どう判定したか」という評価結果だけを独立して記録する。
--
-- 既存tact_canonical_executions.permission_status/permission_reason_code/
-- permission_evaluated_at(SOR-50で追加済み、20261020000000migration)
-- は変更しない——このtableが「最新の評価結果を持つ、履歴を保持する
-- source of truth」であり、tact_canonical_executions側の3列は「最新
-- decisionの要約」として、core/tact-execution/store.tsの既存
-- updateExecutionPermissionContext()がそのまま更新し続ける(責務は
-- 変えない、書き込み元だけがPermission Evaluatorに増える)。
--
-- 既存core/tact-integration/policy.tsとの区別(SOR-51指示、最重要):
-- 既存Policy(POLICY_ALLOWLIST/evaluatePolicyDecision())は「TACT自身が
-- これからComposio経由で実行してよいか」を判定するPRE-EXECUTION gate
-- (allow/require_approval/require_input/deny、未知は常にdenyへfail
-- closed)であり、TACTが実行を開始する前に必ず経由する。
-- 対してSOR-51のPermission Observationは、TACT自身が起点とは限らない
-- (人間のSlack mention・将来の外部Agent実行等も含む)、既に起きた
-- Canonical ExecutionをPOST-HOCに評価する(allowed/denied/unknown、
-- 未知はunknownへfail closed——「観測価値のある不確実状態」として
-- 残し、denyのような断定はしない)。目的・timing・fail-closed先の
-- 3点が異なるため意図的に分離し、統合しない(POLICY_ALLOWLISTは
-- 一切変更しない)。
--
-- Idempotency/再評価についての判断(SOR-51指示「Idempotency /
-- Re-evaluation」): 同一Executionへの同一evaluator_version×policy_id
-- での重複評価は安全に処理される必要がある(policy変更後の再評価は
-- 許容する——「一度評価したら永遠に更新不可」にはしない)。
-- (execution_id, evaluator_version, policy_id)への一意indexで、
-- tact_bot_processed_events/tact_canonical_executionsと同じ
-- 「INSERTを試み、unique_violation(23505)を結果として判定する」
-- atomic方式を踏襲する。policy_idはpolicyが1件もmatchしなかった
-- (unknown)場合でも一意性判定に使えるよう、NOT NULLとし
-- sentinel値'none'を使う(core/tact-execution/permission/policy.ts
-- 参照、NULLを含む一意indexはPostgresでは複数行が「distinct」に
-- なり重複排除にならないため)。
--
-- =====================================================================

create table if not exists public.tact_execution_permission_decisions (

  id uuid not null primary key default gen_random_uuid(),

  execution_id uuid not null references public.tact_canonical_executions (id) on delete cascade,

  status text not null
    check (status in ('allowed', 'denied', 'unknown')),

  reason_code text not null
    check (char_length(reason_code) between 1 and 255),

  -- 実際にmatchしたPermission Policy ruleのid(core/tact-execution/
  -- permission/policy.tsの静的allowlist内のid)。M-0ではpolicyそのものを
  -- DB tableとして持たない(既存core/tact-integration/policy.tsと同じ
  -- static allowlist方式)ため、DB FKではなくapplication層のみが
  -- 意味を知る文字列参照とする。matchしなかった場合は'none'固定値
  -- (上記コメント参照)。
  policy_id text not null
    check (char_length(policy_id) between 1 and 255),

  evaluator_version text not null
    check (char_length(evaluator_version) between 1 and 100),

  -- 小さな補足metadataのみ(巨大なJSON dump禁止、絶対条件)。
  -- application層(core/tact-execution/permission/evaluate.ts)が
  -- サイズ・suspicious keyの両方をguardする。
  metadata jsonb null,

  evaluated_at timestamptz not null default now()

);

-- Idempotent re-evaluation(絶対条件、上記コメント参照)。
create unique index if not exists idx_tact_execution_permission_decisions_idempotency
  on public.tact_execution_permission_decisions (execution_id, evaluator_version, policy_id);

-- 「あるExecutionの最新decisionを取得する」ための効率的な検索path。
create index if not exists idx_tact_execution_permission_decisions_execution_id_evaluated_at
  on public.tact_execution_permission_decisions (execution_id, evaluated_at desc);

create index if not exists idx_tact_execution_permission_decisions_status
  on public.tact_execution_permission_decisions (status);

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
--
-- tact_canonical_executionsと同じ理由(書き込みは常にPermission
-- Evaluator、生きたuser browser sessionを前提できないtrust boundary
-- から行われる)で、書き込みは常にservice role client
-- (core/tact-execution/permission/store.ts)から行う。この子tableは
-- user_id列を重複保持しない(tact_tasks/tact_runsが親work_idの
-- user_idのみに依存する既存パターンと同じ)——親
-- tact_canonical_executions経由のEXISTS句でtenant境界を判定する。
-- SELECTのみを許可し、INSERT/UPDATE/DELETE policyは意図的に定義
-- しない(「使わない操作のpolicyを先回りで作らない」既存規約)。

alter table public.tact_execution_permission_decisions enable row level security;

drop policy if exists "tact_execution_permission_decisions_select_own" on public.tact_execution_permission_decisions;
create policy "tact_execution_permission_decisions_select_own"
  on public.tact_execution_permission_decisions for select
  using (
    exists (
      select 1 from public.tact_canonical_executions e
      where e.id = execution_id and e.user_id = auth.uid()
    )
  );

-- insert/update/delete policyは意図的に無し(service role専用の
-- 書き込み境界、上記コメント参照)。
