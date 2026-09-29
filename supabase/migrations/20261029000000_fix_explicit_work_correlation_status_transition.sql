-- =====================================================================
-- Migration: Fix explicit-workId correlation_status transition
-- (SOR-53 hardening, discovered during SOR-55 real Staging fixture/
-- browser verification — Defect 2)
-- =====================================================================
--
-- 背景: 20261025000000migrationのpublic.apply_execution_work_correlation()
-- は、matched pathの冒頭近くで次の早期returnを持っていた:
--
--   if v_execution.work_id = p_target_work_id then
--     return jsonb_build_object('outcome', 'already_same_work', 'workId', v_execution.work_id);
--   end if;
--
-- これは「work_idが既にtargetと一致している = このRPCが過去に成功
-- させたretry」という前提で書かれていたが、その前提は誤りだった。
-- core/tact-execution/store.ts の captureExecution()(SOR-53 Path A、
-- explicit workId)は、このRPCを一切呼ばずに work_id 列を直接
-- INSERT時に設定する(該当箇所の既存コメント「correlation_status
-- 自体はここでは設定しない(DB default 'pending'のまま)——
-- work_id有りでcorrelation_status='pending'のExecutionは、
-- explicit.tsが検出し、通常のobserveExecutionWorkCorrelation()経路で
-- history行(method='explicit')が作られたうえでcorrelation_status=
-- 'matched'へ遷移する」参照)。
--
-- したがって、Path Aで観測されたExecutionに対してこの関数が最初に
-- 呼ばれた時点で、v_execution.work_id は既に p_target_work_id と
-- 一致している(が correlation_status は 'pending' のまま、history行も
-- まだ0件)。旧実装はこの状態を「過去に成功済みのretry」と誤認して
-- 即returnし、history追加もcorrelation_status更新も一切行わなかった
-- ——結果、work_id列は正しいのに correlation_status は永久に
-- 'pending'のままとなり、core/tact-runs-view / API/UIでは
-- CORRELATED(W-001等)ではなく UNASSIGNED として表示されてしまう
-- (SOR-55 real Staging fixture投入で実際に再現・確認済み)。
--
-- 修正方針(絶対条件、Human Owner指示を厳守):
--   - business logic / transaction / concurrency semantics自体は
--     変更しない。「同じwork_idへの真の冪等retry」を
--     v_execution.correlation_status = 'matched' で判定するよう
--     早期returnの条件を1つ絞り込むだけ(work_id一致 かつ
--     correlation_status='matched' の場合のみ早期return)。
--   - correlation_statusがまだ'matched'でない(=このRPCによる確定を
--     一度も経ていない)場合は、work_idがNULLから初めて確定する
--     ケースと全く同じ経路(history追加 + summary更新)へ合流させる。
--     旧実装でwork_id非NULL側にあった「既に同じWorkへmatch済み
--     (同一retry、summary変更不要)」という末尾の分岐は、現在の
--     コード上到達不能な死コードだった(conflict判定と
--     early-returnの組み合わせにより、その分岐へ到達する経路が
--     既に存在しないため)——削除して単一のupdate文へ統合する。
--   - Never Guess Rule: work_id自体は変更しない(既に
--     captureExecution()のresolveTargetWorkForCorrelation()が
--     検証済みの値をそのまま確定させるだけで、新たな推測は一切
--     加えない)。
--   - Manual Override(reclassify_execution_work、別RPC・本migration
--     では変更しない)との整合性: manual overrideは割り当て時に
--     必ずcorrelation_status='matched'まで設定するため、manual
--     override後にこのRPCが呼ばれても early-returnの新条件
--     (correlation_status='matched')に該当し、以前と同じく
--     即returnする(manual override結果を上書きしない)。
--   - Concurrency: 冒頭の`select ... for update`による行lockは
--     変更していないため、複数呼び出しの直列化・同時実行時の
--     duplicate history防止は従来どおり機能する。
--   - reclassify_execution_work()・
--     enforce_tact_execution_work_assignment()trigger関数は本
--     migrationでは一切変更しない(defect2はapply_execution_work_
--     correlation()のみに閉じた問題であるため)。
--
-- 既にStaging適用済みの20261025000000migration自体は編集しない
-- (forward-onlyで、この関数をCREATE OR REPLACEするだけ)。
-- CREATE OR REPLACE FUNCTIONは、引数シグネチャが変わらない限り
-- 既存のGRANT/REVOKE(20261028000000migrationでservice_role限定に
-- 絞ったACL)を保持する(Postgresの標準動作)ため、ACL関連migrationの
-- 再実行は不要。
--
-- =====================================================================

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

  select * into v_execution
  from public.tact_canonical_executions
  where id = p_execution_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'execution_not_found');
  end if;

  if p_status = 'matched' then

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

    if exists (
      select 1 from public.tact_execution_work_correlations
      where execution_id = p_execution_id
        and decision_fingerprint = p_decision_fingerprint
        and v_execution.work_id is null
    ) then
      return jsonb_build_object('outcome', 'duplicate_decision');
    end if;

    if v_execution.work_id is not null and v_execution.work_id <> p_target_work_id then
      return jsonb_build_object(
        'outcome', 'conflict_existing_other_work',
        'currentWorkId', v_execution.work_id
      );
    end if;

    -- SOR-53 hardening (Defect 2, fixed here): only a *confirmed*
    -- same-work match (correlation_status already 'matched') is a true
    -- idempotent retry. work_id already equal to the target but
    -- correlation_status not yet 'matched' means this row reached this
    -- state via captureExecution()'s Path A and has never actually been
    -- confirmed by this RPC — fall through to the normal insert+update
    -- path below instead of short-circuiting.
    if v_execution.work_id = p_target_work_id and v_execution.correlation_status = 'matched' then
      return jsonb_build_object(
        'outcome', 'already_same_work',
        'workId', v_execution.work_id
      );
    end if;

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

    -- Covers both: work_id transitioning from NULL for the first time,
    -- and work_id already equal to p_target_work_id but correlation_status
    -- not yet 'matched' (Defect 2 case, captureExecution() Path A).
    update public.tact_canonical_executions
    set work_id = p_target_work_id, correlation_status = 'matched'
    where id = p_execution_id;

    return jsonb_build_object(
      'outcome', 'correlated',
      'workId', p_target_work_id,
      'historyId', v_history_id
    );

  end if;

  -- ambiguous/unresolved path (unchanged).

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
