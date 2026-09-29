-- =====================================================================
-- Migration: Canonical Execution Observation Foundation (SOR-50)
-- =====================================================================
--
-- 背景 (SOR-50): Yolna外部(AI Agent / SaaS / Connector等)で発生した
-- 実行を観測し、provider固有形式からYolna内部のCanonical Executionへ
-- 正規化して永続化するための、Runs観測基盤の正式な入口を新設する。
--
-- 設計原則(Capture first → Check immediately → Correlate later):
--   Executionは対応するWork IDが未確定でも先に記録できなければならない
--   (work_id nullable)。Permission Check(SOR-51)・Work correlation
--   (SOR-52以降)は、この行を後から更新することで接続する。
--
-- 既存概念との区別(重要、Repository Reality調査で確認済み):
--   tact_runs(20260905000000migration)は「TACT自身がTask/Capabilityを
--   1回実行した記録」であり、work_id/task_idがいずれもNOT NULLで
--   親Workの存在を前提とする。tact_audit_events
--   (20260912000000migration)も同様にwork_id NOT NULLのappend-only
--   event logで、TACT自身のWork/Task/Run/Approval/Clarification
--   lifecycleのみを対象にする。
--   本migrationが追加するtact_canonical_executionsは、この2つの
--   いずれとも異なる——Work/Task相関が未確定の時点でもTACT"外部"の
--   実行を先に記録できる、独立したEntityである(SOR-50 Objective)。
--   両者を混同・統合しない(絶対条件、既存のRun/AuditEvent schema・
--   RLS policyはこのmigrationで一切変更しない)。
--
-- Tenant境界についての判断(Repository Reality調査結果に基づく):
--   組織/workspaceの実テーブルはこのrepositoryに一切存在しない
--   (organizations/workspaces相当のtableは0件)。tact_works.
--   organization_idも「列だけ予約されておりFK/RLSともに未実装」の
--   reserved columnである(20260905000000migrationの既存コメント)。
--   本migrationはこの既存の判断をそのまま踏襲し、organization_id/
--   workspace_idを同じ形(nullable、FK無し、reserved)で追加する。
--   実際にRLS/application層で強制されるtenant境界は、このrepository
--   全体で唯一実装済みのuser_id(auth.uid())のままとする。
--
-- Actorモデルについての判断: core/tact-work.ActorKind
--   (user/bot/system/ai)はWork/Approval/Clarification/AuditEvent
--   全体で共有される既存の型であり、この既存語彙を無断で拡張しない
--   (CLAUDE.md A章)。SOR-50が要求するhuman/AI agent/service/
--   connector/systemという5分類は既存ActorKindの4値と一致しない
--   ため、tact-work.ActorKindとは独立した、この新domain専用の
--   actor_kind値集合として定義する(既存tact_works等のCHECK制約は
--   一切変更しない)。
--
-- Idempotency(絶対条件、Section「Idempotency」): Webhook再送・Agent
-- 再試行・network retry等による二重登録を防ぐため、
-- (user_id, provider, external_event_id)への一意indexで、DBが
-- atomicにclaimする。tact_bot_processed_events
-- (20260908000000migration)と同じ「SELECTして無ければINSERT」を
-- 使わない設計を踏襲する——INSERTを直接試み、unique_violation
-- (Postgres 23505)を結果として判定する。
--
-- 書き込み経路についての判断: このtableへの書き込みは常にAdapter
-- (webhook/poll/manual report等)経由であり、生きたuser browser
-- sessionのaccess tokenを持たないtrust boundaryから行われる
-- (core/tact-bot/execution/trustedConversationTurn.ts等、既存の
-- 「Trusted Execution Boundary」と同じ状況)。そのため本tableへの
-- 実際の書き込みはservice role client(core/tact-execution/store.ts)
-- から行い、RLSはSELECTのみを許可する(将来のUI/Read Model向け)。
-- 「使わない操作のpolicyを先回りで作らない」という既存規約
-- (tact_tasksの既存コメント)をそのまま踏襲し、INSERT/UPDATE/DELETE
-- policyはいずれも定義しない——authenticated roleからの直接書き込み
-- 経路を構造的に閉じる(このtableへ書き込める主体をAdapter層だけに
-- 限定する、という設計上重要な安全境界)。
--
-- Raw payload保存についての判断(絶対条件、Section「Provenance」):
-- 本migrationはraw provider payload全体を保存する列を持たない
-- (raw_payload_refはポインタのみ、常にNULLのまま——実際のsecure blob
-- storageはSOR-50のscope外、将来の別レイヤーとして検討する)。
-- source_metadataはAdapter層が構築する安全な最小限metadataのみを
-- 想定し、application層(core/tact-execution/validation.ts)が
-- core/tact-work/audit.tsのfindSuspiciousKeys()と同じkey名ベースの
-- guardを適用する。
--
-- =====================================================================

