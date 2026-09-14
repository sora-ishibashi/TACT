// =========================
// TACT Work — Temporal State Foundation (TIME-P1a)
// =========================
//
// PRODUCT MODEL(このphaseの明示的な設計): TACTはWork Orchestratorとして
// 「今すぐ実行する」だけでなく「待って、後で再開する」を第一級の状態と
// して表現できなければならない。このfileは、そのための3つの独立した
// 時間概念だけを、決定論的なpure functionとして提供する——スケジューラ・
// タイマー・cronは一切実装しない(絶対条件Section21、次のTIME-P1bへ
// 委譲する)。
//
// Repository Reality Audit(実装前に実施)で判明した事実:
//   - Work/WorkTaskには「いつ何が起きたか」を表す過去形のtimestamp
//     (createdAt/updatedAt/startedAt/completedAt/failedAt/cancelledAt)
//     しか存在せず、「いつ再開してよいか/いつまでにやるべきか」という
//     未来を指すtimestampは一切存在しなかった。
//   - core/tact-work/types.tsのApproval/Clarificationには既に
//     expiresAt(nullable timestamptz)という「この時刻を過ぎたら
//     無効」という未来向きgate概念が存在する(REF-P1d、Fast Port P3a)。
//     core/tact-referent/clarification.tsのcomputeReferentClarification
//     ExpiresAt()/その判定(`now.getTime() >= new Date(expiresAt).
//     getTime()`)が、このfileのisWaitUntilSatisfied()/
//     isRetryTimeSatisfied()と同じ「注入されたnow、境界はnow>=X」という
//     既存パターンの直接の前例である——このfileは新しい語彙を発明せず、
//     この既存パターンをWork/Task向けに再利用するだけ。
//
// 絶対条件(Section19、最重要): 時間は一切authorizationにならない。
// isWaitUntilSatisfied()/isRetryTimeSatisfied()がtrueを返しても、それは
// 「時間的なgateを通過した」という事実だけであり、Approval/Policy/
// Integrity/Capability selectionのいずれも代替・省略しない
// (selection != Approval, Capability != Approval と全く同じ精神で、
// Temporal eligibility != Approval)。
//
// 絶対条件(Section18、決定論性): 内部でnew Date()やDate.now()を直接
// 呼ばない。呼び出し元が現在時刻を明示的に渡す(引数now: Date)——
// テストが常に決定論的になる(既存のcomputeReferentClarificationExpiresAt()
// と同じ設計)。
//
// 絶対条件(Section11、malformed timestamp): 不正な形式のtimestamp
// 文字列(Date.parseできない値)は、"満たされていない"側の安全な結果へ
// fail safeする(推測で「時間が来た」とはみなさない)。deadlineの
// 「超過」も同様に、不正な値は「超過していない」という安全側にfail
// safeする。

function parseTimestamp(value: string | null | undefined): number | undefined {

  if (!value) {
    return undefined;
  }

  const parsed = new Date(value).getTime();

  return Number.isNaN(parsed) ? undefined : parsed;

}

// =========================
// isDeadlineExceeded (Work.deadline)
// =========================
//
// 絶対条件(Section6、最重要): これはスケジューラのtrigger条件ではない。
// 「このWork/Taskは、この時刻までに完了することが期待されている」と
// いう事実を読み取るだけの、副作用の無い判定。trueを返しても、
// Workを自動的にfailed/completedへ進める処理はこのfileにもどこにも
// 存在しない(絶対条件: 既存product semanticsが明示的に要求しない限り、
// overdue failure policyを発明しない)。
export function isDeadlineExceeded(
  now: Date,
  deadline: string | null | undefined
): boolean {

  const deadlineMs = parseTimestamp(deadline);

  if (deadlineMs === undefined) {
    // deadline未設定、または不正な値 -> "超過"を主張しない(fail safe)。
    return false;
  }

  return now.getTime() >= deadlineMs;

}

// =========================
// isWaitUntilSatisfied (WorkTask.waitUntil)
// =========================
//
// 絶対条件(Section7): 「この時刻より前には再開しない」というgating
// conditionであり、「この時刻ちょうどに自動実行する」という意味では
// ない。waitUntil未設定は「gateなし」= 常に満たされている
// (fail safeの方向がisDeadlineExceeded()とは逆であることに注意:
// 「gateが無い」ことは「進んでよい」ことを意味するため、既定値は
// true)。不正な値も同様にtrue(gateとして機能しない不正な値で
// 永久に足止めしない、Section11の「waitUntil in the past is allowed
// if it simply means gate already open」と同じ安全側の精神)。
export function isWaitUntilSatisfied(
  now: Date,
  waitUntil: string | null | undefined
): boolean {

  const waitUntilMs = parseTimestamp(waitUntil);

  if (waitUntilMs === undefined) {
    return true;
  }

  return now.getTime() >= waitUntilMs;

}

// =========================
// isRetryTimeSatisfied (WorkTask.nextRetryAt)
// =========================
//
// 絶対条件(Section8/12、最重要): trueを返しても、それ自体は
// 「retryを実行してよい」という許可ではない——「retryのための時間的な
// gateは満たされている」という一情報にすぎない。実際にretryが
// eligibleかどうかは、core/tact-work/taskRunReconciliation.tsの
// evaluateTaskRetryEligibility()が、この関数の結果を他の全条件
// (Task状態・active Run有無・直近failureのretryability)と組み合わせて
// 判断する。
//
// 絶対条件(Section12「If nextRetryAt is null: 明示的なproduct-safe
// defaultに従う。Preferred: retry may be manually triggered if other
// conditions pass.」): nextRetryAt未設定は「時間による制約なし」=
// 常に満たされている(手動trigger等、他の条件さえ揃えばretryしてよい)。
export function isRetryTimeSatisfied(
  now: Date,
  nextRetryAt: string | null | undefined
): boolean {

  const nextRetryAtMs = parseTimestamp(nextRetryAt);

  if (nextRetryAtMs === undefined) {
    return true;
  }

  return now.getTime() >= nextRetryAtMs;

}
