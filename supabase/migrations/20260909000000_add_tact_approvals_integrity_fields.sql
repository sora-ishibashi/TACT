-- =====================================================================
-- Migration: Approval Integrity Foundation (Architecture Migration
-- ARCH-P1a)
-- =====================================================================
--
-- 背景 (docs/architecture/approval-integrity.md):
--   現在のtact_approvals.payload(jsonb、Phase B1)は、Approval作成後に
--   一切UPDATEされない——ただしそれは「意図的に保護された不変条件」
--   ではなく、「そもそもpayload列を書き換えるコードが存在しないだけ」
--   という偶然の結果にすぎない。ARCH-P1(Approval Integrity)は、この
--   暗黙の不変条件を、明示的に検証可能な形(canonical・versioned・
--   hashedなApproval Subjectのsnapshot)へ置き換える。
--
--   このmigration(ARCH-P1a)は、そのsnapshotを保存できるようにする
--   ためのadditive schemaだけを追加する。既存のApproval作成
--   (core/tact-work/approval.tsのrequestApproval())は今回まだ
--   これらの列へ一切書き込まない(capture wiringはARCH-P1bで行う)。
--   execution-time verification(ARCH-P1c)も今回は実装しない。
--   ARCH-P1a完了時点で、既存productionのobservable behaviorは
--   一切変化しない。
--
-- 追加する列(すべてnullable、tact_approvalsへのadditive ALTERのみ):
--
--   1. subject_version integer
--      Approval Subjectのcanonicalization schema version
--      (core/tact-work/approvalIntegrity.tsのAPPROVAL_SUBJECT_VERSION)。
--      NULL = このApprovalにはsubjectがまだcaptureされていない
--      (ARCH-P1a/既存Approval、またはARCH-P1b以前に作成されたApproval)。
--
--      重要(single source of truth): この列は、subject_json内部に
--      埋め込まれるsubjectVersion値の「検索用に非正規化した写し」に
--      すぎない——真のsource of truthは常にsubject_json自身が持つ値
--      であり、この列単体を権威あるバージョン値として扱わない
--      (approval-integrity.md「Step 3」で明示された「曖昧な二重
--      source-of-truthを避ける」という要求への回答)。将来の検証ロジック
--      (ARCH-P1c)は、この列とsubject_json内部の値が一致することを
--      確認した上で使う。
--
--   2. subject_json jsonb
--      canonical Approval Subject(version 1の形は
--      core/tact-work/approvalIntegrity.tsのApprovalSubject型を参照)
--      をそのまま保存する。Provider固有ID・credential・secret・tokenの
--      いずれも含めない設計(approval-integrity.md Security Invariant
--      12)。
--
--      注意: PostgreSQLのjsonb型はkeyの挿入順序を保持する保証が
--      ない(内部表現へ正規化される)。そのためhash比較(下記
--      subject_hash)は、常にアプリケーション層のcanonicalization
--      関数(core/tact-work/approvalIntegrity.tsのcanonicalizeApprovalSubject())
--      を経由して再計算した文字列に対して行う——subject_jsonの生の
--      byte表現を直接hash材料として信用しない。
--
--   3. subject_hash text
--      canonicalize済みsubject_jsonのSHA-256 hex digest(小文字)。
--      hashだけをsource of truthにはしない(approval-integrity.md
--      Security Invariant 6、Binding StrategyのOption E)——
--      subject_json本体も必ず併せて保存する構成を維持する。
--
--   4. subject_captured_at timestamptz
--      subjectを実際にcaptureした時刻(通常requested_atとほぼ同時刻に
--      なる想定だが、将来の非同期capture等に備えて明示的に別列として
--      持つ)。
--
-- 意図的に追加しないもの(ARCH-P1a指示のNon-goals、approval-integrity.md
-- のSchema Draftで検討済みかつ却下済み):
--   - INVALIDATED相当のApprovalStatus値(既存5値: pending/approved/
--     rejected/cancelled/expiredを変更しない)
--   - supersedes_approval_id(再承認/supersession機構はARCH-P1では
--     実装しない、対応するfeature自体が存在しないため時期尚早)
--   - invalidated_at / invalidated_reason(「承認された事実」と
--     「現在executionに使えるか」を混同しないという設計判断——
--     integrity判定結果はApproval行自体を書き換える形では記録しない、
--     将来のAudit/Event entityの責務とする)
--
-- 後方互換性: 既存のtact_approvals行はすべて、追加する4列いずれも
-- NULLのまま有効に読み込める。破壊的ALTER(型変更・NOT NULL化・
-- 既存列の削除)は一切行わない。
--
-- RLS: 行単位ポリシー(Phase B1、Workを経由するEXISTS句)がそのまま
-- 新しい列にも適用されるため、ポリシー自体の変更は不要。
--
-- =====================================================================


alter table public.tact_approvals
  add column if not exists subject_version integer null;

alter table public.tact_approvals
  add column if not exists subject_json jsonb null;

alter table public.tact_approvals
  add column if not exists subject_hash text null;

alter table public.tact_approvals
  add column if not exists subject_captured_at timestamptz null;
