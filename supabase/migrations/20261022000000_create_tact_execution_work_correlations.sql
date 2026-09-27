-- =====================================================================
-- Migration: Canonical Execution Work Correlation (SOR-52)
-- =====================================================================
--
-- 背景 (SOR-52): tact_canonical_executions(SOR-50)は既にnullable
-- work_id + correlateExecutionToWork()(CAS、work_id IS NULLの行にのみ
-- 書き込む)を持つ。SOR-52はこれを土台に、Correlationの「状態」
-- (pending/matched/ambiguous/unresolved)と「なぜその結果になったか の
-- 履歴」を追加する。
--
-- Core Principle(SOR-52指示、最重要): Work correlationはExecution
-- captureをブロックしない(Capture first → Permission check →
-- Correlate later)。Workを特定できないExecutionも正常状態として
-- 保存する——推測で誤ったWorkへ紐付けるより、未分類の方を優先する。
--
-- 既存work_idとの関係: work_idは「現在matchしているWork」を表す
-- 既存の要約列としてそのまま使い続ける(このmigrationでは変更しない)。
-- correlation_statusはその要約列に「まだ試みていない
-- (pending)/試みたが複数候補で決められない(ambiguous)/試みたが
-- 候補が無かった(unresolved)/確定した(matched)」という、work_id単体
-- では表現できない状態を追加する。
--
-- Permission Decisionとの構造的な違い(SOR-51 tact_execution_permission_
-- decisionsとの意図的な差): PermissionはPolicy(静的code)+
-- Execution(不変)だけの純粋関数であるため、同一evaluator_version×
-- policy_idでの重複評価をUNIQUE indexで安全にdedupできた。Work
-- Correlationは「その時点で存在するWork群」という動的な外部状態に
-- 依存するため、同じcorrelator_versionでの再実行でも正当に異なる結果
-- になりうる(新しいWorkが後から作られ、以前unresolvedだったExecution
-- が後からmatchする、等)。そのためこのtableには重複評価防止のUNIQUE
-- indexを意図的に置かない——複数回の履歴行が積み重なること自体が
-- 正しい設計(SOR-52指示「History」section)。「同じ試行の二重実行」
-- 自体は、application層(core/tact-execution/correlation/correlate.ts)
-- が「既にmatched(work_id確定済み)なら自動では再実行しない」という
-- 形で防ぐ(DB制約ではなくorchestration層の責務)。
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. tact_canonical_executions.correlation_status(既存tableへの追加列)
-- ---------------------------------------------------------------------

alter table public.tact_canonical_executions
  add column if not exists correlation_status text not null default 'pending';

alter table public.tact_canonical_executions
  drop constraint if exists tact_canonical_executions_correlation_status_check;

alter table public.tact_canonical_executions
  add constraint tact_canonical_executions_correlation_status_check
  check (correlation_status in ('pending', 'matched', 'ambiguous', 'unresolved'));

create index if not exists idx_tact_canonical_executions_correlation_status
  on public.tact_canonical_executions (correlation_status);

-- ---------------------------------------------------------------------
-- 2. tact_execution_work_correlations(履歴、source of truth)
-- ---------------------------------------------------------------------

create table if not exists public.tact_execution_work_correlations (

  id uuid not null primary key default gen_random_uuid(),

  execution_id uuid not null references public.tact_canonical_executions (id) on delete cascade,

  -- matchedの場合のみ非null。ambiguous/unresolvedはnull
  -- (絶対条件、Never Guess Rule: 判断できない場合に推測でWorkを
  -- 埋めない)。
  work_id uuid null references public.tact_works (id) on delete set null,

  -- "pending"はこのtableへは書き込まれない(=試行が1件も無い状態を
  -- 表す、SOR-51のPermissionDecisionStatusと同じ設計——pendingは
  -- 「評価/相関がまだ行われていない」という不在の状態であり、実際に
  -- 行われた試行の結果ではない)。
  status text not null
    check (status in ('matched', 'ambiguous', 'unresolved')),

  method text not null
    check (method in ('explicit', 'structural', 'temporal_participant', 'ai_assisted')),

  -- 0.0-1.0。ambiguous/unresolvedでもconfidenceを記録できる
  -- (「なぜ確信が持てなかったか」の診断情報として)。
  confidence real null
    check (confidence is null or (confidence >= 0 and confidence <= 1)),

  reason_code text not null
    check (char_length(reason_code) between 1 and 255),

  correlator_version text not null
    check (char_length(correlator_version) between 1 and 100),

  -- ambiguousの場合に特に重要(絞り込めなかった候補群)。matchedの
  -- 場合も診断のため残せる。
  candidate_work_ids uuid[] null,

  -- 小さな補足metadataのみ(巨大なJSON dump禁止、SOR-51と同じ規律)。
  metadata jsonb null,

  correlated_at timestamptz not null default now()

);

-- 履歴を時系列で辿るための検索path(「あるExecutionの最新correlation
-- 結果を取得する」用途が主)。
create index if not exists idx_tact_execution_work_correlations_execution_id_correlated_at
  on public.tact_execution_work_correlations (execution_id, correlated_at desc);

create index if not exists idx_tact_execution_work_correlations_status
  on public.tact_execution_work_correlations (status);

create index if not exists idx_tact_execution_work_correlations_work_id
  on public.tact_execution_work_correlations (work_id)
  where work_id is not null;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
--
-- tact_execution_permission_decisionsと同じ理由・同じ設計(書き込みは
-- 常にCorrelator経由のservice role client、この子tableはuser_id列を
-- 重複保持せずEXISTS句で親tact_canonical_executions経由のtenant境界を
-- 判定する)。

alter table public.tact_execution_work_correlations enable row level security;

drop policy if exists "tact_execution_work_correlations_select_own" on public.tact_execution_work_correlations;
create policy "tact_execution_work_correlations_select_own"
  on public.tact_execution_work_correlations for select
  using (
    exists (
      select 1 from public.tact_canonical_executions e
      where e.id = execution_id and e.user_id = auth.uid()
    )
  );

-- insert/update/delete policyは意図的に無し(service role専用の
-- 書き込み境界、上記コメント参照)。
