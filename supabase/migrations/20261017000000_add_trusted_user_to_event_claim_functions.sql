-- =====================================================================
-- Migration: Trusted-Caller User Override for Event Claim Functions
-- (EVENT-P1d Phase 1)
-- =====================================================================
--
-- 背景 (EVENT-P1d pre-audit Critical Design Question 2):
--   core/tact-bot/execution/trustedApprovalDecision.tsと同じ既存の
--   trusted execution boundaryパターン(service role keyを
--   createRequestScopedClient()のaccessTokenとしてそのまま渡し、
--   各store関数の明示的な.eq("user_id", userId)フィルタをdefense-in-
--   depthとして信用する)は、core/tact-work/store.tsのcreateWork()/
--   updateWorkStatus()/createTask()/listRunsForTask()・
--   core/tact-work/resume.tsのrequestTaskResume()・
--   core/tact-conversation/orchestration.tsのexecutePreparedTaskResume()
--   では既に本番で機能している(いずれも呼び出し元からuserIdを明示的に
--   受け取り、auth.uid()に一切依存しないため)。
--
--   しかし20261016010000で追加したtact_match_and_claim_external_event()/
--   tact_claim_matched_event_wait()はSECURITY INVOKERのまま、
--   全てのownership判定をauth.uid()だけに依存する設計だった
--   (Reality-Tested時点では、これらは常に実userのJWTを持つ
--   request-scoped clientからのみ呼ばれる前提だったため)。service
--   role keyをaccessTokenとして渡した場合、その接続のauth.uid()は
--   常にNULLになる(service role JWTにはsubクレームが無い)ため、
--   これらのfunctionは常にevent_not_found/wait_not_found相当を返して
--   しまい、trusted Bot boundary(EVENT-P1d、Slack実連携)からは
--   一切機能しない。
--
-- 修正方針(EVENT-P1d指示、絶対条件):
--   auth.role()は使わない(Supabaseが非推奨としている)。代わりに
--   実際のPostgres接続roleそのもの(current_user)を見る——service
--   role keyで接続した場合、PostgRESTは実際にPostgresの
--   `service_role`ロールとして接続を確立するため、current_user =
--   'service_role'は「本当にservice role接続であるかどうか」を
--   偽装不可能な形で判定できる(通常のauthenticated/anonロールで
--   接続している限り、この式は決して真にならない——RLSポリシーの
--   ような追加の許可設定を一切必要としない、Postgresの接続roleその
--   ものに基づく判定)。
--
--   両function共通のeffective user id導出:
--     effective_user_id :=
--       case
--         when current_user = 'service_role' and p_trusted_user_id is not null
--           then p_trusted_user_id
--         else auth.uid()
--       end;
--
--   既存の実user JWT経路(current_user <> 'service_role'、Reality-
--   Tested済み)は、p_trusted_user_idが渡されているかどうかに関わらず
--   常にauth.uid()だけを使う——CASE式の条件がservice_role接続でない
--   限り決して真にならないため、非service-role callerがp_trusted_
--   user_idを渡しても構造的に無視される(「明示的にrejectする」ので
--   はなく、「そもそも効果を持ち得ない」という、より単純で読みやすい
--   fail-closed設計。Section「Choose the clearer fail-closed behavior」
--   に対する判断)。
--
-- 変更しないこと(絶対条件):
--   - SECURITY DEFINERにしない(引き続きSECURITY INVOKER、既定のまま
--     宣言省略)。
--   - 既存のauth.uid() = user_id ownership checkを実user経路から
--     取り除かない(effective_user_id経由で完全に同じ判定を行う、
--     単なる変数への置き換え)。
--   - RLSを広げない(20261016000000のUPDATE RLS policyは無変更)。
--   - matching cardinality(Section4)・atomic transaction semantics
--     (Section5)・terminal Work semantics(Section14)・expiry
--     semantics(Section6)のいずれも一切変更しない——全てのbusiness
--     logicはeffective_user_idへの1箇所の置き換えを除いて完全に
--     同一。
--
--   tact_create_event_wait()は今回変更しない(EVENT-P1d最小scope:
--   waitの作成は既存の実user session経由のままで十分——Slack
--   webhookが起動するのはmatch/resume側のみ、EVENT-P1d pre-audit
--   Recommendation)。tact_claim_matched_event_wait()の
--   デフォルト引数(p_trusted_user_id uuid default null)により、
--   tact_create_event_wait()内部の既存2引数呼び出し
--   (tact_claim_matched_event_wait(v_candidate_event_id, v_wait_id))
--   はNULLが暗黙に渡されるだけで、挙動は一切変わらない
--   (後方互換、既存のRealityTestに対する無回帰)。
--
-- =====================================================================

