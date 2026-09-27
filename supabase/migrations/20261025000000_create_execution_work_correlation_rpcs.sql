-- =====================================================================
-- Migration: Transactional Execution Work Correlation RPCs
-- (SOR-52 Final Consistency & Concurrency Hardening)
-- =====================================================================
--
-- 背景(Codex最終監査、High): これまでのcorrelation永続化は
-- 「history INSERT → Execution summary UPDATE」(またはその逆)という
-- 複数のapplication層クエリで構成されており、途中で失敗した場合に
-- history/summaryが食い違う可能性・複数の同時書き込みに対する
-- race conditionが残っていた。
--
-- このmigrationは、target Work validation・tenant ownership
-- validation・Work active-state validation・CAS/optimistic
-- concurrency・Execution summary更新・history追加を、Postgres関数
-- (単一のtop-level呼び出しとして自動的にatomicになる、絶対条件
-- 「単一transaction内」)としてDB側へ移す。application層
-- (core/tact-execution/correlation/store.ts)はこの結果を受け取る
-- だけになる。
--
-- 絶対条件(Preserve、Section0): Correlationアルゴリズム自体
-- (Execution → Context → Stages → Decision)は一切変更しない。この
-- migrationは「決定した後の永続化」だけをtransaction-safeにする。
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. decision_fingerprint(Part3、Ambiguous/Unresolved Idempotency)
-- ---------------------------------------------------------------------
--
-- 「同一観測・同一correlator version・同一候補集合・同一結論」を
-- 識別するidempotency key(core/tact-execution/correlation/
-- fingerprint.tsが計算する)。既存行には値が無い(nullable、後方
-- 互換)——「意味的に同一の再評価かどうか」を過去に遡って判定する
-- 必要は無いため、backfillは行わない。

alter table public.tact_execution_work_correlations
  add column if not exists decision_fingerprint text null
    check (decision_fingerprint is null or char_length(decision_fingerprint) between 1 and 128);

-- NULLは「重複可能」としてPostgresのUNIQUE indexから除外される
-- (=fingerprint未設定の行同士は意図的に重複チェックしない、既存の
-- coalesce方式とは異なり、fingerprint自体を必須にしない行
-- (将来の別methodの追加時等)を許容するための設計)。execution_id単位
-- でfingerprintの一意性を保証する(異なるExecution間で同じ
-- fingerprintが偶然一致しても問題にならない設計、fingerprint自体に
-- executionIdを含めているため実質的には発生しないが、indexとしても
-- 明示的にexecution_id単位で区切る)。
create unique index if not exists idx_tact_execution_work_correlations_fingerprint
  on public.tact_execution_work_correlations (execution_id, decision_fingerprint)
  where decision_fingerprint is not null;

-- ---------------------------------------------------------------------
-- 2. apply_execution_work_correlation(Auto Correlation、Part1/2)
-- ---------------------------------------------------------------------
--
-- 単一のtop-level関数呼び出しとして、以下すべてを1つのtransaction内で
-- 行う(Postgresの関数呼び出しは暗黙にatomic——関数内で例外が発生
-- すれば、その呼び出しが行った変更はすべてrollbackされる):
--   1. ExecutionのuserId所有権検証(行lock、for update)
--   2. (status=matchedの場合)target WorkのuserId所有権・
--      auto-correlatable状態検証(行lock、for update——チェックと
--      書き込みの間に他transactionがWorkのstatusを変更できない、
--      Part6のTOCTOU対策)
--   3. decision fingerprintによる重複検知(意味的に同一の再評価は
--      新しいhistoryを作らない、Part3)
--   4. CAS(現在のwork_idがNULLの場合のみ新規matchとして確定。
--      既に同じWorkへmatch済みならhistoryだけ追加、既に別のWorkへ
--      match済みならhistoryを一切作らずconflictを返す、絶対条件8)
--   5. Execution summary(work_id/correlation_status)更新
--   6. history(tact_execution_work_correlations)追加
--
-- 戻り値(jsonb、outcomeで判別する discriminated union相当):
--   correlated / already_same_work / conflict_existing_other_work /
--   execution_not_found / target_work_not_found /
--   target_work_not_correlatable / duplicate_decision / already_matched
--
-- SECURITY DEFINERの理由: tact_check_applied_migrations()と同じ既存
-- 方針(service role専用のtrusted RPC)。呼び出し元はcore/tact-execution/
-- correlation/store.ts(service role client経由)のみを想定する。

