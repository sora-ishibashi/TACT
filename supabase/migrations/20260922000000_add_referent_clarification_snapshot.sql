-- =====================================================================
-- Migration: Referent Clarification — Pinned Candidate Snapshot
-- (REF-P1d)
-- =====================================================================
--
-- 背景 (ARCH-REF-1 Final Design Freeze Audit §13/§14、REF-P1d指示):
--   Clarificationでユーザーへ「1. Email A / 2. Email B」のように候補を
--   提示した後、新しいメールが到着しても、後続の「1」という回答は
--   常に元のcandidate Aを指さなければならない(TOCTOU safety)。この
--   ためには、提示した候補集合をClarification作成時点でimmutableに
--   永続化する必要がある。
--
--   このmigrationはSchemaの追加のみを行う(絶対条件: 破壊的変更禁止、
--   既存tact_clarifications行・既存constraint・既存RLS policyのいずれ
--   にも触れない)。
--
-- 対象テーブル(既存、20260910000000_create_tact_clarifications.sqlで
-- 新設済み): public.tact_clarifications
--
-- 追加する列(いずれもnullable、既定値なし):
--   candidate_snapshot jsonb      — 提示した候補の不変スナップショット
--     (index/sourceMessageRef/threadRef/sender/normalizedSubject/
--     observedAtのみ。本文・snippet・生provider payload・Composio ID・
--     Action proposal・Approval data・connection secret・OAuth情報は
--     一切含まない、REF-P1d絶対条件)。
--   candidate_snapshot_hash text  — candidate_snapshotの決定論的
--     canonicalization(core/tact-referent/clarification.tsの
--     stableStringify()、core/tact-work/approvalIntegrity.tsの
--     stableStringify()と同一アルゴリズム)に対するSHA-256 hex digest。
--     防御的な改ざん検出専用(defense-in-depth)であり、認可判定には
--     使わない。
--
-- 絶対条件(REF-P1d指示、明示的に追加しない列):
--   - selected_candidate_ref: 選択されたcandidateは既存のresponse列
--     (例: "1")+ candidate_snapshotから常に導出可能であり、別列で
--     二重に真実の源を持たせない。
--   - resolution_kind: 現時点で消費者が存在しないため導入しない。
--   - 新しいexpires_at: 既存のtact_clarifications.expires_at
--     (20260910000000で新設済み)をそのまま再利用する。
--
-- 既存の汎用(自由記述)Clarificationへの影響: 無い。この2列はいずれも
-- nullableであり、candidate_snapshot/candidate_snapshot_hashが
-- 両方ともNULLの既存行は、core/tact-work/clarification.tsの
-- resolveClarification()において referent-selection validation seam
-- を一切通過しない(既存の自由記述回答の挙動を完全に維持する)。
--
-- RLS: 新しい列は既存のtact_clarifications RLS policy
-- (tact_works.user_id = auth.uid()経由のEXISTS句、行単位の所有権判定)
-- にそのまま従う——列単位のpolicyではなく行単位のpolicyであるため、
-- 新しいpolicyの追加は不要(REF-P1d実装時に確認済み)。
--
-- =====================================================================

alter table public.tact_clarifications
  add column if not exists candidate_snapshot jsonb null,
  add column if not exists candidate_snapshot_hash text null;

-- candidate_snapshotがarray型であることのみを保証する、最小限の
-- 構造check(既存tact_works.evidence_refsの
-- tact_works_evidence_refs_array_checkと同じ設計方針)。要素の詳細な
-- shape検証はapplication層(core/tact-referent/clarification.tsの
-- parseCandidateSnapshot())が担う——DB層は「配列であること」だけを
-- 強制する。
alter table public.tact_clarifications
  drop constraint if exists tact_clarifications_candidate_snapshot_array_check;

alter table public.tact_clarifications
  add constraint tact_clarifications_candidate_snapshot_array_check
  check (candidate_snapshot is null or jsonb_typeof(candidate_snapshot) = 'array');

-- 既存のtact_clarifications RLS policy(20260910000000で新設済み、
-- tact_works.user_id = auth.uid()経由の行単位EXISTS句)への変更は
-- 一切無い(このmigrationはtact_clarifications_select_own/
-- insert_own/update_ownのいずれも変更しない)。
