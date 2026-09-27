-- =====================================================================
-- Migration: Permission Registry v1-minimal (SOR-47)
-- =====================================================================
--
-- 背景 (SOR-47): core/tact-execution/permission/policy.tsの静的
-- PERMISSION_POLICY_ALLOWLIST(7件のハードコードrule)を置き換える、
-- DB-backed・tenant-scopedなPermission Registryの最小実装。
--
-- 設計上の決定(Human Owner承認済みのSOR-47 revised design):
--   1. Principal/Agent scope: actor_id/agent_idは既存
--      CanonicalExecution.actorId/agentId(文字列、別途Registryを新設
--      しない)をそのまま再利用する。NULL=wildcard。
--   2. Default vs restrictive overlay: v1-minimalはtenant-specific rule
--      (user_id非NULL)とsystem default/fallback rule(user_id NULL)の
--      2階層のみ。restrictive enterprise overlay(組織横断で上書き
--      不能な制約)は明示的に対象外(このrepoにはorganization/company
--      概念自体が存在しない、organization_id列は他tableでも一貫して
--      予約済み・未使用)。tenant ruleは常にglobal fallbackに優先する
--      ——「サイレントな迂回」ではなく、v1-minimalの意図した唯一の
--      優先順位である。
--   3. 一意性: user_id=NULLはPostgresのUNIQUE制約上「distinct」に
--      なり重複排除にならないため、tenant-scope用とglobal-scope用の
--      2本のpartial unique indexで代替する(Human Owner指示)。
--   4. priorityの一意性は強制しない(Human Owner承認: 「unnecessarily
--      restrictive」)。同一tier内で複数ruleが同一priorityでmatchする
--      場合は、それらのdecisionが一致していてもUNKNOWNへfail closed
--      する(Human Owner指示、2回目の修正: 「Do NOT silently choose
--      among multiple winning rules at the same tier + priority, even
--      if their decisions agree」)——実際の判定はcore/tact-execution/
--      permission/registryEvaluate.ts側で行う、DBは制約を課さない。
--   5. validity windowは[valid_from, valid_until)の半開区間。
--
-- 既存core/tact-execution/permission/policy.tsのPERMISSION_POLICY_
-- ALLOWLISTは一切変更しない(SOR-47 Phase1範囲外、cutoverは別途)。
-- この新tableへ、既存7ruleをuser_id=NULL(global fallback)の行として
-- 種入れする——既存Notion/Slack挙動の互換性を、新evaluator
-- (evaluatePermissionWithRules、Phase1では未接続)が再現できることを
-- 保証するための土台(tests/tact/execution/permission/
-- registryEvaluate.test.tsの「seeded-registry equivalence」参照)。
--
-- =====================================================================

create table if not exists public.tact_execution_permission_rules (

  id uuid not null primary key default gen_random_uuid(),

  -- NULL = system default/fallback rule。非NULL = tenant-specific rule
  -- (このuserのみに適用される、tenant rule優先)。
  user_id uuid null references auth.users (id) on delete cascade,

  -- 安定した識別子(core/tact-execution/permission/policy.tsの既存
  -- rule.idと同じ役割)。Permission Decision.policy_idへそのまま
  -- 記録される(historical explainability、下記migration
  -- 20261031000000参照)。
  identifier text not null
    check (char_length(identifier) between 1 and 255),

  -- 行の内容が変わるたびに増分する(enabledのtoggleも含む、単純な
  -- 1ルール: 「内容変更なら常に+1」)。過去のPermission Decisionが
  -- 記録したrevisionと、現在のこの列の値が一致しない場合、その
  -- decisionは「当時有効だった内容」をmetadata snapshotから
  -- 再構築する(現在の行を参照しない、Human Owner指示
  -- 「historical explainability」)。
  revision integer not null default 1
    check (revision >= 1),

  -- 以下、matching predicate。NULL = wildcard(そのfieldを一切見ない)。
  -- core/tact-execution/types.tsの各union型と同じ値集合をCHECKで
  -- 制約する(将来値が増える場合は既存パターン(20260917000000等)と
  -- 同じ「drop constraint if exists → add constraint」で追随する)。

  subject_kind text null
    check (subject_kind is null or subject_kind in ('human', 'ai_agent', 'service', 'connector', 'system')),

  -- 特定のprincipal/agentへ限定したいruleのみ設定する(Human Owner
  -- 指示section1「Principal/Agent scope」)。既存の
  -- requires_known_actor_id/requires_known_agent_id(下記)とは独立:
  -- こちらは「このID固有」、既存2列は「既知でありさえすればよい」。
  actor_id text null
    check (actor_id is null or char_length(actor_id) between 1 and 255),

  agent_id text null
    check (agent_id is null or char_length(agent_id) between 1 and 255),

  provider text null
    check (provider is null or provider in ('openai', 'anthropic', 'mcp', 'slack', 'gmail', 'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom')),

  target_provider text null
    check (target_provider is null or target_provider in ('openai', 'anthropic', 'mcp', 'slack', 'gmail', 'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom')),

  resource_type text null
    check (resource_type is null or char_length(resource_type) between 1 and 255),

  action_category text null
    check (action_category is null or action_category in ('read', 'create', 'update', 'send', 'delete', 'share', 'execute', 'approve', 'unknown')),

  decision text not null
    check (decision in ('allowed', 'denied', 'approval_required')),

  reason_code text not null
    check (char_length(reason_code) between 1 and 255),

  requires_known_actor_id boolean not null default false,

  requires_known_agent_id boolean not null default false,

  -- tact_canonical_executions.connection_idと同じ実体を参照する実FK
  -- (SOR-47設計修正: 当初text案は誤りだったため、repository reality
  -- (supabase/migrations/20261020000000...sql)に合わせてuuid FKへ
  -- 訂正した)。account scopeという別列は設けない——repository調査の
  -- 結果、tact_connectionsにはconnection_idと別に「account」を表す
  -- 列が存在しない(provider_connection_refはconnection行のproperty
  -- であり、独立してmatchableな次元ではない)ため、connection_id
  -- matchingがそのままaccount scopeを兼ねる。
  connection_id uuid null references public.tact_connections (id) on delete set null,

  -- 同一tier内での並び順のヒント(一意性は強制しない、上記コメント
  -- 参照)。
  priority integer not null default 0
    check (priority >= 0),

  -- 半開区間[valid_from, valid_until)。NULLは各方向で無制限。
  valid_from timestamptz null,
  valid_until timestamptz null,

  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()

);

