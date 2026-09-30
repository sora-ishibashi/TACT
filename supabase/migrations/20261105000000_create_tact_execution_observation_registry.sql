-- =========================
-- TACT Canonical Execution — Integration & Observation Registry (SOR-14)
-- =========================
--
-- 目的: 「接続されているか」(tact_connections、1bit)ではなく、
-- 各integration/provider/observation経路について「何を、どの方法で、
-- どこまで観測できるか」をRunsが明示できるようにする。
--
-- 絶対条件(SOR-14指示、以下は必ず別概念として扱い、単一の
-- connected/supported booleanへ潰さない):
--   1. Observation capability      -- このtableの本体(can_observe_*相当)
--   2. Permission-policy availability -- このtableには保存しない。
--        tact_execution_permission_rulesへ都度問い合わせて導出する
--        (単一の真実源、drift防止。SOR-130の教訓:
--        「permissionStatus=UNKNOWNとobservation failureを混同しない」)
--   3. Execution capability        -- このtableのscope外(SOR-31)
--   4. Verification status         -- verification_status列
--   5. Per-action coverage         -- row grain自体で表現(下記)
--
-- Row grain: 1 row = 1つの観測可能アクション
-- (provider, provider_label, observation_path, action_category)。
-- 「Slack READ verified / SEND unverified」のような部分的coverageを
-- 表現するには、provider単位の1行にverification_statusを1つだけ
-- 持たせる設計では表現できないため、action_category単位まで
-- 正規化する。
--
-- provider/provider_label: ExecutionProviderのCHECK制約(SOR-50
-- tact_canonical_executions、以下と同一の値集合)をそのまま再利用し、
-- 新しいenum値は追加しない(v1 Canonical Execution契約はSOR-45で
-- 固定済み、このmigrationはそれを一切変更しない)。GitHubのように
-- 正式なprovider値が無い場合は、provider='custom' +
-- provider_label='github'で実体を表現する(SOR-130の既知gap。
-- 「provider='custom'をobservation failure扱いしない」——これは
-- 正しい現状の表現であり、不具合ではない。"github"を正式な
-- ExecutionProvider値にするかどうかはSOR-45のスコープとして
-- 別途判断する)。
--
-- observation_path: adapterVersion文字列をそのまま再利用する
-- (例: 'notion-mcp-v1'、'slack-web-api-v1'、'github-issue-v1')。
-- 新しい識別子体系を作らない。
--
-- verification_status(live_verified/mock_only/unverified)を
-- 推測で昇格させない絶対条件: このmigration自体はSOR-130で実際に
-- live reality testされた行(Notion/Slack READ/GitHub)だけを
-- live_verifiedとしてseedする。credentialが無く実施していない
-- Google Workspace/CRMは、行自体を作らない
-- (「unverifiedをsupported扱いしない」——存在しない行として
-- 「まだ何も分かっていない」ことを最も正直に表現する。
-- 「unverified」という値を持つ行を置くことすら、アクション surface
-- 自体を知っているという誤った精度を暗示するため)。

