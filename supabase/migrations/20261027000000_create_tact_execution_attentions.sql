-- =====================================================================
-- Migration: Execution Attention (SOR-52)
-- =====================================================================
--
-- 背景 (SOR-52): SOR-51のPermission Decisionのうち、MISMATCH
-- (denied)・APPROVAL_REQUIREDだけを、人間が後から確認できる
-- persistent Attention itemとして保存する。Work correlation(SOR-53)を
-- 待たない——work_idが未確定のExecutionでも保存できる。
--
-- Source of truthについての判断(絶対条件、SOR-52指示section17
-- 「Executionをsource of truthとして保つ」): このtableはactor/agent/
-- provider/action/execution status/work_idを一切複製しない。これらは
-- すべてexecution_id経由でtact_canonical_executionsを読む(特にwork_id
-- はSOR-53後に変わり得るため、query時に都度読むことで「後からWork
-- contextが付与されても同一Attentionのまま」という要件を満たす
-- ——このtable自体へwork_idを持たせて後から同期する設計は採らない)。
-- 同様に、permission評価の詳細(reason_code/policy_id/evaluator_version)
-- はpermission_decision_id経由でtact_execution_permission_decisionsを
-- 読む。このtable自体が持つのは「Attentionとしての事実」(誰の・どの
-- Execution/Decisionに対する・どんな理由の・どんな状態のAttentionか)
-- だけである。
--
-- Idempotency(絶対条件、SOR-52指示section5「1 Executionに複数
-- Attentionを乱立させない」): execution_idへのunique indexで、
-- tact_canonical_executions/tact_execution_permission_decisionsと
-- 同じ「INSERTを試み、unique_violation(23505)を結果として判定する」
-- atomic方式を踏襲する。同一Executionに対する再評価・duplicate
-- captureのretryがあっても、Attention行は最初の1件のみで、以後は
-- 「既に存在する」として扱う(このM-0では既存行の更新・書き換えは
-- 行わない)。
--
-- Reason/Statusについての判断: reasonはSOR-52 product-facing
-- vocabulary(permission_mismatch/approval_required)のみを許容する
-- (allowed/unknownはAttentionを生成しないため、このtableへは
-- そもそも到達しない、core/tact-execution/permission/attention.ts
-- 参照)。statusはM-0では'open'のみを書き込むが、将来のacknowledge/
-- resolve workflow(このmigrationでは実装しない)のための拡張余地
-- として'acknowledged'/'resolved'もCHECK制約へ含めておく
-- (SOR-52指示section9「後から設定可能な形を壊さない」)。
--
-- 書き込み経路についての判断: tact_canonical_executions/
-- tact_execution_permission_decisionsと同じ理由(書き込みは常に
-- Permission Evaluator直後の観測boundary、生きたuser browser
-- sessionを前提できないtrust boundary)で、service role clientから
-- のみ書き込む。RLSはSELECTのみを許可する。
--
-- =====================================================================

create table if not exists public.tact_execution_attentions (

  id uuid not null primary key default gen_random_uuid(),

  -- SOR-52指示section3「userId / tenant scope」: tact_canonical_executions
  -- と同じ明示列にする(tact_execution_permission_decisionsのような
  -- 親経由EXISTS判定ではなく)——「自分のopen Attentionを一覧する」
  -- query(SOR-52指示section10のread boundary)が親tableへjoinせずに
  -- 直接絞り込めるようにするため。
  user_id uuid not null references auth.users (id) on delete cascade,

  execution_id uuid not null references public.tact_canonical_executions (id) on delete cascade,

  permission_decision_id uuid not null references public.tact_execution_permission_decisions (id) on delete cascade,

  -- core/tact-execution/permission/attention.tsのAttentionReasonと同じ
  -- 2値(product-facing vocabulary)。allowed/unknownはこのtableへ
  -- 到達しない(deriveExecutionAttentionCandidate()がnullを返すため)。
  reason text not null
    check (reason in ('permission_mismatch', 'approval_required')),

  -- M-0では'open'のみを書き込む。acknowledged/resolvedは将来のUI
  -- workflow(SOR-52では実装しない)のための拡張余地。
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved')),

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

-- Idempotency(絶対条件、最重要、上記コメント参照): 1 Execution = 高々
-- 1 Attention行。
create unique index if not exists idx_tact_execution_attentions_execution_id
  on public.tact_execution_attentions (execution_id);

-- SOR-52指示section10/11の主要query(「自分のopen Attentionをnewest
-- firstで読む」)向け。
create index if not exists idx_tact_execution_attentions_user_id_created_at
  on public.tact_execution_attentions (user_id, created_at desc);

create index if not exists idx_tact_execution_attentions_status
  on public.tact_execution_attentions (status);

-- ---------------------------------------------------------------------
-- updated_at trigger (既存tact_canonical_executions等と同じper-table
-- trigger function命名規約を踏襲する)
-- ---------------------------------------------------------------------

create or replace function public.set_tact_execution_attentions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_execution_attentions_updated_at on public.tact_execution_attentions;
create trigger trg_tact_execution_attentions_updated_at
  before update on public.tact_execution_attentions
  for each row
  execute function public.set_tact_execution_attentions_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
--
-- 書き込みは常にPermission Evaluator直後の観測boundary(service role
-- client)から行う(上記コメント参照)。SELECTのみを許可し、
-- insert/update/delete policyは意図的に定義しない(「使わない操作の
-- policyを先回りで作らない」既存規約)。

alter table public.tact_execution_attentions enable row level security;

drop policy if exists "tact_execution_attentions_select_own" on public.tact_execution_attentions;
create policy "tact_execution_attentions_select_own"
  on public.tact_execution_attentions for select
  using (auth.uid() = user_id);

-- insert/update/delete policyは意図的に無し(service role専用の
-- 書き込み境界、上記コメント参照)。