create or replace function public.apply_execution_work_correlation(
  p_execution_id uuid,
  p_user_id uuid,
  p_status text,
  p_method text,
  p_reason_code text,
  p_correlator_version text,
  p_decision_fingerprint text,
  p_target_work_id uuid default null,
  p_confidence real default null,
  p_candidate_work_ids uuid[] default null,
  p_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_execution public.tact_canonical_executions%rowtype;
  v_work public.tact_works%rowtype;
  v_history_id uuid;
  v_new_status text;
begin

  if p_status not in ('matched', 'ambiguous', 'unresolved') then
    raise exception 'apply_execution_work_correlation: invalid status %', p_status;
  end if;

  if p_status = 'matched' and p_target_work_id is null then
    raise exception 'apply_execution_work_correlation: target_work_id is required when status=matched';
  end if;

  if p_status <> 'matched' and p_target_work_id is not null then
    raise exception 'apply_execution_work_correlation: target_work_id must be null when status<>matched (Never Guess Rule)';
  end if;

  -- Step1(絶対条件: 他tenantへの存在有無を漏らさない、既存
  -- getConversation()等と同じ規約): 存在しない/所有者不一致のいずれも
  -- execution_not_foundとして統一する。行lockはこの関数呼び出しの
  -- transaction中、他の並行呼び出しがこのExecutionを同時に更新でき
  -- ないようにする(Part2/Part6のconcurrency対策)。
  select * into v_execution
  from public.tact_canonical_executions
  where id = p_execution_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'execution_not_found');
  end if;

  if p_status = 'matched' then

    -- Step2(Part1/Part6、TOCTOU対策): target Workの所有権・
    -- auto-correlatable状態を、このtransaction内で行lockを取った
    -- 状態で検証する——「検証時はactiveだったが書込み直前にterminal
    -- 化した」を防ぐ。
    select * into v_work
    from public.tact_works
    where id = p_target_work_id and user_id = p_user_id
    for update;

    if not found then
      return jsonb_build_object('outcome', 'target_work_not_found');
    end if;

    if v_work.status in ('completed', 'failed', 'cancelled') then
      return jsonb_build_object('outcome', 'target_work_not_correlatable');
    end if;

    -- Step3(Part3、fingerprint dedup): 「同じconflict」と「同じ
    -- 成功結論の再送」を区別するため、conflict判定より先にfingerprint
    -- 重複を見る——異なる結論(=異なるfingerprint)は次のstepで
    -- 正しくconflict判定される。
    if exists (
      select 1 from public.tact_execution_work_correlations
      where execution_id = p_execution_id
        and decision_fingerprint = p_decision_fingerprint
        and v_execution.work_id is null
    ) then
      return jsonb_build_object('outcome', 'duplicate_decision');
    end if;

    -- Step4(絶対条件8、最重要): 既に別Workへmatch済みの場合、
    -- matched historyを絶対に作らない。
    if v_execution.work_id is not null and v_execution.work_id <> p_target_work_id then
      return jsonb_build_object(
        'outcome', 'conflict_existing_other_work',
        'currentWorkId', v_execution.work_id
      );
    end if;

    -- Same-work retries are a distinct idempotent CAS result.  Check this
    -- before fingerprint deduplication so an exact retry is not misreported
    -- as duplicate_decision and never appends a second matched history row.
    if v_execution.work_id = p_target_work_id then
      return jsonb_build_object(
        'outcome', 'already_same_work',
        'workId', v_execution.work_id
      );
    end if;

    -- Step5: history追加(新規matchの場合と、既に同じWorkへmatch済み
    -- だが新しいfingerprint=新しい根拠での再確認、の両方をカバーする)。
    insert into public.tact_execution_work_correlations (
      execution_id, work_id, status, method, confidence, reason_code,
      correlator_version, candidate_work_ids, metadata, correlated_at,
      decision_fingerprint
    ) values (
      p_execution_id, p_target_work_id, 'matched', p_method, p_confidence, p_reason_code,
      p_correlator_version, p_candidate_work_ids, p_metadata, now(),
      p_decision_fingerprint
    )
    returning id into v_history_id;

    if v_execution.work_id is null then

      -- Step6: summary更新(初回CAS成功)。
      update public.tact_canonical_executions
      set work_id = p_target_work_id, correlation_status = 'matched'
      where id = p_execution_id;

      return jsonb_build_object(
        'outcome', 'correlated',
        'workId', p_target_work_id,
        'historyId', v_history_id
      );

    end if;

    -- 既に同じWorkへmatch済み(同一retry、summary変更不要)。
    return jsonb_build_object(
      'outcome', 'already_same_work',
      'workId', v_execution.work_id,
      'historyId', v_history_id
    );

  end if;

  -- ambiguous/unresolvedのpath。

  -- 絶対条件(確定済みmatchを弱い結果で上書きしない): 既にwork_idが
  -- 確定済みの場合、historyも追加しない(Part9「CAS conflict/stale
  -- revision/transaction failureは成功したCorrelation historyとして
  -- 記録しない」と同じ精神——ambiguous/unresolvedがmatchedより弱い
  -- 結論である以上、matched済みのExecutionへは無意味な履歴を残さない)。
  if v_execution.work_id is not null then
    return jsonb_build_object(
      'outcome', 'already_matched',
      'workId', v_execution.work_id
    );
  end if;

  if exists (
    select 1 from public.tact_execution_work_correlations
    where execution_id = p_execution_id and decision_fingerprint = p_decision_fingerprint
  ) then
    return jsonb_build_object('outcome', 'duplicate_decision');
  end if;

  insert into public.tact_execution_work_correlations (
    execution_id, work_id, status, method, confidence, reason_code,
    correlator_version, candidate_work_ids, metadata, correlated_at,
    decision_fingerprint
  ) values (
    p_execution_id, null, p_status, p_method, p_confidence, p_reason_code,
    p_correlator_version, p_candidate_work_ids, p_metadata, now(),
    p_decision_fingerprint
  )
  returning id into v_history_id;

  update public.tact_canonical_executions
  set correlation_status = p_status
  where id = p_execution_id;

  return jsonb_build_object(
    'outcome', 'updated',
    'correlationStatus', p_status,
    'historyId', v_history_id
  );

