-- =====================================================================
-- Migration: Add project_id to tact_conversations (Phase 74)
-- =====================================================================
--
-- 目的(Phase73 Investigation結論、Case B): Canonical Conversation
-- Architecture(tact_conversations、Phase64)には、既存Project
-- Architecture(projects、Phase30/31)への参照列が存在しなかった。
-- Legacy conversations.project_id(20260823000000migration)と同じ
-- 安全なパターンをtact_conversationsへも適用し、「Project = Folder」
-- というPhase74のUX方針をDBレベルで実現可能にする。
--
-- 絶対条件(Phase74 Section9): 「勝手にUIだけでProject所属を表現しない」
-- ため、この列を実際に追加する。Nullable・ON DELETE SET NULLとし、
-- 既存のtact_conversations(Phase64〜73時点で0件、実データへの影響なし)
-- を破壊しない。
--
-- 既存の3テーブル(tact_conversations/tact_conversation_messages/
-- tact_execution_records)・RLS・indexは一切変更しない。この列の
-- 追加のみを行う。

alter table public.tact_conversations
  add column if not exists project_id uuid null
    references public.projects (id) on delete set null;

create index if not exists idx_tact_conversations_project_id
  on public.tact_conversations (project_id);

-- RLSは変更しない(既存のtact_conversations_*_ownポリシーは
-- auth.uid() = user_idのみを条件としており、project_idの追加は
-- その判定に一切影響しない)。
