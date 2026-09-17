-- =====================================================================
-- Migration: EventWait Correlation Constraints + UPDATE RLS (EVENT-P1c)
-- =====================================================================
--
-- 背景 (EVENT-P1c指示Section4「Cardinality Rule」・Section18
-- 「RLS/Service Auth」):
--   EVENT-P1a(20261015000000)はtact_event_waits/tact_external_events
--   にselect/insert RLS policyのみを与え、update policyを意図的に
--   持たなかった("それらが実際に必要になった時点で追加する")。
--   EVENT-P1cはEventWait/ExternalEvent/Taskを1つのDB transaction内で
--   atomicに書き換える(status遷移)必要があるため、このmigrationで
--   その「実際に必要になった時点」の分をだけを追加する。
--
--   このmigrationはSchema制約とRLS UPDATE policyの追加のみを行う。
--   実際にこれらを使うtransactional RPC(atomic claim function)は
--   別migration(20261016010000)へ分離する——「制約を追加する」ことと
--   「その制約を前提にしたbusiness logicを追加する」ことは別々に
--   reviewできるべき、という既存の分割慣習(20260930000000/
--   20261015010000等)をそのまま踏襲する。
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Cardinality制約(Section4絶対条件)
-- ---------------------------------------------------------------------
--
-- 「同じcanonical identity(user/source/eventType/subjectRef)に対して
-- pendingなEventWaitは同時に1件まで」——2つ目のpending waitを作ろうと
-- するINSERTは、この制約によりDBレベルで拒否される(application層の
-- 事前チェックに頼らない、既存のtact_runsのUNIQUE(task_id, attempt)と
-- 同じ設計哲学)。
--
-- 「同じTaskに対してpending/claimedなEventWaitは同時に1件まで」——
-- 1つのTaskが複数の外部イベントを同時に待つことをv1では許さない
-- (Section4)。claimed状態も対象に含める理由: claim成立後、Resume
-- pipelineがRunを作り終える前の短い区間でも、同じTaskに対して2つ目の
-- waitが作られることを防ぐため。
--
-- 両方とも部分unique index(WHERE句付き)を使う——expired/cancelled/
-- matchedになった過去のwaitは、この一意性の対象外(履歴として複数
-- 残ってよい)。

create unique index if not exists idx_tact_event_waits_pending_identity
  on public.tact_event_waits (user_id, expected_source, expected_event_type, subject_ref)
  where status = 'pending';

create unique index if not exists idx_tact_event_waits_active_per_task
  on public.tact_event_waits (task_id)
  where status in ('pending', 'claimed');


-- ---------------------------------------------------------------------
-- 2. UPDATE RLS policy追加(Section18: least privilege)
-- ---------------------------------------------------------------------
--
-- 20261016010000のtransactional RPC functionはSECURITY DEFINERを
-- 使わない(このmigrationのコメント・次migrationのfunction定義コメント
-- 参照——呼び出し元のJWT(auth.uid())でそのまま実行されるSECURITY
-- INVOKERのままにする)。そのため、RPC内部のUPDATE文がRLSを通過できる
-- よう、update policyを明示的に追加する必要がある。
--
-- 既存のselect/insert policyと全く同じ所有者判定
-- (auth.uid() = user_id、tact_worksと同じtop-level pattern)を使う——
-- 新しい権限モデルを作らない。

drop policy if exists "tact_external_events_update_own" on public.tact_external_events;
create policy "tact_external_events_update_own"
  on public.tact_external_events for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "tact_event_waits_update_own" on public.tact_event_waits;
create policy "tact_event_waits_update_own"
  on public.tact_event_waits for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- tact_tasksのupdate policy(20260906000000migration、EXISTS句による
-- Work経由のownership判定)は既に存在するため、このmigrationでは
-- 変更しない。tact_works/tact_external_events/tact_event_waits以外の
-- 既存テーブルのRLSにも一切触れない。
