-- =====================================================================
-- Migration: Canonical ExternalEvent + EventWait Model (EVENT-P1a)
-- =====================================================================
--
-- 背景 (TACT EVENT-P1a Architecture Audit):
--   Work → Task → Run → 「外部イベントを待つ」→ ExternalEvent →
--   EventWait match → 新しいRun → Work continuation、という将来の
--   EVENT-P1b/c(Ingestion/Matching/Resume)のためのcanonical durable
--   data modelのみを、このmigrationで追加する。
--
--   絶対条件(Architecture Audit・EVENT-P1a指示、"DO NOT IMPLEMENT
--   YET"): webhook route・provider固有ingestion・matching実行・wait
--   claim・automatic resume・新しいRun作成・polling/cronのいずれも、
--   このmigrationにもcore/tact-work/store.tsのEVENT-P1a追加分にも
--   一切含まない。Schema/Types/最小限のCRUD Storeのみ。
--
--   既存テーブル(tact_works/tact_tasks/tact_runs/tact_approvals/
--   tact_clarifications)への変更は、tact_tasks.statusのCHECK制約更新
--   (waiting_for_eventの追加)のみで、これは別migration
--   (20261015010000_add_task_waiting_for_event_status.sql)に分離する
--   (20260930000000が"waiting_for_retry"追加を独立したmigrationにした
--   のと同じ理由: テーブル新設とstatus拡張は別々にrevertできるべき)。
--
-- Architecture Decision(Task.status="waiting_for_event" vs
-- EventWait.status="pending"の関係):
--   Task.status="waiting_for_event"はlifecycle projection(「今この
--   Taskは何をしている最中か」を一目で判定できる値)であり、
--   EventWait tableがcanonicalなwaiting-condition record(何を・
--   どう識別して・いつまで待つか)のsource of truthである。
--   Approval/Clarificationでは複数TaskにまたがりうるWork全体の待ちを
--   Work.statusで表現するが、EventWaitは常に単一のTask/Workに1:1で
--   属する(Section4「The wait belongs to one canonical Task and
--   Work」)ため、既存のWork.statusを再利用せず、Task.statusに新しい
--   値を追加する。
--
-- 対象テーブル(新設):
--   1. tact_external_events
--   2. tact_event_waits
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. tact_external_events
-- ---------------------------------------------------------------------
--
-- Ownership設計(tact_worksと同じtop-level pattern、tact_approvals/
-- tact_clarificationsとは異なる): ExternalEventは対応するEventWait
-- (ひいてはWork/Task)がまだ存在しない時点でも永続化できなければ
-- ならない(EVENT-P1b/c「event arrives first → persist as received →
-- wait may be created later → reconciliation may match it」、
-- Section9絶対条件: 「ExternalEvent storage must NOT require an
-- EventWait to exist」)。そのため、Work/TaskへのFKを一切持たず、
-- user_idを直接列として持つ(tact_worksと同じ、auth.uid() = user_id
-- によるRLS)。
--
-- Dedup設計(Section3): tact_bot_processed_events
-- (20260908000000_create_tact_bot_processed_events.sql)の
-- unique(channel, external_event_id)と同じ考え方——DB-levelの
-- unique indexを(source, external_event_id)に対して張り、同じ
-- provider配信がN回届いても、実際に永続化されるExternalEvent行は
-- 常に1件になることを保証する(in-memoryのみのdedupに頼らない)。

create table if not exists public.tact_external_events (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid not null references auth.users (id) on delete cascade,

  -- Provider識別子(例: 'slack', 'gmail', 'notion')。tact_runs.provider
  -- (Architecture Migration Phase C1でstringへ拡張済み)と同じ理由で
  -- closed enumにしない——将来のprovider追加のたびにCHECK制約を
  -- 変更する必要が無いようにする。
  source text not null check (char_length(source) between 1 and 100),

  -- Provider定義のevent種別(例: 'message.received',
  -- 'approval.decision')。sourceと同じ理由でfree text。
  event_type text not null check (char_length(event_type) between 1 and 200),

  -- Providerが払い出した、そのevent配信自体のID(dedupeの主要な材料)。
  external_event_id text not null check (char_length(external_event_id) between 1 and 500),

  -- Deterministic matching(Section6)の対象となる、canonicalな相関
  -- 識別子(例: Slack thread ID、Gmail message/thread ID、Notion page
  -- ID)。provider横断の正規化形式はEVENT-P1bのIngestion層の責務
  -- (このmigrationは値の形を強制しない)。
  subject_ref text not null check (char_length(subject_ref) between 1 and 1000),

  -- Providerが報告した実際の発生時刻。提供されない場合はNULL
  -- (絶対条件: 受信時刻で代用して推測しない)。
  occurred_at timestamptz null,

  received_at timestamptz not null default now(),

  -- 最小限のJSONのみ(絶対条件: 生のprovider payload全体をそのまま
  -- 保持しない、provider credential/authorizationデータを含めない)。
  -- tact_approvals.payloadと同じ設計(jsonb not null default '{}')。
  normalized_payload jsonb not null default '{}'::jsonb,

  status text not null default 'received'
    check (status in ('received', 'matched', 'unmatched', 'expired', 'invalid')),

  created_at timestamptz not null default now()

);

-- Section3(絶対条件): 同じprovider event配信がN回届いても、
-- 永続化される行は常にちょうど1件(app-level寛容チェックではなく、
-- DB-level unique constraintで保証する)。
create unique index if not exists idx_tact_external_events_source_external_event_id
  on public.tact_external_events (source, external_event_id);

-- 所有者スコープのlisting用(tact_worksのidx_tact_works_user_id_updated_at
-- と同じ形)。
create index if not exists idx_tact_external_events_user_id_received_at
  on public.tact_external_events (user_id, received_at desc);

-- Section6のdeterministic matching contractが将来引く検索
-- (event.source/event.eventType/event.subjectRef)を単純なindexで
-- 支える。matching実行自体はEVENT-P1cのscope。
create index if not exists idx_tact_external_events_subject_lookup
  on public.tact_external_events (source, event_type, subject_ref);


-- ---------------------------------------------------------------------
-- 2. tact_event_waits
-- ---------------------------------------------------------------------
--
-- Ownership設計: Approval/Clarificationと同じくWork/Taskの子entityだが
-- (work_id/task_idへのFKを持つ)、将来の直接lookup
-- (user/source/eventType/subjectRef、Section6)を素朴なJOIN無しで
-- 行えるよう、user_idを非正規化して直接持つ(ARCH-R2 Section5が
-- tact_runs.work_idをtask_id経由でも辿れるのに意図的に非正規化して
-- いるのと同じ理由)。Store層(core/tact-work/store.ts)は、この
-- user_idを呼び出し元から無条件に信用せず、常に検証済みのWork
-- ownership(WorkOwnershipDeps.getWork())から複製する——client供給値
-- と親Workのuser_idが乖離することは構造的に起こらない。RLSは
-- tact_worksと同じ直接比較(auth.uid() = user_id)を使う
-- (tact_approvals/tact_clarificationsのEXISTS句ownershipより単純だが、
-- store層がuser_idを常にWork由来の値で埋めるため、実効的な
-- ownership保証は同一)。

create table if not exists public.tact_event_waits (

  id uuid not null primary key default gen_random_uuid(),

  user_id uuid not null references auth.users (id) on delete cascade,

  work_id uuid not null references public.tact_works (id) on delete cascade,

  -- Approval/Clarificationのtask_idはoptional(Work全体に対するwaitで
  -- ありうる)だが、EventWaitは常に単一のTaskに1:1で属する
  -- (Section4「The wait belongs to one canonical Task and Work」)。
  -- Task削除時、対応するwaiting conditionも意味を失うためcascade
  -- (tact_runsのtask_id cascadeと同じ判断——Approval/Clarificationの
  -- 「Task削除でも監査記録は残す」SET NULLとは異なり、EventWaitは
  -- 独立した監査記録ではなくTaskの実行状態そのものの一部であるため)。
  task_id uuid not null references public.tact_tasks (id) on delete cascade,

  expected_source text not null check (char_length(expected_source) between 1 and 100),

  expected_event_type text not null check (char_length(expected_event_type) between 1 and 200),

  -- Section6のdeterministic matching contract:
  --   event.user_id = wait.user_id
  --   AND event.source = wait.expected_source
  --   AND event.event_type = wait.expected_event_type
  --   AND event.subject_ref = wait.subject_ref
  -- fuzzy/LLMによる比較の余地は無い(絶対条件、content-based matching
  -- 禁止)。
  subject_ref text not null check (char_length(subject_ref) between 1 and 1000),

  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'expired', 'cancelled')),

  created_at timestamptz not null default now(),

  -- Task.wait_until(TIME-P1a)と同じ「gateであり、authorizeではない」
  -- 意味論——期限超過を自動検出・自動失効させるscheduler/cronは
  -- このphaseでは一切実装しない。
  expires_at timestamptz null,

  -- claim成立時(EVENT-P1c)にのみ設定される。参照先ExternalEventが
  -- 削除されてもEventWait自体の記録は残す(SET NULL、tact_tasks.
  -- parent_task_idと同じ「参照先消失で自分を巻き込み削除しない」
  -- パターン)。EVENT-P1a時点でこの列を書き込むproducerは存在しない。
  claimed_by_event_id uuid null
    references public.tact_external_events (id) on delete set null

);

