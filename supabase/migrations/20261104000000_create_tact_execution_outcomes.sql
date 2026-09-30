-- =====================================================================
-- Migration: Canonical Execution Outcome (SOR-119)
-- =====================================================================
--
-- 背景 (SOR-119): tact_canonical_executions(SOR-50)のstatus列は「技術的
-- に処理が成功/失敗したか」だけを表す。SOR-119はこれとは絶対に混同
-- しない別概念——「現実・業務・対象の状態がどう変わったか」を表す
-- Outcomeを追加する(例: Gmail SEND succeeded -> outcome: email_sent、
-- Notion update succeeded -> outcome: page_updated)。
--
-- 設計はtact_execution_work_correlations(SOR-52)と全く同じ形を踏襲
-- する(絶対条件: 似た概念を重複実装しない、新しいpatternを発明しない)。
--   - tact_canonical_executions.outcome_status/outcome_kind: 「現在の
--     最新Outcome」を表す要約列(work_id/correlation_statusと同じ位置
--     づけ)。
--   - tact_execution_outcomes: 履歴(source of truth)。method列で
--     'adapter_asserted'(adapterが確認した事実)と'manual_override'
--     (人間による訂正)を区別する——tact_execution_work_correlationsの
--     methodと同じ設計で、human correctionの経路を最初から塞がない。
--
-- outcome_kindをCHECK制約付きenumにしない理由(絶対条件: provider固有
-- payloadをCore schemaへ漏らさない): email_sent/draft_created/
-- page_updated/pull_request_created等はprovider/operationごとに際限
-- なく増える語彙であり、Core migrationのCHECK制約へ列挙するとCore
-- schemaがprovider固有知識を持つことになる。operation列(SOR-50)と
-- 同じ規約(free text、長さ制限のみ)に揃える。
--
-- UNKNOWNの扱い(絶対条件: UNKNOWNは正常な状態、Never Guess Rule):
-- outcome_statusのデフォルトは'unknown'。tact_execution_work_
-- correlationsの'pending'(未試行、履歴行なし)とは異なり、Outcomeでは
-- 「確認を試みたが判断できなかった」ケースもstatus='unknown'の履歴行
-- として残せる(diagnosticとして有用なため、correlationのambiguous/
-- unresolvedと同じ扱い)。status='unknown'の行はoutcome_kindを必ずnull
-- とする(判断できないものへ値を埋めない)。
--
-- v1では書き込みにRPCを使わない(SOR-52がRPC化した同時実行race
-- conditionは、Outcomeには現時点で同種のリスクが無いため——
-- tact_execution_permission_decisions(SOR-51)と同じ、素朴な
-- insert-then-update方式から始める。将来同時実行問題が実際に見つかれば
-- SOR-53と同じ形でhardeningする)。
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. tact_canonical_executions.outcome_status/outcome_kind(既存tableへの追加列)
-- ---------------------------------------------------------------------

alter table public.tact_canonical_executions
  add column if not exists outcome_status text not null default 'unknown'
    check (outcome_status in ('unknown', 'asserted'));

alter table public.tact_canonical_executions
  add column if not exists outcome_kind text null
    check (outcome_kind is null or char_length(outcome_kind) between 1 and 255);

create index if not exists idx_tact_canonical_executions_outcome_status
  on public.tact_canonical_executions (outcome_status);

-- ---------------------------------------------------------------------
-- 2. tact_execution_outcomes(履歴、source of truth)
-- ---------------------------------------------------------------------

create table if not exists public.tact_execution_outcomes (

  id uuid not null primary key default gen_random_uuid(),

  execution_id uuid not null references public.tact_canonical_executions (id) on delete cascade,

  -- 'asserted'の場合のみoutcome_kindが非null(下のCHECK制約参照)。
  status text not null
    check (status in ('asserted', 'unknown')),

  outcome_kind text null
    check (outcome_kind is null or char_length(outcome_kind) between 1 and 255),

  -- status='asserted'なら必ずoutcome_kindを持つ、'unknown'なら必ず
  -- 持たない(絶対条件、Never Guess Rule: 判断できない状態へ値を
  -- 埋めない/確定した状態を無根拠にできない)。
  check (
    (status = 'asserted' and outcome_kind is not null)
    or (status = 'unknown' and outcome_kind is null)
  ),

  -- 人間向けの短い要約のみ(絶対条件: raw provider payload本文を新たに
  -- 常時保存しない)。500文字上限。
  summary text null
    check (summary is null or char_length(summary) <= 500),

  -- このOutcomeが実際に(TACTが生成した)Artifactと対応する場合のみ
  -- 設定する任意参照。既存Artifactモデルをそのまま再利用し、新しい
  -- 成果物構造は作らない。ほとんどのOutcome(email_sent等)はArtifactを
  -- 伴わないため、常にnullでよい。
  artifact_id uuid null references public.tact_artifacts (id) on delete set null,

  -- tact_execution_work_correlations.methodと同じ設計(human correction
  -- 可能性を最初から塞がない)。
  method text not null
    check (method in ('adapter_asserted', 'manual_override')),

  reason_code text null
    check (reason_code is null or char_length(reason_code) between 1 and 255),

  -- この事実を主張した主体(SOR-50のExecution actor語彙をそのまま再利用、
  -- 独自語彙を増やさない)。
  asserted_by_actor_kind text null
    check (
      asserted_by_actor_kind is null
      or asserted_by_actor_kind in ('human', 'ai_agent', 'service', 'connector', 'system')
    ),

  asserted_by_actor_id text null
    check (asserted_by_actor_id is null or char_length(asserted_by_actor_id) between 1 and 255),

  -- 小さな補足metadataのみ(巨大なJSON dump禁止、SOR-51/52と同じ規律)。
  metadata jsonb null,

  asserted_at timestamptz not null default now()

);

create index if not exists idx_tact_execution_outcomes_execution_id_asserted_at
  on public.tact_execution_outcomes (execution_id, asserted_at desc);

create index if not exists idx_tact_execution_outcomes_status
  on public.tact_execution_outcomes (status);

create index if not exists idx_tact_execution_outcomes_artifact_id
  on public.tact_execution_outcomes (artifact_id)
  where artifact_id is not null;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
--
-- tact_execution_work_correlationsと同じ理由・同じ設計(書き込みは常に
-- service role client、この子tableはuser_id列を重複保持せずEXISTS句で
-- 親tact_canonical_executions経由のtenant境界を判定する)。

alter table public.tact_execution_outcomes enable row level security;

drop policy if exists "tact_execution_outcomes_select_own" on public.tact_execution_outcomes;
create policy "tact_execution_outcomes_select_own"
  on public.tact_execution_outcomes for select
  using (
    exists (
      select 1 from public.tact_canonical_executions e
      where e.id = execution_id and e.user_id = auth.uid()
    )
  );

-- insert/update/delete policyは意図的に無し(service role専用の
-- 書き込み境界、上記コメント参照)。
