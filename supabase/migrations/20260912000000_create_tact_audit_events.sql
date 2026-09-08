-- =====================================================================
-- Migration: Append-Only Audit Event Foundation (Fast Port P4a)
-- =====================================================================
--
-- 背景 (docs/architecture/p2-p5-final-architecture.md Section15-20、
-- Fast Port P4a指示):
--   TACTには既にWork/Task/Run/Approval/Clarificationという「現在状態を
--   持つ」canonical entityがある。本migrationは、それらとは独立した
--   「何が・いつ・誰によって起きたか」を残すappend-only canonical
--   evidence(tact_audit_events)を新設する。current-state table
--   (例: tact_runs.status='failed')とevent log(例: 'run.failed'
--   というfactが発生した記録)は明確に別概念であり、このtableから
--   current stateを再構築するEvent Sourcingは行わない(TACTは
--   Event Sourced systemではない、絶対条件3/Step5)。
--
--   Prior Art(ADAPT_AND_BORROW、source codeはコピーしない):
--   BoundFlowのaudit_events table(tenant/workflow/request/event_type/
--   actor/occurred_at/details jsonbという構成)・AXMEのintent.event.v1
--   (monotonic sequence、deterministic ordering)。
--
--   このmigrationはSchemaの追加のみを行う。既存のtact_works/tact_tasks/
--   tact_runs/tact_approvals/tact_clarificationsのいずれの列・制約・
--   RLS policyも一切変更しない(絶対条件、Step23)。P4a時点でこの
--   tableへ実際に書き込むproduction pathは存在しない(event emission
--   wiringはP4bのscope、絶対条件14/Step17)。
--
-- =====================================================================
--
-- FK削除挙動の方針(Step12、既存schemaを読んだ上での判断):
--   一般的なAudit logの流儀では「元entityが消えてもaudit historyは
--   残すべき」という理由でON DELETE RESTRICT/FK無しが推奨されることが
--   多いが、TACTの既存schema(20260905000000/20260910000000migration)
--   を確認した結果、tact_works以下の全child table
--   (tact_tasks/tact_runs/tact_approvals/tact_clarifications)は
--   例外なくwork_idにON DELETE CASCADEを使っており、これは
--   「auth.users削除時に所有データが孤児化しないための既存規約」
--   (20260905000000migrationの既存コメント)として意図的に統一されて
--   いる。ここでwork_idだけRESTRICTにすると、Audit行が1件でも存在する
--   Workを持つuser accountの削除(auth.users cascade →
--   tact_works cascade)がFK違反で失敗するようになり、既存の
--   account削除フローに新しい失敗モードを持ち込んでしまう
--   (schemaに存在しない非対称性を新設することになる)。したがって
--   work_idは既存の全sibling tableと同じくON DELETE CASCADEを採用する
--   ——「Audit historyをWork削除より長く残す」という一般論より、
--   「既存のaccount削除cascade chainを壊さない」という実際のschema
--   制約を優先する。
--
--   task_id/run_id/approval_id/clarification_idは、tact_approvals.
--   task_idと同じ既存パターン(ON DELETE SET NULL)を踏襲する——
--   これらのsub-entityが削除されても、「何が起きたか」というAudit
--   Event自体は消えず、該当ポインタだけがNULLになる。
--
-- =====================================================================


