-- =====================================================================
-- Migration: Clarification Persistence (Phase 55)
-- =====================================================================
--
-- 背景 (Phase52〜54):
--   TACTのClarification UX(Phase46、既存core/tact-orchestrator/
--   ambiguityDetector.ts)は、これまでブラウザのReact state
--   (components/ResearchPanel.tsx)にのみ保持されており、ページ
--   リロード・別デバイスからの再開ができなかった。Phase52の
--   Product Decision(Clarification=B)により、Conversation State
--   としてDB永続化する方針が確定し、Phase53/54でスキーマを設計した。
--
-- 追加するのは以下3列のみ(Phase54 Decisionそのまま、JSONBによる
-- 一括保存はしない):
--
--   1. conversation_messages.message_type
--      どのassistant messageがClarification質問だったかを示す
--      最小限のdiscriminator。既存のroleとは独立した軸。
--
--   2. conversations.pending_clarification_message_id
--      現在pendingなClarification質問を指すFK。NULLならpendingなし。
--
--   3. conversations.pending_clarification_answered_at
--      ユーザーが回答した時刻。NULLならまだ未回答(pending)、
--      非NULLなら回答済み(answered、Execution成功/失敗待ち)。
--
-- 状態の表現(Phase54 Decision、4状態を4つのDB値として持たない):
--   pending_clarification_message_id IS NULL
--     → pendingなし / cleared
--   pending_clarification_message_id IS NOT NULL AND
--   pending_clarification_answered_at IS NULL
--     → pending
--   pending_clarification_message_id IS NOT NULL AND
--   pending_clarification_answered_at IS NOT NULL
--     → answered(Execution成功時に両方NULLへ戻す。
--       "executed"という状態を独立して永続化しない)
--
-- 元入力・質問文・回答文そのものは、conversation_messagesの既存行
-- (content列)から取得する(Derived、重複保存しない)。
--
-- 後方互換性: 既存117件のconversationsは、この3列すべてが
-- デフォルトNULLのまま有効に読み込める(Phase54 Section14)。
--
-- スコープ外(このmigrationに含めない):
--   - Artifact関連の列・テーブル
--   - Organization/Project scope関連の変更
--   - 楽観的ロック(既存のupdated_at列を新規に使い始めることもしない)
--   - TTL/staleness関連の列
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. conversation_messages.message_type
-- ---------------------------------------------------------------------
--
-- nullable。既存行はNULLのまま(=通常メッセージ)。
-- 値は現時点で"clarification_question"の1種類のみ
-- (汎用的なMessage taxonomyは作らない、Phase54/55共通の絶対条件)。

alter table public.conversation_messages
  add column if not exists message_type text null;

alter table public.conversation_messages
  drop constraint if exists conversation_messages_message_type_check;

alter table public.conversation_messages
  add constraint conversation_messages_message_type_check
  check (message_type in ('clarification_question'));


-- ---------------------------------------------------------------------
-- 2. conversations.pending_clarification_message_id
-- ---------------------------------------------------------------------
--
-- nullable。参照先のconversation_messages行が削除された場合は
-- SET NULLとする(conversations自体を巻き込んで壊さない、既存の
-- conversation_id FK群と同じON DELETE方針を踏襲)。

alter table public.conversations
  add column if not exists pending_clarification_message_id uuid null
    references public.conversation_messages (id)
    on delete set null;


-- ---------------------------------------------------------------------
-- 3. conversations.pending_clarification_answered_at
-- ---------------------------------------------------------------------

alter table public.conversations
  add column if not exists pending_clarification_answered_at timestamptz null;


-- ---------------------------------------------------------------------
-- 4. Row Level Security
-- ---------------------------------------------------------------------
--
-- 既存のconversations/conversation_messagesのRLSポリシー(Stage 0、
-- USING(true)/WITH CHECK(true))は行単位のポリシーであり、今回追加した
-- 列にも既存ポリシーがそのまま適用される。ポリシー自体の変更は不要。