create index if not exists idx_tact_event_waits_work_id
  on public.tact_event_waits (work_id);

create index if not exists idx_tact_event_waits_task_id
  on public.tact_event_waits (task_id);

-- Section6/Section12: 将来のmatching実行(EVENT-P1c)が引く
-- 「このuser/source/eventType/subjectRefに対してpendingなwaitが
-- あるか」という検索を単純なindexで支える。
create index if not exists idx_tact_event_waits_pending_lookup
  on public.tact_event_waits (user_id, expected_source, expected_event_type, subject_ref);


-- ---------------------------------------------------------------------
-- 3. Row Level Security
-- ---------------------------------------------------------------------

alter table public.tact_external_events enable row level security;

drop policy if exists "tact_external_events_select_own" on public.tact_external_events;
create policy "tact_external_events_select_own"
  on public.tact_external_events for select
  using (auth.uid() = user_id);

drop policy if exists "tact_external_events_insert_own" on public.tact_external_events;
create policy "tact_external_events_insert_own"
  on public.tact_external_events for insert
  with check (auth.uid() = user_id);

-- EVENT-P1aのStore(core/tact-work/store.ts)はcreate/getのみを行う
-- (Section14: claimEventWait()/matchExternalEvent()はEVENT-P1b/cの
-- scope)。update/delete policyは、それらが実際に必要になった時点で
-- 追加する(tact_tasksのupdate policy未定義と同じ既存方針)。

alter table public.tact_event_waits enable row level security;

drop policy if exists "tact_event_waits_select_own" on public.tact_event_waits;
create policy "tact_event_waits_select_own"
  on public.tact_event_waits for select
  using (auth.uid() = user_id);

drop policy if exists "tact_event_waits_insert_own" on public.tact_event_waits;
create policy "tact_event_waits_insert_own"
  on public.tact_event_waits for insert
  with check (auth.uid() = user_id);

-- tact_works/tact_tasks/tact_runs/tact_approvals/tact_clarificationsの
-- 既存Schema・RLSへの変更は一切無い(tact_tasks.statusのCHECK制約
-- 更新のみ、別migration 20261015010000で行う)。
