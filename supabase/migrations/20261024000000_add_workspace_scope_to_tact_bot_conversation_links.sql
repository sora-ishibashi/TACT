-- =====================================================================
-- Migration: Slack Conversation Link Workspace Scoping
-- (SOR-52 Final Consistency & Concurrency Hardening Part8, blocker)
-- =====================================================================
--
-- 背景: tact_bot_conversation_links(BOT-P2、20260830010000migration)は
-- channel + external_conversation_id + external_thread_id のみで
-- 一意性を判定しており、workspace/team scopeを持たない。
-- tact_external_identities(同migration内)は既にexternal_workspace_id
-- を一意性の一部として使っているのに対し、この2テーブル目だけが
-- workspace scopeを欠いていた——同じYolna userが複数のSlack
-- workspaceを接続した場合、channel ID(理論上はSlack platform全体で
-- 一意ではあるが、この既定に依存しすぎない)が万一衝突すると誤った
-- TACT Conversationへ相関しうる。
--
-- 既存データについての確認: このrepository・この開発フェーズを通じて
-- 実Supabase環境(service role credentialを含む)へ一度も接続できて
-- おらず、このtableに実データが存在するかどうかを直接確認する手段が
-- 無い。そのため「データが無い」と断定はせず、破壊的な変更
-- (NOT NULL化・既存列のrename・既存行の削除)は一切行わない——
-- 追加列はnullableのまま、既存の一意index(coalesce(external_thread_id,
-- ''))と同じ「NULLをcoalesceで正規化する」既存パターンをそのまま
-- external_workspace_idへも適用するだけの、後方互換な追加とする。
--
-- =====================================================================

alter table public.tact_bot_conversation_links
  add column if not exists external_workspace_id text null
    check (external_workspace_id is null or char_length(external_workspace_id) between 1 and 255);

-- 既存の一意indexをworkspace scope込みで置き換える(既存パターンと
-- 同じcoalesce方式、drop/create if not existsで既存規約に合わせる)。
drop index if exists idx_tact_bot_conversation_links_lookup;

create unique index if not exists idx_tact_bot_conversation_links_lookup
  on public.tact_bot_conversation_links (
    channel,
    coalesce(external_workspace_id, ''),
    external_conversation_id,
    coalesce(external_thread_id, '')
  );