create table if not exists public.tact_execution_observation_registry (

  id uuid not null primary key default gen_random_uuid(),

  -- =========================
  -- Identity
  -- =========================

  provider text not null
    check (provider in (
      'openai', 'anthropic', 'mcp', 'slack', 'gmail',
      'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom'
    )),

  -- providerが実体を表せない場合(例: GitHub→'custom')の補足識別子。
  -- Core RegistryへGitHub固有のschemaや語彙を持ち込むものではなく、
  -- 単なる人間可読ラベル。
  provider_label text null,

  -- adapterVersion文字列そのもの(例: 'notion-mcp-v1')。
  observation_path text not null,

  action_category text not null
    check (action_category in (
      'read', 'create', 'update', 'send', 'delete', 'share', 'execute', 'approve', 'unknown'
    )),

  -- =========================
  -- Observation capability (絶対条件1)
  -- =========================

  -- ExecutionObservationMode(core/tact-execution/types.ts)と同一の
  -- 値集合。SOR-45のsourceType(webhook/poll/manual_report/
  -- sdk_callback/runtime_dispatch)とは別軸であり、混同しない
  -- (このtableにsourceTypeは持たない——observation_pathと
  -- adapterVersionが既にその情報を暗黙に含む)。
  observation_mode text null
    check (observation_mode is null or observation_mode in ('inline', 'instrumented', 'reconciled')),

  pre_execution_visible boolean not null default false,

  -- Permission Registry評価が、この経路の結果に対して原理上
  -- denied/approval_requiredを返しうるか(=このactionが評価対象に
  -- 含まれるか)。実際にpolicyが設定されているかどうか(絶対条件2)
  -- とは独立した、経路そのものの性質。
  can_block_or_require_approval boolean not null default false,

  principal_attribution_available boolean not null default false,

  principal_attribution_confidence text null
    check (principal_attribution_confidence is null or principal_attribution_confidence in ('none', 'low', 'medium', 'high')),

  agent_attribution_available boolean not null default false,

  agent_attribution_confidence text null
    check (agent_attribution_confidence is null or agent_attribution_confidence in ('none', 'low', 'medium', 'high')),

  -- Work IDがこの経路でどう獲得されうるか。SOR-130絶対条件
  -- 「Work ID carrierが無い場合を明示できる」——'none'が正常な状態。
  --
  -- 絶対条件(fake explicit claim禁止、Human Owner指示):
  -- 'explicit_claim'は「TypeScriptの型がworkId?フィールドを持つ」
  -- ことだけでは成立しない——実際にproductionで現在稼働している、
  -- legitimateなWork ID主張経路が存在する場合にのみ使う(例: Notionの
  -- SOR-53 Path A、MCPホストが実際にworkIdを主張しcaptureExecution()
  -- が検証する経路)。ExecutionAdapterContext.workId?のように型として
  -- 受け取れるが実際には誰も供給していない経路(例: Slack app_mention、
  -- SOR-74/SOR-95時点でproduction Slackにlegitimateなexplicit carrierは
  -- 存在しない)は'none'とする。「型として受け取れる」ことと「実際に
  -- 主張されている」ことを混同しない。
  work_context_carrier text not null default 'none'
    check (work_context_carrier in ('none', 'explicit_claim', 'reconciled_correlation')),

  reconciliation_available boolean not null default false,

  -- =========================
  -- Privacy characteristics
  -- =========================

  excludes_raw_payload boolean not null default true,

  privacy_notes text null,

  -- =========================
  -- Credential custody / owner
  -- =========================

  credential_custody text null,

  -- =========================
  -- Verification status (絶対条件4)
  -- =========================

  verification_status text not null default 'unverified'
    check (verification_status in ('live_verified', 'mock_only', 'unverified')),

  verification_note text null,

  -- =========================
  -- Optional connection-level scope
  -- =========================
  --
  -- null = provider全体に適用される宣言(v1の主用途)。特定の
  -- connectionだけ挙動が異なる場合の上書き余地として列だけ用意する
  -- (SOR-14 v1ではこのoverride解決ロジックは実装しない、将来拡張)。
  connection_id uuid null references public.tact_connections (id) on delete cascade,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()

);

-- connection_id is null の場合と not null の場合で、それぞれ独立した
-- 一意性を強制する(PostgresはUNIQUE制約内でNULL同士を区別しない
-- ため、partial unique indexで表現する)。
create unique index if not exists idx_tact_execution_observation_registry_unique_global
  on public.tact_execution_observation_registry (provider, coalesce(provider_label, ''), observation_path, action_category)
  where connection_id is null;

create unique index if not exists idx_tact_execution_observation_registry_unique_scoped
  on public.tact_execution_observation_registry (provider, coalesce(provider_label, ''), observation_path, action_category, connection_id)
  where connection_id is not null;

create index if not exists idx_tact_execution_observation_registry_provider
  on public.tact_execution_observation_registry (provider);

alter table public.tact_execution_observation_registry enable row level security;

-- このtableはtenant固有データを一切持たない(user_id列が無い、
-- system-wide capability宣言)。機密情報・credential実値・raw payload
-- を含まないため、認証済み全ユーザーへのSELECTを許可する
-- (tact_execution_permission_rulesの「書き込みはservice-role専用、
-- 読み取りのみ許可」パターンと同じ考え方)。
create policy tact_execution_observation_registry_select_authenticated
  on public.tact_execution_observation_registry
  for select
  to authenticated
  using (true);

-- INSERT/UPDATE/DELETEポリシーは意図的に作らない
-- (service-role専用の書き込み境界、tact_execution_permission_rulesと
-- 同じ「0件policy」パターン)。

comment on table public.tact_execution_observation_registry is
  'SOR-14: per (provider, observation_path, action_category) declaration of what can be observed, how, and how confidently it has been verified. Not a connection status table (see tact_connections) and not a permission-policy table (see tact_execution_permission_rules) and not an execution-capability table (see SOR-31 scope).';

-- =========================
-- SOR-130 evidence seed (v1 baseline)
-- =========================
--
-- 以下は実際にSOR-130でlive reality testされた経路のみ。
-- 推測・未実証の行は一切追加しない。

