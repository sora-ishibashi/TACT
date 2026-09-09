-- =====================================================================
-- Migration: Restrict Legacy Stage-0 tables to service-role-only access
-- (TACT SEC-P0-3: Pre-Live Remediation)
-- =====================================================================
--
-- 背景(docs/architecture/pre-live-full-audit.md P0 finding #3):
--   以下8テーブルは、Stage 0(認証導入前の暫定設計、各テーブル自身の
--   作成migrationコメントに明記済み)の `using(true)` / `with check(true)`
--   policyのまま残っていた。これらは元々「本格的なRLS導入は今回の
--   スコープ外」という前提で作られたが、Pre-Live Full Repository Audit
--   (docs/architecture/pre-live-full-audit.md、commit 28f25b9)で、
--   これらのテーブルへ到達できるroute(app/api/tact/code-tasks/**、
--   app/api/tact/route.ts、app/api/tact/stream/route.ts)がzero
--   authenticationだったことと組み合わさり、「NEXT_PUBLIC_SUPABASE_
--   ANON_KEYを保持しているだけの誰でも、Supabase REST APIへ直接
--   read/write/deleteできる」というP0として確定した。
--
--   対象:
--     conversations / conversation_messages / conversation_workflow_runs
--     tact_execution_history / tact_memory
--     tact_core_knowledge / tact_core_memories / tact_core_examples
--
-- 方針(絶対条件、今回はarchitecture migrationを行わない):
--   これら8テーブルへアクセスする既存code(core/brain/memory.ts・
--   core/brain/history.ts・core/conversation/store.ts・
--   core/codeAgent/store.ts・core/tact-agent/supabaseStore.ts・
--   core/tact-core/supabaseCoreCapability.ts・betaUsageReport.ts)は
--   全て、per-request user access tokenを持たない
--   共有anon client(core/database/supabase.ts)経由でアクセスしている
--   ——つまりこれらのcode自身にも、Postgres/Supabase Auth session
--   としての実userIdentityは元々存在しない(所有者判定は常に
--   application層のuser_id列比較で行われてきた、STEP131以降の既存
--   設計)。したがって「auth.uid() = user_id」のようなsession-based
--   RLSへ今回書き換えることはできない(全既存呼び出しを直ちに破壊する)。
--
--   代わりに、このrepository内で既に確立済みの、全く同じ制約下での
--   既存パターン(core/database/supabaseServiceRole.tsが管理する
--   tact_external_identities/tact_bot_conversation_links/
--   tact_bot_processed_exists、いずれもRLS enabled + policy 0件 =
--   service role以外は既定で拒否)をそのまま踏襲する:
--     - 既存policyを全てdropし、新しい許可policyは一切追加しない。
--     - 結果、anon/authenticatedのいずれの役割でも一切アクセス
--       できなくなる(default deny、PostgRESTの既定動作)。
--     - service roleはRLSを常にbypassするため、上記7ファイルが
--       service role clientへ切り替わることで、既存の全機能
--       (Stage 0が意図した「user_id IS NULL = 全体向けmemory」を含む)
--       は一切変更されずそのまま動作し続ける
--       (このmigration自体はcode変更を伴わない——対応するcode変更は
--       別途、同じcommitの中で行う)。
--     - 外部から`NEXT_PUBLIC_SUPABASE_ANON_KEY`だけを使った直接
--       アクセスは、これにより構造的に不可能になる。
--
-- 絶対条件: 破壊的なtable/column変更は一切行わない(policyのみ)。
-- rename禁止・データ削除禁止。
-- =====================================================================


-- ---------------------------------------------------------------------
-- conversations / conversation_messages / conversation_workflow_runs
-- ---------------------------------------------------------------------

drop policy if exists "conversations_select_anon_stage0" on public.conversations;
drop policy if exists "conversations_insert_anon_stage0" on public.conversations;
drop policy if exists "conversations_update_anon_stage0" on public.conversations;
drop policy if exists "conversations_delete_anon_stage0" on public.conversations;

drop policy if exists "conversation_messages_select_anon_stage0" on public.conversation_messages;
drop policy if exists "conversation_messages_insert_anon_stage0" on public.conversation_messages;
drop policy if exists "conversation_messages_update_anon_stage0" on public.conversation_messages;
drop policy if exists "conversation_messages_delete_anon_stage0" on public.conversation_messages;

drop policy if exists "conversation_workflow_runs_select_anon_stage0" on public.conversation_workflow_runs;
drop policy if exists "conversation_workflow_runs_insert_anon_stage0" on public.conversation_workflow_runs;
drop policy if exists "conversation_workflow_runs_update_anon_stage0" on public.conversation_workflow_runs;
drop policy if exists "conversation_workflow_runs_delete_anon_stage0" on public.conversation_workflow_runs;


-- ---------------------------------------------------------------------
-- tact_execution_history / tact_memory
-- ---------------------------------------------------------------------

drop policy if exists "tact_execution_history_select_anon_stage0" on public.tact_execution_history;
drop policy if exists "tact_execution_history_insert_anon_stage0" on public.tact_execution_history;

drop policy if exists "tact_memory_select_anon_stage0" on public.tact_memory;
drop policy if exists "tact_memory_insert_anon_stage0" on public.tact_memory;
drop policy if exists "tact_memory_update_anon_stage0" on public.tact_memory;
-- 20260829000000で追加された、agent_handoff/development_task行専用の
-- 限定的なdelete policyも含め、client-side accessは完全に閉じる
-- (service roleは元々このpolicyの制約を受けずbypassするため、
-- dropしても既存のservice role経由delete機能に影響は無い)。
drop policy if exists "tact_memory_delete_agent_handoff_anon_stage0" on public.tact_memory;


-- ---------------------------------------------------------------------
-- tact_core_knowledge / tact_core_memories / tact_core_examples
-- ---------------------------------------------------------------------

drop policy if exists "tact_core_knowledge_select_anon_stage0" on public.tact_core_knowledge;
drop policy if exists "tact_core_knowledge_insert_anon_stage0" on public.tact_core_knowledge;
drop policy if exists "tact_core_knowledge_update_anon_stage0" on public.tact_core_knowledge;

drop policy if exists "tact_core_memories_select_anon_stage0" on public.tact_core_memories;
drop policy if exists "tact_core_memories_insert_anon_stage0" on public.tact_core_memories;
drop policy if exists "tact_core_memories_update_anon_stage0" on public.tact_core_memories;

drop policy if exists "tact_core_examples_select_anon_stage0" on public.tact_core_examples;
drop policy if exists "tact_core_examples_insert_anon_stage0" on public.tact_core_examples;

-- 全8テーブルとも、alter table ... enable row level securityは
-- 各テーブルの作成migrationで既に実行済み(このmigrationでは
-- 変更しない)。policyが1件も無い状態でRLSが有効な場合、PostgRESTは
-- service role以外の全requestをデフォルトで拒否する
-- (tact_external_identities等、既存の確立済みパターンと同一)。