-- Staging Reality Test finding(EVENT-P1d Phase9、schema bug、fail closed
-- ではなく即座に発見・診断・最小修正): `create or replace function`は、
-- 引数リストが異なる(defaultを持つ追加引数を1つ増やしただけでも)場合、
-- 既存のfunctionを置き換えず、別のoverloadとして新規に追加する
-- ——Postgresはfunctionを「名前 + 入力引数型の並び」で識別するため。
-- そのため、この修正なしでは20261016010000で作成された旧
-- signature(tact_match_and_claim_external_event(uuid)・
-- tact_claim_matched_event_wait(uuid, uuid))と、直後のcreate or
-- replaceによる新signatureが両方カタログに残ってしまい、PostgRESTが
-- p_event_idだけを渡すRPC呼び出しをどちらのoverloadにも解決できず
-- `PGRST203 Could not choose the best candidate function`で失敗する
-- (Staging Postgresへの実際のRPC呼び出しで確認済み)。
--
-- 修正: 新しいsignatureをcreateする前に、旧signatureを明示的にdropする。
-- tact_create_event_wait()(このmigrationでは変更しない、EVENT-P1dの
-- scope外)内部のtact_claim_matched_event_wait(v_candidate_event_id,
-- v_wait_id)という既存の2引数呼び出しは、drop後にカタログに残る唯一の
-- overload(3引数、p_trusted_user_idはdefault null)へ問題なく解決される
-- (PL/pgSQL内のfunction呼び出しは実行時に名前+引数リストで再解決される
-- ため、2引数呼び出しは3番目がdefault nullの3引数functionへ一意に
-- 一致する)。
drop function if exists public.tact_match_and_claim_external_event(uuid);
drop function if exists public.tact_claim_matched_event_wait(uuid, uuid);

-- ---------------------------------------------------------------------
-- 1. tact_claim_matched_event_wait(p_event_id, p_wait_id, p_trusted_user_id)
-- ---------------------------------------------------------------------

create or replace function public.tact_claim_matched_event_wait(
  p_event_id uuid,
  p_wait_id uuid,
  p_trusted_user_id uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_effective_user_id uuid;
  v_event record;
  v_wait record;
  v_task record;
  v_work record;
  v_claimed_wait_id uuid;
  v_updated_task_id uuid;
  v_updated_event_id uuid;
begin

  -- EVENT-P1d: service role接続(current_user = 'service_role')かつ
  -- p_trusted_user_idが明示的に渡された場合のみ、それをeffective user
  -- として使う。それ以外(通常のauthenticatedロール接続)では、
  -- p_trusted_user_idの値に関わらず常にauth.uid()を使う——非service-
  -- role callerによるoverrideは構造的に一切効果を持たない。
  v_effective_user_id := case
    when current_user = 'service_role' and p_trusted_user_id is not null
      then p_trusted_user_id
    else auth.uid()
  end;

  -- Step1: ExternalEventをlock + load(呼び出し元本人のuser_idのみ、
  -- caller-supplied owner trustを持たない——effective_user_id以外の
  -- user identityを一切信用しない)。
  select * into v_event
  from public.tact_external_events
  where id = p_event_id
    and user_id = v_effective_user_id
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
    and user_id = v_effective_user_id
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

  -- Taskをlock + load(EventWait.work_idの所有者としてのeffective_
  -- user_idを経由、tact_tasks自体はuser_id列を持たないためtact_works
  -- へJOINする——既存のRLS EXISTS句パターンと同じ判定をこのfunction
  -- 自身にも書く)。
  select t.* into v_task
  from public.tact_tasks t
  join public.tact_works w on w.id = t.work_id
  where t.id = v_wait.task_id
    and w.user_id = v_effective_user_id
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
    and user_id = v_effective_user_id;

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
-- 2. tact_match_and_claim_external_event(p_event_id, p_trusted_user_id)
-- ---------------------------------------------------------------------

create or replace function public.tact_match_and_claim_external_event(
  p_event_id uuid,
  p_trusted_user_id uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_effective_user_id uuid;
  v_event record;
  v_candidate_count integer;
  v_wait_id uuid;
begin

  -- EVENT-P1d: tact_claim_matched_event_wait()と全く同じeffective
  -- user id導出(絶対条件、両function間で判定ロジックを重複させず
  -- 同一にする)。
  v_effective_user_id := case
    when current_user = 'service_role' and p_trusted_user_id is not null
      then p_trusted_user_id
    else auth.uid()
  end;

  select * into v_event
  from public.tact_external_events
  where id = p_event_id
    and user_id = v_effective_user_id;

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

  -- EVENT-P1d: effective_user_idをそのままtact_claim_matched_event_
  -- wait()のp_trusted_user_idへ引き継ぐ——同じ呼び出し内で判定基準が
  -- 変わらないようにする(この呼び出し自身がservice role経由でない
  -- 限り、v_effective_user_idは既にauth.uid()と同じ値であり、内側の
  -- functionでも同じ結果になる)。
  return public.tact_claim_matched_event_wait(v_event.id, v_wait_id, v_effective_user_id);

end;
$$;

-- 絶対条件(Section17「Do not loosen RLS broadly」・Section18):
-- 両functionともSECURITY INVOKER(既定)のまま——このmigrationはEXECUTE
-- 権限を新たに付与しない。RLS policy(20261016000000)は無変更。
-- p_trusted_user_idはcurrent_user = 'service_role'の接続からしか
-- 効果を持たない(auth.role()は使用していない——Supabaseの非推奨に
-- 従い、実際のPostgres接続roleそのものを見る)。
