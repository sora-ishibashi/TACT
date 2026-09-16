-- =====================================================================
-- Migration: Conversation Origin Boundary — Phase 1 (Additive)
-- =====================================================================
--
-- 背景 (TACT CONVERSATION ORIGIN BOUNDARY監査結果、Integration Phase):
--   public.tact_conversationsにはorigin/source/surface/channel/kindの
--   いずれも存在せず、Research(components/research/ResearchWorkspace.tsx)・
--   Core/general chat(components/tact/ConversationSection.tsx)・
--   Slack(core/tact-bot/*)のいずれから作られたConversationも、同じ
--   createConversation()呼び出し元を経由してuser_id/title/project_idの
--   みを持つ同一行として保存されていた。Research履歴(listConversations())
--   はuser_idのみで絞り込むため、Slack/Core起点のConversationがResearch
--   履歴に混入していた(監査で確認したRoot Cause)。
--
-- 2段階migrationにした理由(Integration Phase監査で確認した絶対条件):
--   本列を1つのmigrationでadd + backfill + NOT NULL化まで一括で行うと、
--   Rolling Deploy/Serverless Deployのいずれでも「新schemaが適用された
--   直後、まだ旧コード(originを渡さないcreateConversation()呼び出し)が
--   動いている」瞬間が必ず存在し、その瞬間にNOT NULL違反でConversation
--   作成そのものが落ちる(migration先行でもcode先行でも同じ問題が起きる、
--   Integration Phase監査Section6参照)。そのため、本Phase1では列を
--   nullableのまま追加・backfillのみ行い、NOT NULL化は新アプリケーション
--   コードが完全に配置され、全Conversation作成経路がoriginを明示的に
--   書き込んでいることを確認した後の別migration(Phase2、
--   20261014000000_enforce_tact_conversations_origin_not_null.sql)へ
--   分離する。
--
-- 値の設計: 現在実装済みのSurfaceはresearch/core/slackの3つのみだが、
-- tact_bot_conversation_links.channel / tact_external_identities.provider
-- (20260830010000migration)が既にline/teams/discordを「未実装だが
-- 将来のChannel Gateway対象」として先行宣言している既存conventionに
-- 合わせ、CHECK制約にline/teams/api/web/systemも将来値として含める
-- (新しいテーブル・新しいPipelineは一切追加しない、1列+narrow CHECKと
-- いう既存パターンの先行宣言のみ)。
--
-- Phase A: nullable列を追加する。
-- Phase B: 既存行をbackfillする。
--   - tact_bot_conversation_linksに紐付く行 -> 'slack'
--     (外部thread linkが存在する = Bot経由で作られたことが構造的に
--     証明できる、唯一の決定論的なクラス)
--   - それ以外の既存行(Research/Core/Legacyのいずれかだが、既存データ
--     からは区別する情報が一切無い) -> 'core'
--     (安全側のfallback。メッセージ本文からの推測は一切行わない。
--     「曖昧な既存行をresearchへ自動分類しない」という要求を満たすため、
--     Research専用UIの履歴に既存行が誤って混入することを避ける
--     non-research値を選ぶ)。
--
-- 本Phase1完了後、origin列はnullableのまま(NOT NULLはPhase2の責務)。
-- 旧コード(originを渡さないINSERT)は引き続き動作する
-- (Deployment Contract Step1〜5、新コードのデプロイと動作確認が
-- 完了するまでの後方互換性を意図的に維持する)。
--
-- 既存のRLS(auth.uid() = user_id、20260825000000migration)は変更
-- しない。originは「同じuserの所有物の中でどのSurfaceに属するか」を
-- 絞り込む追加のnarrowingであり、所有権判定(ownership)の代替ではない。
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- Phase A: nullable origin列の追加
-- ---------------------------------------------------------------------

alter table public.tact_conversations
  add column if not exists origin text null;

alter table public.tact_conversations
  drop constraint if exists tact_conversations_origin_check;

alter table public.tact_conversations
  add constraint tact_conversations_origin_check
  check (
    origin is null
    or origin in ('research', 'core', 'slack', 'line', 'teams', 'api', 'web', 'system')
  );


-- ---------------------------------------------------------------------
-- Phase B: 既存行のbackfill
-- ---------------------------------------------------------------------

-- B-1: tact_bot_conversation_linksに紐付く行は、外部thread linkの存在
-- そのものがSlack(Bot)経由で作られたことの構造的な証拠であるため、
-- 'slack'として確定させる。
update public.tact_conversations c
set origin = 'slack'
where c.origin is null
  and exists (
    select 1
    from public.tact_bot_conversation_links l
    where l.tact_conversation_id = c.id
  );

-- B-2: 残りの既存行(Research/Core/Legacyのいずれかを実データからは
-- 判別できない、曖昧な既存行)は、安全側のnon-research fallbackとして
-- 'core'に分類する。メッセージ本文・titleからの推測は一切行わない。
update public.tact_conversations c
set origin = 'core'
where c.origin is null;


-- ---------------------------------------------------------------------
-- Index: Research/Core双方のlistConversations()クエリ
-- (user_id = :userId AND origin = :origin, ORDER BY updated_at DESC)
-- に一致する複合index。
-- ---------------------------------------------------------------------

create index if not exists idx_tact_conversations_user_id_origin_updated_at
  on public.tact_conversations (user_id, origin, updated_at desc);


-- ---------------------------------------------------------------------
-- 意図的にここでは行わないこと(Phase2の責務)
-- ---------------------------------------------------------------------
--
-- alter column origin set not null は、このmigrationには含めない。
-- Deployment Contract(該当PRのコメント・完了報告参照)Step1〜5
-- (Phase1適用 -> backfill/index確認 -> 新コードdeploy -> 全生成経路が
-- originを書き込むことを確認 -> NULL件数0を確認)を経てからのみ、
-- 別migration(Phase2)でNOT NULL化する。
