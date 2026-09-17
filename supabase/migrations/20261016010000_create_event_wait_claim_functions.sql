-- =====================================================================
-- Migration: Atomic Event/Wait/Task Correlation Functions (EVENT-P1c)
-- =====================================================================
--
-- 背景 (EVENT-P1c指示Section2「Core Architecture Decision」・Section5
-- 「Transactional Claim」):
--   ExternalEvent(received) + EventWait(pending) + Task(waiting_for_event)
--   を、1つのDB transactionの中でatomicに
--   ExternalEvent(matched) + EventWait(claimed) + Task(pending)
--   へ遷移させる。standalone PostgREST UPDATEの列挙(read-then-write)
--   では、複数のrequestが同じEventWait/ExternalEventを同時に処理
--   しようとするraceを防げない(TOCTOU)ため、単一のtransactional
--   RPC(Postgres function)として実装する。
--
-- SECURITY INVOKERを選ぶ理由(Section18「least privilege」、
-- SECURITY DEFINERを避ける):
--   呼び出し元は常にcreateRequestScopedClient(accessToken)
--   (core/tact-work/store.ts、既存の全関数と同じ)経由でこのfunctionを
--   呼ぶ。そのため、function内のauth.uid()は呼び出したuser本人を正しく
--   指す。functionをSECURITY INVOKER(既定、宣言省略)のままにすることで、
--   20261016000000migrationで追加したUPDATE RLS policy
--   (auth.uid() = user_id)がfunction内のUPDATE文にもそのまま適用され、
--   「他userの行を書き換えられるgeneric RPC」には構造的になり得ない。
--   Section18が要求する「caller-supplied owner trustを持たない」を、
--   新しい検証コードではなく既存のRLS機構への素直な依拠で満たす。
--   defense-in-depthとして、functionの各SELECT/UPDATEにも明示的に
--   user_id = auth.uid() (またはtact_worksへのJOIN経由の同等の条件)を
--   書く——RLSだけに頼らず、function自身のSQL文からも所有権判定が
--   読み取れるようにする。
--
-- Run作成はこのfunctionの範囲外(絶対条件、Section5「No Run creation
-- inside the RPC」・Section15「Reuse existing UNIQUE(task_id, attempt)」)。
-- Task(waiting_for_event → pending)までがこのfunctionの責務であり、
-- pending → runningの遷移とRun作成は、既存のcore/tact-integration/
-- execution.tsのprepareRunForExecution()(このmigrationからは一切
-- 参照しない)に委ねる。
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. tact_claim_matched_event_wait(p_event_id, p_wait_id)
-- ---------------------------------------------------------------------
--
-- 「この特定の(event, wait)ペアをatomicにclaimする」という核となる
-- 遷移だけを行う内部関数。呼び出し元(下記2関数)は、どの(event, wait)
-- ペアがdeterministic matching contract(Section3)を満たすかを事前に
-- 決定してからこの関数を呼ぶ——この関数自身はmatching検索を行わない
-- (責務分離: 「候補を選ぶ」と「選ばれた候補をatomicに確定する」を
-- 別々にすることで、後者のcritical sectionを小さく保つ)。
--
-- 戻り値はjsonb(呼び出し元TS側での型安全なparsingのため)。
--   {"status": "wait_claimed", "eventId", "waitId", "taskId", "workId"}
--   {"status": "event_not_found"}
--   {"status": "event_not_receivable", "eventStatus"}
--   {"status": "wait_not_found"}
--   {"status": "wait_already_claimed", "waitStatus"}
--   {"status": "wait_wrong_owner"}
--   {"status": "wait_expired"}
--   {"status": "wait_task_not_resumable", "reason", "taskStatus"?}
--   {"status": "wait_work_terminal", "workStatus"?}
--
-- FOR UPDATEによる行ロック(Section5 Step1)+ 各UPDATE文自体の
-- WHERE句によるCAS(既存store.tsのcompleteRun()/failRun()と同じ
-- 「status='X' WHERE句 + affected row数確認」パターン)の二重の
-- 防御を行う——通常の並行性はFOR UPDATEで十分に直列化されるが、
-- 万一の想定外のcode pathでも「気づかず不整合な状態のまま進む」
-- ことがないようにする。