-- 一意性(Human Owner指示、NULL-safeなpartial unique index戦略):
-- tenant-scoped ruleはuser毎にidentifierが一意、global fallback rule
-- はidentifier全体で一意。
create unique index if not exists idx_tact_execution_permission_rules_tenant_identifier
  on public.tact_execution_permission_rules (user_id, identifier)
  where user_id is not null;

create unique index if not exists idx_tact_execution_permission_rules_global_identifier
  on public.tact_execution_permission_rules (identifier)
  where user_id is null;

-- Evaluator(registryEvaluate.ts)がuserの有効なruleを引く際の主経路:
-- tenant行とglobal行の両方を1回のqueryで(user_id = :userId or
-- user_id is null)取得し、enabled/validity windowで絞り込む。
create index if not exists idx_tact_execution_permission_rules_lookup
  on public.tact_execution_permission_rules (user_id, enabled, priority);

create index if not exists idx_tact_execution_permission_rules_validity
  on public.tact_execution_permission_rules (valid_from, valid_until);

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
--
-- 既存tact_execution_permission_decisions等と同じpattern: SELECTのみ
-- 許可(自分のtenant rule、またはglobal fallback rule)、INSERT/UPDATE/
-- DELETE policyは意図的に定義しない——書き込みは常にservice role
-- (core/tact-execution/permission/registryStore.ts)、かつ
-- 認証済みsessionから導出したuserIdをそのCRUD boundary
-- (app/api/tact/permission-rules/)がservice role呼び出しの引数として
-- 渡す構造(caller-supplied user_idを信用しない、Human Owner指示)。

alter table public.tact_execution_permission_rules enable row level security;

drop policy if exists "tact_execution_permission_rules_select_own_or_global" on public.tact_execution_permission_rules;
create policy "tact_execution_permission_rules_select_own_or_global"
  on public.tact_execution_permission_rules for select
  using (user_id = auth.uid() or user_id is null);

-- insert/update/delete policyは意図的に無し(service role専用の
-- 書き込み境界)。

-- ---------------------------------------------------------------------
-- Seed: 既存7 hardcoded ruleをglobal fallback行として登録する
-- ---------------------------------------------------------------------
--
-- core/tact-execution/permission/policy.tsのPERMISSION_POLICY_
-- ALLOWLISTと1:1対応(id→identifier、その他fieldはそのまま)。
-- priorityは既存配列の宣言順(0始まり)——既存のArray.find()による
-- 「最初にmatchしたものが勝つ」という挙動を、新evaluatorの
-- tier内priority昇順matchingでそのまま再現するため。
-- requires_known_actor_id/agent_idが未設定の既存ruleはfalse
-- (default)のまま。actor_id/agent_id/connection_id/subject_kind等の
-- wildcard("*")はNULLへ対応させる。
--
-- on conflict (identifier) where user_id is null: 既にこのmigrationが
-- 適用済み環境での再適用(forward-onlyの原則により通常は発生しない
-- が、念のためidempotentにしておく)。

insert into public.tact_execution_permission_rules
  (user_id, identifier, subject_kind, provider, target_provider, resource_type, action_category, decision, reason_code, requires_known_actor_id, requires_known_agent_id, priority)
values
  (null, 'human-slack-mention-allowed', 'human', 'slack', null, 'slack_message', 'create', 'allowed', 'human_slack_mention_allowed', false, false, 0),
  (null, 'ai-agent-slack-channel-read-allowed', 'ai_agent', 'slack', null, 'slack_channel', 'read', 'allowed', 'ai_agent_slack_channel_read_allowed', false, false, 1),
  (null, 'ai-agent-slack-message-send-denied', 'ai_agent', 'slack', null, 'slack_message', 'send', 'denied', 'ai_agent_slack_message_send_denied', false, false, 2),
  (null, 'notion-ai-agent-read-allowed', 'ai_agent', null, 'notion', null, 'read', 'allowed', 'notion_m0_read_allowed', true, true, 3),
  (null, 'notion-ai-agent-create-page-allowed', 'ai_agent', null, 'notion', null, 'create', 'allowed', 'notion_m0_create_page_allowed', true, true, 4),
  (null, 'notion-ai-agent-update-page-approval-required', 'ai_agent', null, 'notion', null, 'update', 'approval_required', 'notion_m0_update_page_approval_required', true, true, 5),
  (null, 'notion-ai-agent-delete-page-denied', 'ai_agent', null, 'notion', null, 'delete', 'denied', 'notion_m0_delete_page_forbidden', true, true, 6)
on conflict (identifier) where user_id is null do nothing;