create table if not exists public.tact_canonical_executions (

  id uuid not null primary key default gen_random_uuid(),

  -- ---- Identity ----

  user_id uuid not null references auth.users (id) on delete cascade,

  -- Organization/Workspace: 実テーブルが存在しないため、
  -- tact_works.organization_idと同じ「reserved column」として追加する
  -- (FK無し、現時点でどのコードも値を書き込まない)。
  organization_id uuid null,

  workspace_id uuid null,

  -- Work correlation: SOR-50時点ではnullが正常値。SOR-52以降の
  -- 相関処理が後から埋める。work削除時はExecution自体は消さない
  -- (Capture-first原則、「先に記録した観測事実」はWork削除より
  -- 長く残ってよい——tact_runs/tact_audit_eventsのCASCADEとは
  -- 意図的に異なる。この行はWorkのsub-entityではなく、独立した
  -- 観測記録であるため)。
  work_id uuid null references public.tact_works (id) on delete set null,

  -- 既知のIntegration Connection(core/tact-integration/types.ts）への
  -- 任意の相関。Adapterが対応するConnectionを解決できない場合はnull
  -- のままでよい(例: Composio経由ではないBot inbound webhook)。
  connection_id uuid null references public.tact_connections (id) on delete set null,

  -- ---- Actor ----
  -- core/tact-work.ActorKind(user/bot/system/ai)とは独立した、
  -- この新domain専用の値集合(上記コメント参照)。

  actor_kind text not null
    check (actor_kind in ('human', 'ai_agent', 'service', 'connector', 'system')),

  actor_id text null
    check (actor_id is null or char_length(actor_id) between 1 and 255),

  -- actor_kind='ai_agent'の場合の、より具体的なagent識別子/version。
  agent_id text null
    check (agent_id is null or char_length(agent_id) between 1 and 255),

  -- 代理実行(delegation)の記録: このExecutionが誰かの代理として
  -- 行われた場合の委任元。無い場合はいずれもnull。
  on_behalf_of_actor_kind text null
    check (
      on_behalf_of_actor_kind is null
      or on_behalf_of_actor_kind in ('human', 'ai_agent', 'service', 'connector', 'system')
    ),

  on_behalf_of_actor_id text null
    check (on_behalf_of_actor_id is null or char_length(on_behalf_of_actor_id) between 1 and 255),

  -- ---- Source / Provenance ----
  -- 将来のAdapter追加(OpenAI/Anthropic/MCP/Slack/Gmail/Google
  -- Calendar/Notion/Microsoft 365/Salesforce/自前connector)を
  -- 見越した初期allowlist。値の追加はtact_connections.serviceと同じ
  -- 「1行追加migration」で行う(絶対条件: 上位Runs domainのTS
  -- コードは書き換えずに済む構造、Adapter Boundary参照)。
  provider text not null
    check (provider in (
      'openai', 'anthropic', 'mcp', 'slack', 'gmail',
      'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom'
    )),

  source_type text not null
    check (source_type in ('webhook', 'poll', 'manual_report', 'sdk_callback', 'runtime_dispatch')),

  -- Idempotency keyの一部。Providerがevent単位のIDを持たない場合、
  -- Adapter側が決定論的なfallback ID(例: 内容hash)を必ず割り当てる
  -- (絶対条件、Idempotency Section)。
  external_event_id text not null
    check (char_length(external_event_id) between 1 and 500),

  adapter_version text not null
    check (char_length(adapter_version) between 1 and 100),

  -- Adapter層が構築した安全な最小限metadataのみ(application層が
  -- key名ベースのguardを適用、上記コメント参照)。
  source_metadata jsonb null,

  -- Raw payload本体は保存しない(上記コメント参照)。将来、secure blob
  -- storageへの参照ポインタとして使うための予約列。
  raw_payload_ref text null
    check (raw_payload_ref is null or char_length(raw_payload_ref) between 1 and 1000),

  -- ---- Action ----

  action_category text not null
    check (action_category in (
      'read', 'create', 'update', 'send', 'delete', 'share', 'execute', 'approve', 'unknown'
    )),

  operation text not null
    check (char_length(operation) between 1 and 255),

  resource_type text null
    check (resource_type is null or char_length(resource_type) between 1 and 255),

  resource_identifier text null
    check (resource_identifier is null or char_length(resource_identifier) between 1 and 500),

  -- providerが「Yolnaがこのeventをどこから観測したか」を表すのに対し、
  -- target_providerは「このactionが実際にどのproviderへ向けられたか」
  -- を表す(同じproviderの場合も多いが、Agent経由の間接実行等で異なる
  -- 場合がある)。
  target_provider text null
    check (target_provider is null or target_provider in (
      'openai', 'anthropic', 'mcp', 'slack', 'gmail',
      'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom'
    )),

  -- ---- Status ----

  status text not null default 'observed'
    check (status in ('observed', 'running', 'succeeded', 'failed', 'cancelled', 'unknown')),

  error_code text null
    check (error_code is null or char_length(error_code) between 1 and 255),

  -- Adapter層でsanitize済みであることを前提とする(raw provider error
  -- 全文やsecretを含めない、findSuspiciousKeys()と同じ精神を
  -- 呼び出し規律として課す)。
  error_message text null
    check (error_message is null or char_length(error_message) <= 2000),

  -- ---- Permission Context ----
  -- SOR-51 Permission Engineが後から埋める。SOR-50時点ではPolicy
  -- Engine自体は実装しない(絶対条件)。

  permission_status text not null default 'unknown'
    check (permission_status in ('pending', 'allowed', 'denied', 'unknown')),

  permission_reason_code text null
    check (permission_reason_code is null or char_length(permission_reason_code) between 1 and 255),

  permission_evaluated_at timestamptz null,

  -- ---- Time ----
  -- 外部時刻(provider_occurred_at)をYolna受信時刻として扱わない
  -- (絶対条件)。observed_atはAdapterが実際にこのeventを観測した時刻、
  -- persisted_atは常にDB insert時刻(server側、tact_audit_events.
  -- occurred_at/created_atと同じ区別)。

  provider_occurred_at timestamptz null,

  observed_at timestamptz not null,

  persisted_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);

-- Idempotency(絶対条件、最重要): 同時実行されたINSERTのうち片方だけが
-- 成功し、もう片方はunique_violation(23505)を受け取る。
-- 「SELECTして無ければINSERT」という2段の非atomicな方式は使わない
-- (tact_bot_processed_eventsと同じ設計)。
create unique index if not exists idx_tact_canonical_executions_idempotency
  on public.tact_canonical_executions (user_id, provider, external_event_id);

create index if not exists idx_tact_canonical_executions_user_id_persisted_at
  on public.tact_canonical_executions (user_id, persisted_at desc);

-- SOR-52以降のWork correlationが「まだ相関していない行」を効率的に
-- 探索できるようにする部分index。
create index if not exists idx_tact_canonical_executions_work_id
  on public.tact_canonical_executions (work_id)
  where work_id is not null;

create index if not exists idx_tact_canonical_executions_status
  on public.tact_canonical_executions (status);

create index if not exists idx_tact_canonical_executions_permission_status
  on public.tact_canonical_executions (permission_status);

-- ---------------------------------------------------------------------
-- updated_at trigger (既存tact_works等と同じper-table trigger function
-- 命名規約を踏襲する)
-- ---------------------------------------------------------------------

create or replace function public.set_tact_canonical_executions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tact_canonical_executions_updated_at on public.tact_canonical_executions;
create trigger trg_tact_canonical_executions_updated_at
  before update on public.tact_canonical_executions
  for each row
  execute function public.set_tact_canonical_executions_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
--
-- 書き込み経路は常にAdapter(core/tact-execution/store.ts、service
-- role client)であり、authenticated roleからの直接書き込み経路は
-- 構造的に存在しない(上記コメント参照)。そのためSELECT policyのみを
-- 定義する——「使わない操作のpolicyを先回りで作らない」という既存
-- 規約(tact_tasksの既存コメント)をそのまま踏襲する。

alter table public.tact_canonical_executions enable row level security;

drop policy if exists "tact_canonical_executions_select_own" on public.tact_canonical_executions;
create policy "tact_canonical_executions_select_own"
  on public.tact_canonical_executions for select
  using (auth.uid() = user_id);

-- insert/update/delete policyは意図的に無し(service role専用の
-- 書き込み境界、上記コメント参照)。