create or replace function public.tact_claim_matched_event_wait(
  p_event_id uuid,
  p_wait_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_event record;
  v_wait record;
  v_task record;
  v_work record;
  v_claimed_wait_id uuid;
  v_updated_task_id uuid;
  v_updated_event_id uuid;
begin

  -- Step1: ExternalEventをlock + load(呼び出し元本人のuser_idのみ、
  -- caller-supplied owner trustを持たない——auth.uid()以外の
  -- user identityを一切信用しない)。
  select * into v_event
  from public.tact_external_events
  where id = p_event_id
    and user_id = auth.uid()
  for update;

  if not found then
    return jsonb_build_object('status', 'event_not_found');
  end if;

  if v_event.status <> 'received' then
    -- 既にmatched/expired/invalid、または同じeventに対する重複呼び出し
    -- (idempotent-safeにするため、errorではなくtyped outcomeとして
    -- 返す——Section22「Already-matched same event/wait should be
    -- idempotent/reconcilable, not treated as a new claim」)。
    return jsonb_build_object('status', 'event_not_receivable', 'eventStatus', v_event.status);
  end if;

  -- EventWaitをlock + load。
  select * into v_wait
  from public.tact_event_waits
  where id = p_wait_id
    and user_id = auth.uid()
  for update;

  if not found then
    return jsonb_build_object('status', 'wait_not_found');
  end if;

  if v_wait.status <> 'pending' then
    return jsonb_build_object('status', 'wait_already_claimed', 'waitStatus', v_wait.status);
  end if;

  -- Section3: deterministic matching contractをこのfunction自身でも
  -- 再確認する(呼び出し元が既に絞り込んだ候補だけを渡してくる前提に
  -- 依存しない、defense-in-depth)。
  if v_event.user_id <> v_wait.user_id
     or v_event.source <> v_wait.expected_source
     or v_event.event_type <> v_wait.expected_event_type
     or v_event.subject_ref <> v_wait.subject_ref then
    return jsonb_build_object('status', 'wait_wrong_owner');
  end if;

  -- Section6: durable receipt time(processing timeではない)による
  -- expiry判定。境界値(receivedAt = expiresAt)はexpired側とする(>=)。
  if v_wait.expires_at is not null and v_event.received_at >= v_wait.expires_at then

    update public.tact_event_waits
    set status = 'expired'
    where id = v_wait.id and status = 'pending';

    return jsonb_build_object('status', 'wait_expired');

  end if;

  -- Taskをlock + load(EventWait.work_idの所有者としてのauth.uid()を
  -- 経由、tact_tasks自体はuser_id列を持たないためtact_worksへJOINする
  -- ——既存のRLS EXISTS句パターンと同じ判定をこのfunction自身にも書く)。
  select t.* into v_task
  from public.tact_tasks t
  join public.tact_works w on w.id = t.work_id
  where t.id = v_wait.task_id
    and w.user_id = auth.uid()
  for update of t;

  if not found then
    return jsonb_build_object('status', 'wait_task_not_resumable', 'reason', 'task_not_found');
  end if;

  -- Section21「Task does not belong to wait.workId」の明示的な
  -- 整合性チェック(schema上は起こらないはずだが、fail closedに扱う)。
  if v_task.work_id <> v_wait.work_id then
    return jsonb_build_object('status', 'wait_task_not_resumable', 'reason', 'task_work_mismatch');
  end if;

  if v_task.status in ('completed', 'failed', 'cancelled') then

    -- Section14: terminal TaskへのstaleなpendingWaitは、resumeしようと
    -- せずcancelする(Run作成もmutateもしない)。
    update public.tact_event_waits
    set status = 'cancelled'
    where id = v_wait.id and status = 'pending';

    return jsonb_build_object('status', 'wait_task_not_resumable', 'reason', 'task_terminal', 'taskStatus', v_task.status);

  end if;

  if v_task.status <> 'waiting_for_event' then
    -- pending/running/waiting_for_retryのいずれであっても、このTaskは
    -- 「今まさにこのEventWaitの成立を待っている」状態ではない
    -- ——claimしない(Section21 state machine、waiting_for_event以外
    -- からの遷移は認めない)。
    return jsonb_build_object('status', 'wait_task_not_resumable', 'reason', 'task_not_waiting_for_event', 'taskStatus', v_task.status);
  end if;

  -- Workをload(Section14: terminal Workのcheck)。
  select * into v_work
  from public.tact_works
  where id = v_wait.work_id
    and user_id = auth.uid();

  if not found then
    return jsonb_build_object('status', 'wait_work_terminal', 'reason', 'work_not_found');
  end if;

  if v_work.status in ('completed', 'failed', 'cancelled') then

    update public.tact_event_waits
    set status = 'cancelled'
    where id = v_wait.id and status = 'pending';

    return jsonb_build_object('status', 'wait_work_terminal', 'workStatus', v_work.status);

  end if;

  -- ---- Step4-6(Section5): atomicな書き込み ----

  update public.tact_event_waits
  set status = 'claimed', claimed_by_event_id = v_event.id
  where id = v_wait.id and status = 'pending'
  returning id into v_claimed_wait_id;

  if v_claimed_wait_id is null then
    -- FOR UPDATEで直列化されているため通常到達しないが、想定外の
    -- 状態のまま先へ進むより、例外で全体をrollbackする方を選ぶ
    -- (fail closed、Section21の不変条件を守る)。
    raise exception 'tact_claim_matched_event_wait: EventWait % lost the pending->claimed race unexpectedly', v_wait.id;
  end if;

  update public.tact_tasks
  set status = 'pending', updated_at = now()
  where id = v_task.id and status = 'waiting_for_event'
  returning id into v_updated_task_id;

  if v_updated_task_id is null then
    raise exception 'tact_claim_matched_event_wait: Task % was not waiting_for_event at claim time', v_task.id;
  end if;

  update public.tact_external_events
  set status = 'matched'
  where id = v_event.id and status = 'received'
  returning id into v_updated_event_id;

  if v_updated_event_id is null then
    raise exception 'tact_claim_matched_event_wait: ExternalEvent % was not received at claim time', v_event.id;
  end if;

  return jsonb_build_object(
    'status', 'wait_claimed',
    'eventId', v_event.id,
    'waitId', v_wait.id,
    'taskId', v_task.id,
    'workId', v_wait.work_id
  );

end;
$$;


-- ---------------------------------------------------------------------
-- 2. tact_match_and_claim_external_event(p_event_id)
-- ---------------------------------------------------------------------
--
-- Section9「Normal Event Flow」の入口。EVENT-P1b ingestが
-- ExternalEvent(received)を永続化した直後(または、event_duplicateで
-- 既存eventを再対象にした場合)に呼ばれる想定。
--
-- Section4「Cardinality Rule」: マッチする候補が0件ならevent_unmatched
-- (Section7/8: event-before-wait、waitがまだ無いだけであり、
-- unmatchedへ確定させない——ExternalEvent.statusは'received'のまま
-- 変更しない)。1件ならclaimを試みる。2件以上ならevent_ambiguous
-- (claimしない、oldest/firstを選ばない)。
--
-- 部分unique index(idx_tact_event_waits_pending_identity、
-- 20261016000000)が通常は「同一identityのpending waitは常に1件以下」
-- を保証するが、legacy/corrupt dataの可能性を排除しない
-- (Section4「If legacy/corrupt data produces multiple matching waits」)
-- ため、この関数はcandidate件数を必ず数えてから分岐する。

create or replace function public.tact_match_and_claim_external_event(
  p_event_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_event record;
  v_candidate_count integer;
  v_wait_id uuid;
begin

  select * into v_event
  from public.tact_external_events
  where id = p_event_id
    and user_id = auth.uid();

  if not found then
    return jsonb_build_object('status', 'event_not_found');
  end if;

  if v_event.status <> 'received' then
    return jsonb_build_object('status', 'event_not_receivable', 'eventStatus', v_event.status);
  end if;

  -- min(uuid) has no built-in aggregate in Postgres; cast through text
  -- (which does) and back. Safe because v_wait_id is only consumed when
  -- v_candidate_count = 1 (exactly one row), so the tie-break order is
  -- irrelevant.
  select count(*), min(id::text)::uuid into v_candidate_count, v_wait_id
  from public.tact_event_waits
  where user_id = v_event.user_id
    and expected_source = v_event.source
    and expected_event_type = v_event.event_type
    and subject_ref = v_event.subject_ref
    and status = 'pending';

  if v_candidate_count = 0 then
    return jsonb_build_object('status', 'event_unmatched');
  end if;

  if v_candidate_count > 1 then
    return jsonb_build_object('status', 'event_ambiguous', 'candidateCount', v_candidate_count);
  end if;

  return public.tact_claim_matched_event_wait(v_event.id, v_wait_id);

end;
$$;


-- ---------------------------------------------------------------------
-- 3. tact_create_event_wait(p_task_id, p_expected_source,
--    p_expected_event_type, p_subject_ref, p_expires_at)
-- ---------------------------------------------------------------------
--
-- Section8「Event Before Wait」: EventWait作成(+ Task
-- pending→waiting_for_eventの遷移)を、既に"received"な
-- ExternalEventとの照合と同一transactionにする——「wait作成 →
-- (crashの可能性がある間隙) → 別プロセスが古いeventを拾う」という
-- best-effort post-commit callを避ける。
--
-- 複数の"received" ExternalEventが偶然同じidentityに一致する場合
-- (例: 同じthreadへの複数の正当な返信)、この関数はどれを選ぶかを
-- 推測しない——ちょうど1件のcandidateにだけ自動的にclaimを試みる
-- (Section4と同じfail-closed方針を、"複数waitが1 eventに一致"では
-- なく"複数eventが1 waitに一致"という逆方向のambiguityにも適用する)。
-- 0件または2件以上の場合はEventWaitをpendingのまま残し、個々の
-- ExternalEventが届く(または再処理される)度のtact_match_and_claim_
-- external_event()呼び出しに委ねる。

create or replace function public.tact_create_event_wait(
  p_task_id uuid,
  p_expected_source text,
  p_expected_event_type text,
  p_subject_ref text,
  p_expires_at timestamptz default null
) returns jsonb
language plpgsql
as $$
declare
  v_task record;
  v_work record;
  v_wait_id uuid;
  v_updated_task_id uuid;
  v_candidate_count integer;
  v_candidate_event_id uuid;
  v_claim_result jsonb;
begin

  select t.* into v_task
  from public.tact_tasks t
  join public.tact_works w on w.id = t.work_id
  where t.id = p_task_id
    and w.user_id = auth.uid()
  for update of t;

  if not found then
    return jsonb_build_object('status', 'task_not_found');
  end if;

  select * into v_work
  from public.tact_works
  where id = v_task.work_id
    and user_id = auth.uid();

  if not found or v_work.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('status', 'wait_work_terminal', 'workStatus', v_work.status);
  end if;

  if v_task.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('status', 'wait_task_not_resumable', 'reason', 'task_terminal', 'taskStatus', v_task.status);
  end if;

  if v_task.status <> 'pending' then
    -- Section21 state machine: waiting_for_eventはpendingからのみ開始
    -- できる。running/waiting_for_retry/既にwaiting_for_eventのTaskに
    -- 対して2つ目のwaitを作ろうとする呼び出しを、部分unique index
    -- violationという不親切なDBエラーではなく、意味の分かるtyped
    -- outcomeとして拒否する。
    return jsonb_build_object('status', 'wait_task_not_resumable', 'reason', 'task_not_pending', 'taskStatus', v_task.status);
  end if;

  insert into public.tact_event_waits (
    user_id, work_id, task_id, expected_source, expected_event_type, subject_ref, expires_at
  ) values (
    auth.uid(), v_task.work_id, v_task.id, p_expected_source, p_expected_event_type, p_subject_ref, p_expires_at
  )
  returning id into v_wait_id;

  update public.tact_tasks
  set status = 'waiting_for_event', updated_at = now()
  where id = v_task.id and status = 'pending'
  returning id into v_updated_task_id;

  if v_updated_task_id is null then
    raise exception 'tact_create_event_wait: Task % was not pending at wait-creation time', v_task.id;
  end if;

  -- min(uuid) has no built-in aggregate in Postgres; cast through text
  -- (which does) and back. Safe because v_candidate_event_id is only
  -- consumed when v_candidate_count = 1 (exactly one row), so the
  -- tie-break order is irrelevant.
  select count(*), min(id::text)::uuid into v_candidate_count, v_candidate_event_id
  from public.tact_external_events
  where user_id = auth.uid()
    and source = p_expected_source
    and event_type = p_expected_event_type
    and subject_ref = p_subject_ref
    and status = 'received';

  if v_candidate_count = 1 then
    v_claim_result := public.tact_claim_matched_event_wait(v_candidate_event_id, v_wait_id);
  elsif v_candidate_count = 0 then
    v_claim_result := jsonb_build_object('status', 'event_unmatched');
  else
    v_claim_result := jsonb_build_object('status', 'event_ambiguous', 'candidateCount', v_candidate_count);
  end if;

  return jsonb_build_object(
    'status', 'wait_created',
    'waitId', v_wait_id,
    'taskId', v_task.id,
    'workId', v_task.work_id,
    'reconciliation', v_claim_result
  );

end;
$$;

-- 絶対条件(Section17「Do not loosen RLS broadly」・Section18):
-- 上記3 functionはいずれもSECURITY INVOKER(既定)のまま——このmigration
-- はEXECUTE権限を新たに付与しない(Supabaseのデフォルトで
-- authenticatedロールがpublic schema配下のfunctionをEXECUTEできる
-- 既存設定にそのまま乗る。個別のGRANT/REVOKEをこのmigrationでは
-- 追加しない)。Run作成・provider実行のいずれもこのmigration内の
-- functionからは一切呼ばれない(Section5/25絶対条件)。