create table if not exists public.tact_audit_events (

  id uuid not null primary key default gen_random_uuid(),

  work_id uuid not null references public.tact_works (id) on delete cascade,

  task_id uuid null references public.tact_tasks (id) on delete set null,

  run_id uuid null references public.tact_runs (id) on delete set null,

  approval_id uuid null references public.tact_approvals (id) on delete set null,

  clarification_id uuid null references public.tact_clarifications (id) on delete set null,

  -- Fast Port P4a Step3: P2-P5 Final Architecture Synthesisで確定した
  -- 「1 table + category(discriminating field)」方針。BoundFlow/Glean
  -- の"admin-config vs execution-activity"二軸を、物理テーブル分割
  -- ではなくこの1列で表現する。
  category text not null
    check (category in (
      'work', 'task', 'policy', 'human_interaction',
      'approval', 'clarification', 'execution', 'provider'
    )),

  -- Fast Port P4a Step4: stable machine-readable値。P4a時点では
  -- 誰もこのtableへemitしないため、実際にどの値が使われるかは未検証
  -- だが、型として将来利用できるfoundationとして最小限を登録する
  -- (過剰taxonomy回避、Step4絶対条件)。CHECK制約はtext列の自由入力を
  -- 防ぐためのapplication層と同期した閉じたenumとする。
  event_type text not null
    check (event_type in (
      'work.created',
      'task.created',
      'policy.evaluated',
      'approval.requested', 'approval.approved', 'approval.rejected',
      'clarification.requested', 'clarification.answered',
      'run.created', 'run.completed', 'run.failed',
      'provider.called', 'provider.completed', 'provider.failed'
    )),

  -- Fast Port P4a Step7: ActorReferenceをflat columnsとして保存する
  -- (TACT queryabilityを優先、Approval/Clarificationの既存
  -- requested_by_actor_kind/idパターンと同じ設計)。system event等、
  -- 人間actorが存在しない場合はいずれもNULL。
  actor_kind text null
    check (actor_kind is null or actor_kind in ('user', 'bot', 'system', 'ai')),

  actor_id text null,

  reason_code text null,

  -- Fast Port P4a Step9/10: policyDecision/riskClass/providerRef/
  -- runtimeRef等の専用列は、P4a時点で実際にこれらを書き込む
  -- producerが存在しないため今回は追加しない(過剰schema設計回避)。
  -- 必要になった時点(P4bの実配線で判明する)で、この汎用JSONB列の
  -- 中に置くか、専用列へ昇格するかを判断する。絶対条件7/8: raw
  -- secret/token/provider credential/Authorization headerを
  -- 一切含めない——application層(core/tact-work/audit.ts)がkey名
  -- ベースの最小限guardを行う。
  details jsonb null,

  -- Fast Port P4a Step6(Option A採用): globalにmonotonicな
  -- identity column。Postgresのgenerated always as identityは
  -- atomicにDBが採番するため、application側でMAX(sequence)+1を
  -- 計算するconcurrency hazard(Step6で明示的に警告されたB案)を
  -- 一切発生させない。Work単位でのdeterministic orderingは、
  -- 「work_idで絞り込んだ上でこのglobal sequenceでソートする」
  -- だけで安定して得られる——sequence自体がWorkごとに1から始まる
  -- 必要はない(AXMEのseqと同じ「単調増加する順序保証」という
  -- 目的を、より単純な仕組みで満たす)。integer(32bit、約21億件まで)
  -- を採用し、bigint(PostgRESTがJSON numberの精度損失を避けるため
  -- 文字列として返すことがある)によるapplication層の型変換の
  -- 複雑化を避ける。
  sequence integer generated always as identity,

  -- 実際に事実が発生した時刻(caller指定可能、省略時はnow())と、
  -- このAudit行が実際にDBへ挿入された時刻(常にnow()、server側)を
  -- 区別する(将来の非同期記録・batch記録に備える、Approval.
  -- subjectCapturedAtと同じ設計思想)。P4a時点でどちらも常に
  -- ほぼ同時刻になる(実emitterが存在しないため)。
  occurred_at timestamptz not null default now(),

  created_at timestamptz not null default now()

);

create index if not exists idx_tact_audit_events_work_id_sequence
  on public.tact_audit_events (work_id, sequence);

create index if not exists idx_tact_audit_events_task_id
  on public.tact_audit_events (task_id);

create index if not exists idx_tact_audit_events_category
  on public.tact_audit_events (category);


-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
--
-- Fast Port P4a Step11/13: SELECT/INSERTのみ(tact_approvals/
-- tact_clarificationsと同じEXISTS句パターン)。UPDATE/DELETE policyは
-- 意図的に定義しない——application層(core/tact-work/store.ts)にも
-- updateAuditEvent()/deleteAuditEvent()を実装しない(絶対条件4、
-- Step16)。RLS policyが存在しない操作はPostgRESTのデフォルト拒否に
-- より構造的に不可能になる(既存tact_tasks/tact_task_dependenciesの
-- 「使わない操作のpolicyを先回りで作らない」既存方針と同じ)。

alter table public.tact_audit_events enable row level security;

drop policy if exists "tact_audit_events_select_own" on public.tact_audit_events;
create policy "tact_audit_events_select_own"
  on public.tact_audit_events for select
  using (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "tact_audit_events_insert_own" on public.tact_audit_events;
create policy "tact_audit_events_insert_own"
  on public.tact_audit_events for insert
  with check (
    exists (
      select 1 from public.tact_works w
      where w.id = work_id and w.user_id = auth.uid()
    )
  );

-- update/delete policyは意図的に無し(append-only、絶対条件4)。
