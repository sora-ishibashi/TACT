-- =====================================================================
-- Migration: Freeze Canonical Execution v1 observation contract (SOR-45)
-- =====================================================================
--
-- 背景 (SOR-45): core/tact-execution/types.ts の CanonicalExecution を
-- v1正式仕様として固定するにあたり、Observation-firstの観点で不足して
-- いた3つの契約(schema_version / observation_mode / pre_execution_
-- visible)だけを最小追加する。既存の34列・idempotency制約・RLS・
-- provider/sourceType allowlistはこのmigrationで一切変更しない
-- (絶対条件: CanonicalExecutionを再設計しない、既存fieldと意味が重なる
-- fieldを増やさない、destructive migration禁止)。
--
-- sourceTypeとobservationModeは別概念(絶対条件、SOR-45指示):
--   sourceType(webhook/poll/manual_report/sdk_callback/runtime_dispatch)
--   は「どういうtransportでこのeventが届いたか」、observation_modeは
--   「TACTの観測が実際のprovider側actionに対してどういう時間的/因果的
--   関係にあるか(inline/instrumented/reconciled)」——同じsourceType
--   でもobservation_modeが異なりうる、独立した軸として持つ。
--
-- observation_modeをnullableにする理由(絶対条件、Unknownな値を推測で
-- 埋めない): この契約導入以前にcaptureされた行の真のmodeは、
-- sourceTypeやadapterVersionから逆算的に推測することはできても、
-- 「実際にその行を作ったadapterのコードがどう動いたか」を確実に知る
-- ことはできない。そのため過去行はnull(未分類)のまま残し、今回
-- 更新した2つのadapter(core/tact-execution/adapters/notion/
-- normalizeNotionMcpExecution.ts="instrumented"、core/tact-execution/
-- adapters/slack/normalizeSlackExecutionEvent.ts="reconciled")以降の
-- 新規captureのみが値を持つ。
--
-- pre_execution_visibleをfalse defaultにする理由: 現時点で本番稼働中の
-- 唯一のcapture経路(Notion MCP、observeNotionMcpExecution.ts)を含め、
-- 既存の全adapterはprovider側actionの完了後にのみcaptureする
-- (pre-flight row作成を行うadapterは一つも存在しない、実装確認済み)。
-- これは推測ではなく、既存コードの実際の動作から確認した事実であるため、
-- NOT NULL DEFAULT falseとしてよい(既存行・新規行いずれも正確)。
--
-- schema_versionをNOT NULL DEFAULT 1にする理由: このmigration自身が
-- 「v1」を定義するものであり、これまでに作られた全ての行は定義上v1で
-- ある(推測ではなく定義)。将来v2が必要になった場合も、既存v1行は
-- このmigrationで変更しない。
--
-- =====================================================================

alter table public.tact_canonical_executions
  add column if not exists schema_version integer not null default 1
    check (schema_version >= 1);

alter table public.tact_canonical_executions
  add column if not exists observation_mode text null
    check (observation_mode is null or observation_mode in ('inline', 'instrumented', 'reconciled'));

alter table public.tact_canonical_executions
  add column if not exists pre_execution_visible boolean not null default false;

-- 既存のidx_tact_canonical_executions_user_id_persisted_at等の既存
-- indexはこのmigrationで変更しない。observation_mode/pre_execution_
-- visibleは現時点でどのqueryのfilter条件にもなっていない(SOR-45は
-- 契約の追加のみを扱う、read model/query最適化はscope外)ため、新規
-- indexも追加しない——「使わないindexを先回りで作らない」という既存
-- 規約(tact_tasksの既存コメント、他migrationで踏襲済み)にならう。
