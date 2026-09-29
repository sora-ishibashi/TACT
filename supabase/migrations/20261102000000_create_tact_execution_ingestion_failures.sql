-- =====================================================================
-- Migration: Ingestion Pipeline Failure Telemetry (SOR-46 M-0.5)
-- =====================================================================
--
-- 背景(SOR-46 remaining scope、"Minimal telemetry / source health"):
--   core/tact-execution/adapters/notion/observeNotionMcpExecution.tsの
--   onFailure()は、normalization/capture/permission_evaluation/
--   work_correlationの各stageで失敗した観測を、これまでconsole.error()
--   だけへ書き出していた——DBには一切残らない。captureExecution()自体が
--   失敗する場合(=tact_canonical_executionsへの行すら作られない場合)、
--   その失敗はどのread model/APIからも構造的に見えない。
--
--   このmigrationは、その「ingestion pipeline自体が失敗した」という
--   事実だけを、最小限・provider中立な1 tableとして追加する
--   (絶対条件、SOR-46指示section1「Prefer the smallest provider-neutral
--   design」「Do not build a generalized monitoring platform」)。
--
-- 既存tact_canonical_executionsとの区別(重要): tact_canonical_executions
-- は「観測できた実行そのもの」(captureExecution()が成功した行)であり、
-- status='failed'は「実行自体は観測できたが、その実行がbusinessとして
-- 失敗した」ことを表す(既存のerror_code/error_message列、SOR-50)。
-- 本tableが記録するのは、その手前——「観測パイプライン自体がその実行を
-- 記録することにすら失敗した」という、全く別の事実である。両者を
-- 混同・統合しない。
--
-- Provenance/tenant判断: normalizeNotionMcpInvocationToExecution()への
-- 入力(NotionMcpInvocationObservation.userId)はMCP hostが解決済みの
-- 値であり、normalization自体が失敗する場合でも既に判明している
-- (core/tact-execution/adapters/notion/normalizeNotionMcpExecution.ts
-- 参照)。そのため本tableのuser_idはnormalization失敗を含む全stageで
-- 常に取得可能であり、NOT NULLにしてtenant scopeを最初から保つ。
--
-- Sanitization(絶対条件、SOR-46指示「Preserve sanitized failure
-- metadata only」「Do not persist raw secrets, tokens, or unnecessary
-- payload content」): error_kindは呼び出し元(observeNotionMcpExecution.ts
-- の既存console.error方針と同じ)がerror.name(またはtypeof error)、
-- もしくはnormalization失敗時の既存の静的allowlist済みreason文字列
-- だけを渡す——raw error.message/stack/provider payloadは一切受け取ら
-- ない列設計にする(そもそも列が無いため、アプリ層が渡そうとしても
-- 保存されない)。
--
-- =====================================================================

create table if not exists public.tact_execution_ingestion_failures (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid not null references auth.users (id) on delete cascade,

  -- core/tact-execution/types.tsのExecutionProviderと同じ値集合
  -- (provider中立、将来のprovider追加は1行CHECK追加で行う既存パターン
  -- を踏襲する)。
  provider text not null
    check (provider in (
      'openai', 'anthropic', 'mcp', 'slack', 'gmail',
      'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom'
    )),

  connection_id uuid null references public.tact_connections (id) on delete set null,

  adapter_version text not null
    check (char_length(adapter_version) between 1 and 100),

  -- core/tact-execution/adapters/notion/observeNotionMcpExecution.tsの
  -- 既存ObserveNotionMcpExecutionFailureStage型と同じ4値。
  stage text not null
    check (stage in ('normalization', 'capture', 'permission_evaluation', 'work_correlation')),

  -- サニタイズ済みの分類のみ(上記コメント参照、絶対条件)。
  error_kind text not null
    check (char_length(error_kind) between 1 and 255),

  occurred_at timestamptz not null default now()

);

create index if not exists idx_tact_execution_ingestion_failures_user_id_occurred_at
  on public.tact_execution_ingestion_failures (user_id, occurred_at desc);

create index if not exists idx_tact_execution_ingestion_failures_provider
  on public.tact_execution_ingestion_failures (provider);

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
--
-- tact_canonical_executionsと同じ理由・同じ設計: 書き込みは常に観測
-- pipelineのfailure boundary(service role client)から行う(生きたuser
-- browser sessionを前提できない)。SELECTのみを許可し、insert/update/
-- delete policyは意図的に定義しない(「使わない操作のpolicyを先回りで
-- 作らない」既存規約)。

alter table public.tact_execution_ingestion_failures enable row level security;

drop policy if exists "tact_execution_ingestion_failures_select_own" on public.tact_execution_ingestion_failures;
create policy "tact_execution_ingestion_failures_select_own"
  on public.tact_execution_ingestion_failures for select
  using (auth.uid() = user_id);

-- insert/update/delete policyは意図的に無し(service role専用の書き込み
-- 境界、上記コメント参照)。