end;
$$;

revoke all on function public.apply_execution_work_correlation(
  uuid, uuid, text, text, text, text, text, uuid, real, uuid[], jsonb
) from public;

grant execute on function public.apply_execution_work_correlation(
  uuid, uuid, text, text, text, text, text, uuid, real, uuid[], jsonb
) to service_role;

-- ---------------------------------------------------------------------
-- 3. reclassify_execution_work(Manual Override、Part4/5)
-- ---------------------------------------------------------------------
--
-- CAS guard(work_id IS NULL)を持たない、Manual Override専用の
-- atomic RPC。Optimistic Concurrency Control: 呼び出し元は
-- 「自分が最後に見たwork_id」(p_expected_previous_work_id、未割当を
-- 期待する場合はNULL)を渡す。この関数内で現在のwork_idと比較し、
-- 一致しなければstale_revisionとして拒否する——2人が同時に別々の
-- 前提でmanual overrideしても、両方成功扱いにはならない(絶対条件、
-- Part4「二人が同時にmanual overrideしても、両方成功扱いにならない
-- こと」)。

create or replace function public.reclassify_execution_work(
  p_execution_id uuid,
  p_user_id uuid,
  p_expected_previous_work_id uuid,
  p_new_work_id uuid,
  p_changed_by_actor_kind text,
  p_changed_by_actor_id text,
  p_reason_code text,
  p_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_execution public.tact_canonical_executions%rowtype;
  v_work public.tact_works%rowtype;
  v_history_id uuid;
  v_new_status text;
begin

  select * into v_execution
  from public.tact_canonical_executions
  where id = p_execution_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'execution_not_found');
  end if;

  -- Optimistic Concurrency(絶対条件、Part4、最重要): 呼び出し元が
  -- 前提とした「変更前のwork_id」と、行lock後に読んだ実際のwork_idが
  -- 一致しない場合、書き込みを拒否する(IS DISTINCT FROMはNULL同士も
  -- 正しく「等しい」と判定する)。
  if v_execution.work_id is distinct from p_expected_previous_work_id then
    return jsonb_build_object(
      'outcome', 'stale_revision',
      'actualWorkId', v_execution.work_id
    );
  end if;

  if p_new_work_id is not null then

    select * into v_work
    from public.tact_works
    where id = p_new_work_id and user_id = p_user_id
    for update;

    if not found then
      return jsonb_build_object('outcome', 'target_work_not_found');
    end if;

    if v_work.status in ('completed', 'failed', 'cancelled') then
      return jsonb_build_object('outcome', 'target_work_not_correlatable');
    end if;

    v_new_status := 'matched';

  else

    -- newWorkId=null(絶対条件、Part3「Workを外す操作」)。
    v_new_status := 'unresolved';

  end if;

  -- history INSERT失敗時にsummaryだけ変更済みになる状態を禁止する
  -- (絶対条件、Part5)——historyを先にINSERTし、この関数自体の
  -- transaction(単一top-level呼び出し)がatomicであることにより、
  -- 以降のUPDATEが失敗すればこのINSERTごと自動的にrollbackされる。
  insert into public.tact_execution_work_correlations (
    execution_id, work_id, status, method, confidence, reason_code,
    correlator_version, candidate_work_ids, metadata, correlated_at,
    previous_work_id, changed_by_actor_kind, changed_by_actor_id
  ) values (
    p_execution_id, p_new_work_id, v_new_status, 'manual_override', null, p_reason_code,
    'manual-override-v1', null, p_metadata, now(),
    p_expected_previous_work_id, p_changed_by_actor_kind, p_changed_by_actor_id
  )
  returning id into v_history_id;

  update public.tact_canonical_executions
  set work_id = p_new_work_id, correlation_status = v_new_status
  where id = p_execution_id;

  return jsonb_build_object(
    'outcome', 'reclassified',
    'workId', p_new_work_id,
    'correlationStatus', v_new_status,
    'previousWorkId', p_expected_previous_work_id,
    'historyId', v_history_id
  );

