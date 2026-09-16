-- =====================================================================
-- Migration: Conversation Origin Boundary (Research/Core/Slack)
-- =====================================================================
--
-- 背景 (TACT CONVERSATION ORIGIN BOUNDARY 監査結果):
--   public.tact_conversationsにはorigin/source/surface/channel/kindの
--   いずれも存在せず、Research(components/research/ResearchWorkspace.tsx)・
--   Core/general chat(components/tact/ConversationSection.tsx)・
--   Slack(core/tact-bot/*)のいずれから作られたConversationも、
--   同じ2つのcreateConversation()呼び出し元(app/api/tact/
--   tact-conversations/route.ts、core/tact-conversation/orchestration.ts
--   のrunConversationTurn())を経由してuser_id/title/project_idのみを
--   持つ同一行として保存されていた。Research履歴(listConversations())は
--   user_idのみで絞り込むため、Slack/Core起点のConversationがResearch
--   履歴に混入していた(監査で確認したRoot Cause)。
--
-- 本migrationは、tact_conversationsに「このConversationがどのSurfaceから
-- 作られたか」を表す不変のorigin列を追加する。tact_bot_conversation_links
-- (Slack等の外部thread⇄TACT conversation継続)とは責務が異なる
-- (bot linkは「どの外部threadに対応するか」、originは「どのSurfaceの
-- 所有物か」)ため、既存のtact_bot_conversation_linksは一切変更しない。
--
-- 値の設計: 現在実装済みのSurfaceはresearch/core/slackの3つのみだが、
-- tact_bot_conversation_links.channel / tact_external_identities.provider
-- (20260830010000migration)が既にline/teams/discordを「未実装だが
-- 将来のChannel Gateway対象」として先行宣言している既存conventionに
-- 合わせ、CHECK制約にline/teams/api/web/systemも将来値として含める
-- (Evidenceのない先回りテーブル追加ではなく、既に本repositoryで
-- 採用されている「1つの列 + narrow CHECK」という既存パターンを、
-- 同じ理由で先行宣言するだけであり、新しいテーブル・新しいPipelineは
-- 一切追加しない)。
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
-- Phase C: origin列をNOT NULLへ変更する(DEFAULTは設定しない——
--   このtableへ書き込む唯一の経路であるcore/tact-conversation/store.ts
--   のcreateConversation()は、今回の変更で全ての呼び出し元がoriginを
--   明示的に渡すことを型レベルで強制されるため、DB側の暗黙default値に
--   よる「渡し忘れの隠蔽」を意図的に避ける)。
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
-- Phase C: NOT NULL化
-- ---------------------------------------------------------------------

alter table public.tact_conversations
  alter column origin set not null;


-- ---------------------------------------------------------------------
-- Index: Research/Core双方のlistConversations()クエリ
-- (user_id = :userId AND origin = :origin, ORDER BY updated_at DESC)
-- に一致する複合index。
-- ---------------------------------------------------------------------

create index if not exists idx_tact_conversations_user_id_origin_updated_at
  on public.tact_conversations (user_id, origin, updated_at desc);