insert into public.tact_execution_observation_registry (
  provider, provider_label, observation_path, action_category,
  observation_mode, pre_execution_visible, can_block_or_require_approval,
  principal_attribution_available, principal_attribution_confidence,
  agent_attribution_available, agent_attribution_confidence,
  work_context_carrier, reconciliation_available,
  excludes_raw_payload, privacy_notes, credential_custody,
  verification_status, verification_note
) values
  -- ---- Notion (mcp, notion-mcp-v1): SOR-130 live verified 13/13 ----
  ('notion', null, 'notion-mcp-v1', 'read',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'explicit_claim', false,
   true, 'page/database content excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'live_verified', 'SOR-130 real Notion sandbox test: GET /pages/{id}'),
  ('notion', null, 'notion-mcp-v1', 'create',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'explicit_claim', false,
   true, 'page content excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'live_verified', 'SOR-130 real Notion sandbox test: POST /pages'),
  ('notion', null, 'notion-mcp-v1', 'update',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'explicit_claim', false,
   true, 'page content excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'live_verified', 'SOR-130 real Notion sandbox test: PATCH /pages/{id}'),
  ('notion', null, 'notion-mcp-v1', 'delete',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'explicit_claim', false,
   true, 'page content excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'live_verified', 'SOR-130 real Notion sandbox test: PATCH /pages/{id} (archived=true)'),

  -- ---- Slack inbound (slack-app-mention-v1): reconciled, mock-only ----
  -- production webhook routeへは未配線のため、実live trafficを
  -- 一度も観測していない(既存adapter comment参照)。mock-based unit
  -- testでのみ検証済み——live_verifiedへ推測で昇格させない。
  --
  -- work_context_carrier='none'(訂正): normalizeSlackAppMentionEventToExecution()の
  -- ExecutionAdapterContext.workId?は型として受け取れるが、
  -- production Slackには現在legitimateなexplicit Work ID carrierが
  -- 存在しない(SOR-74/SOR-95 Product truth、fake explicit claim禁止)。
  -- 「型として受け取れる」ことと「実際にproductionで主張されている」
  -- ことを混同しない——実際のSlack explicit carrier設計はSOR-95で
  -- 別途扱う。
  ('slack', null, 'slack-app-mention-v1', 'create',
   'reconciled', false, true,
   true, 'high', false, 'none',
   'none', false,
   true, 'message text excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'mock_only', 'normalizeSlackExecutionEvent.ts is not wired into the production webhook route; unit-tested only. ExecutionAdapterContext.workId is type-level only -- no legitimate production carrier exists yet (SOR-74/SOR-95); see SOR-95 for the real carrier design'),

  -- ---- Slack outbound (slack-web-api-v1): SOR-130 partial coverage ----
  ('slack', null, 'slack-web-api-v1', 'read',
   'instrumented', false, true,
   true, 'medium', false, 'none',
   'none', false,
   true, null, 'user OAuth via Composio (tact_connections)',
   'live_verified', 'SOR-130 real Slack auth.test call'),
  ('slack', null, 'slack-web-api-v1', 'send',
   'instrumented', false, true,
   true, 'medium', false, 'none',
   'none', false,
   true, 'message text excluded from source_metadata', 'user OAuth via Composio (tact_connections)',
   'unverified', 'SOR-130 did not have an approved test channel; adapter exists and is mock-tested but never called live'),

  -- ---- GitHub (custom/github, github-issue-v1): SOR-130 live verified 13/13 ----
  -- provider='custom'はobservation failureではなく、ExecutionProviderに
  -- 'github'値がまだ存在しない既知のgapを正直に表現したもの
  -- (SOR-45スコープへ差し戻し済み)。
  ('custom', 'github', 'github-issue-v1', 'read',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'none', false,
   true, 'issue title/body excluded from source_metadata', 'user-provided fine-grained PAT, no tact_connections record',
   'live_verified', 'SOR-130 real GitHub sandbox repo test: GET /issues/{n}'),
  ('custom', 'github', 'github-issue-v1', 'create',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'none', false,
   true, 'issue title/body excluded from source_metadata', 'user-provided fine-grained PAT, no tact_connections record',
   'live_verified', 'SOR-130 real GitHub sandbox repo test: POST /issues'),
  ('custom', 'github', 'github-issue-v1', 'update',
   'instrumented', false, true,
   true, 'high', true, 'high',
   'none', false,
   true, 'issue title/body excluded from source_metadata', 'user-provided fine-grained PAT, no tact_connections record',
   'live_verified', 'SOR-130 real GitHub sandbox repo test: PATCH /issues/{n} (close)')

on conflict do nothing;