end;
$$;

revoke all on function public.reclassify_execution_work(
  uuid, uuid, uuid, uuid, text, text, text, jsonb
) from public;

grant execute on function public.reclassify_execution_work(
  uuid, uuid, uuid, uuid, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------
-- 4. Write-time guard for every Execution.work_id writer
-- ---------------------------------------------------------------------
-- captureExecution(workId) is an explicit trusted-input path and retains
-- its capture-first shape.  It must nevertheless not be able to create a
-- cross-user or terminal Work association in the small interval after its
-- application-level preflight.  The correlation RPCs already lock/validate
-- Work themselves; this trigger closes the remaining direct INSERT/UPDATE
-- path at the database boundary.
create or replace function public.enforce_tact_execution_work_assignment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_work_status text;
begin
  if new.work_id is null then
    return new;
  end if;

  -- FOR SHARE prevents a concurrent Work status update from passing this
  -- validation until the Execution assignment commits.
  select status into v_work_status
  from public.tact_works
  where id = new.work_id and user_id = new.user_id
  for share;

  if not found then
    raise exception 'execution work assignment target not found'
      using errcode = '23503';
  end if;

  if v_work_status in ('completed', 'failed', 'cancelled') then
    raise exception 'execution work assignment target is not correlatable'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_tact_execution_work_assignment
  on public.tact_canonical_executions;

create trigger trg_enforce_tact_execution_work_assignment
before insert or update of work_id, user_id on public.tact_canonical_executions
for each row
execute function public.enforce_tact_execution_work_assignment();

revoke all on function public.enforce_tact_execution_work_assignment() from public;
