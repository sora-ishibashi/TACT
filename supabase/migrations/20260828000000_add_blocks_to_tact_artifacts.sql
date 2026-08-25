-- =====================================================================
-- Migration: Add blocks to tact_artifacts (Phase 76)
-- =====================================================================
--
-- 目的(Phase76 Section3〜4): Artifactを単一のmarkdown文字列(content)
-- から、typeで判別可能なBlockの配列(ResearchSummary/Finding/
-- Evidence/Example/Table/Chart/Recommendation/Hypothesis/Text)へ
-- 構造化する。Section4の判断(Option A: Artifact内部のJSON/JSONBとして
-- Block構造を保持する。「構造化したいから」という理由だけで大量の
-- テーブルを新設しない)に基づき、既存tact_artifactsテーブルへ
-- nullableなjsonb列を1つ追加するだけの最小変更とする。
--
-- 既存content列は削除・変更しない(Section4「即座に削除・破壊しない」
-- 「既存Artifactとの互換性を維持する」)。既存行はblocks=NULLのまま
-- 成立し、core/tact-artifact/store.tsのtoArtifact()が読み取り時に
-- legacyContentToBlocks()でTextBlock 1件へ変換する(Section13
-- Backward Compatibility、アプリケーション層のadapterであり、DB側の
-- データ移行は行わない)。

alter table public.tact_artifacts
  add column if not exists blocks jsonb null;

-- RLS(Row Level Security)は既存のtact_artifacts向けpolicy
-- (select/insert/update/delete、auth.uid() = user_id)がそのまま
-- blocks列にも適用される。列追加のみのため、policy自体の変更は
-- 不要(Phase75のmigrationと同じ判断)。
