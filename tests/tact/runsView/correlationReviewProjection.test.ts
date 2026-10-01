// =========================
// TACT Runs UI — SOR-77 Correlation Review Projection
// =========================
//
// 対象: core/tact-runs-view/index.tsのtoCorrelationReviewView()。
// DBアクセス無し、純粋な変換のみ(SOR-54指示「No business logic in
// React」の延長——ここも判定は一切せず、既存のExecutionCorrelationView/
// ExecutionCorrectionContext(いずれもSOR-52/77の既存read function)を
// 人間向けのview形へ変換するだけ)。
//
// SOR-77 live Staging verification defect(hotfix): 候補workIdは
// correlation historyに永続化された「その時点の事実」であり、「今も
// assign可能」の保証ではない。実Stagingで、Work行が後から削除された
// (fixture drift、runsSeed.tsのclean modeの既知の問題)候補2件が
// Confirmボタン付きで表示され、押すとtarget_work_not_foundで失敗する
// defectを発見した——この根本原因はfixtureのdriftそのものではなく、
// 読み取り側がcandidateの現在のtenant/state(actionability)を一切
// 再検証していなかったこと。workActionability(呼び出し元がresolveTarget
// WorkForCorrelation()で再検証した結果)を必須引数として追加した。

import { toCorrelationReviewView, CORRELATION_REVIEW_VIEW_KEYS, SUGGESTED_WORK_CANDIDATE_VIEW_KEYS, type WorkActionabilityEntry } from "@tact/runs-core/tact-runs-view";
import type { ExecutionCorrelationView, ExecutionCorrectionContext } from "@tact/runs-core/tact-execution/correlation/store";
import { check, summarize, type CheckResult } from "../lib/check";

function correlation(overrides: Partial<ExecutionCorrelationView> = {}): ExecutionCorrelationView {
  return {
    executionId: "exec-1",
    workId: null,
    correlationStatus: "AMBIGUOUS",
    confidence: 0.5,
    reasonCode: "multiple_works_share_structural_context",
    method: "structural",
    candidateCount: 2,
    candidateWorkIds: ["work-a", "work-b"],
    assignedAt: null,
    decidedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

function context(overrides: Partial<ExecutionCorrectionContext> = {}): ExecutionCorrectionContext {
  return {
    executionId: "exec-1",
    currentWorkId: null,
    currentStatus: "AMBIGUOUS",
    predicted: null,
    correction: null,
    history: [],
    ...overrides,
  };
}

const ALL_ACTIONABLE = (ids: readonly string[]): Map<string, WorkActionabilityEntry> =>
  new Map(ids.map((id) => [id, { actionable: true, unavailableReason: null }] as const));

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Not yet corrected: candidates/confidence/reason come from the
  // correlation view itself, with titles joined tenant-safely ----
  {
    const view = toCorrelationReviewView(
      correlation(),
      context(),
      new Map([["work-a", "Renew TACT テスト商事 contract"], ["work-b", null]]),
      ALL_ACTIONABLE(["work-a", "work-b"])
    );

    results.push(check(
      "[Not corrected] candidates carry the correlation view's own candidateWorkIds with joined titles",
      view.candidates.length === 2 &&
        view.candidates[0].workId === "work-a" && view.candidates[0].title === "Renew TACT テスト商事 contract" &&
        view.candidates[1].workId === "work-b" && view.candidates[1].title === null
    ));

    results.push(check(
      "[Not corrected] confidence/reasonCode/methodLabel reflect the current (only) decision; isHumanCorrected is false",
      view.confidence === 0.5 && view.reasonCode === "multiple_works_share_structural_context" &&
        view.methodLabel === "Structural match" && view.isHumanCorrected === false && view.correction === null
    ));
  }

  // ---- Corrected: manual_override carries no candidateWorkIds/confidence
  // of its own (RPC design) — the view must fall back to context.predicted
  // so the prior evidence is never silently lost from the review surface ----
  {
    const correctedCorrelation = correlation({
      workId: "work-a",
      correlationStatus: "CORRELATED",
      confidence: null,
      reasonCode: "human_confirmed_candidate",
      method: "manual_override",
      candidateCount: null,
      candidateWorkIds: null,
      assignedAt: "2026-09-20T12:10:00.000Z",
    });
    const correctedContext = context({
      currentWorkId: "work-a",
      currentStatus: "CORRELATED",
      predicted: {
        workId: null,
        candidateWorkIds: ["work-a", "work-b"],
        confidence: 0.5,
        method: "structural",
        reasonCode: "multiple_works_share_structural_context",
        correlatedAt: "2026-09-20T12:00:00.000Z",
      },
      correction: {
        finalWorkId: "work-a",
        previousWorkId: null,
        reasonCode: "human_confirmed_candidate",
        changedByActorKind: "human",
        changedByActorId: "user-1",
        correlatedAt: "2026-09-20T12:10:00.000Z",
      },
      history: [
        {
          executionId: "exec-1", status: "matched", workId: "work-a", method: "manual_override",
          confidence: null, reasonCode: "human_confirmed_candidate", correlatorVersion: "manual-override-v1",
          candidateWorkIds: null, correlatedAt: "2026-09-20T12:10:00.000Z",
          previousWorkId: null, changedByActorKind: "human", changedByActorId: "user-1",
        },
        {
          executionId: "exec-1", status: "ambiguous", workId: null, method: "structural",
          confidence: 0.5, reasonCode: "multiple_works_share_structural_context", correlatorVersion: "work-correlator-v1",
          candidateWorkIds: ["work-a", "work-b"], correlatedAt: "2026-09-20T12:00:00.000Z",
        },
      ],
    });

    const view = toCorrelationReviewView(
      correctedCorrelation,
      correctedContext,
      new Map([["work-a", "Renew TACT テスト商事 contract"], ["work-b", null]]),
      ALL_ACTIONABLE(["work-a", "work-b"])
    );

    results.push(check(
      "[SOR-77 reopen] currentWorkTitle is joined for the currently-assigned Work, and the full history trail is projected newest-first",
      view.currentWorkTitle === "Renew TACT テスト商事 contract" &&
        view.history.length === 2 &&
        view.history[0].methodLabel === "Manual correction" && view.history[0].canonicalStatus === "CORRELATED" &&
        view.history[0].changedByActorId === "user-1" &&
        view.history[1].methodLabel === "Structural match" && view.history[1].canonicalStatus === "AMBIGUOUS"
    ));

    results.push(check(
      "[Corrected/Never-lose-evidence] candidates/confidence/methodLabel come from the PRE-correction prediction, not the (empty) manual_override fields",
      view.candidates.length === 2 &&
        view.confidence === 0.5 && view.methodLabel === "Structural match" &&
        view.reasonCode === "multiple_works_share_structural_context"
    ));

    results.push(check(
      "[Corrected] currentWorkId/currentStatus reflect the actual current assignment, and correction exposes actor/reason/timestamp",
      view.currentWorkId === "work-a" && view.currentStatus === "CORRELATED" &&
        view.isHumanCorrected === true &&
        view.correction?.reasonCode === "human_confirmed_candidate" &&
        view.correction?.changedByActorId === "user-1"
    ));
  }

  // ---- Keep Unassigned: a first-class human decision, distinguishable from
  // "never evaluated" ----
  {
    const view = toCorrelationReviewView(
      correlation({ workId: null, correlationStatus: "UNASSIGNED", confidence: null, reasonCode: "human_kept_unassigned", method: "manual_override", candidateCount: null, candidateWorkIds: null }),
      context({
        currentWorkId: null,
        currentStatus: "UNASSIGNED",
        predicted: { workId: null, candidateWorkIds: ["work-a", "work-b"], confidence: 0.5, method: "structural", reasonCode: "multiple_works_share_structural_context", correlatedAt: "2026-09-20T12:00:00.000Z" },
        correction: { finalWorkId: null, previousWorkId: null, reasonCode: "human_kept_unassigned", changedByActorKind: "human", changedByActorId: "user-1", correlatedAt: "2026-09-20T12:10:00.000Z" },
      }),
      new Map(),
      ALL_ACTIONABLE(["work-a", "work-b"])
    );

    results.push(check(
      "[Keep Unassigned] isHumanCorrected is true even though currentWorkId is null — distinguishes an explicit human decision from an unevaluated Execution",
      view.currentWorkId === null && view.isHumanCorrected === true && view.correction?.reasonCode === "human_kept_unassigned"
    ));
  }

  // ---- SOR-77 hotfix regression: a candidate whose Work row no longer
  // exists (stale historical reference — the exact live Staging defect)
  // must never be reported as actionable, even though it is still
  // preserved, by id, in the historical candidates list ----
  {
    const view = toCorrelationReviewView(
      correlation({ candidateWorkIds: ["work-live", "work-deleted"] }),
      context(),
      new Map([["work-live", "Still exists"]]),
      new Map([
        ["work-live", { actionable: true, unavailableReason: null }],
        ["work-deleted", { actionable: false, unavailableReason: "not_found" }],
      ])
    );

    results.push(check(
      "[SOR-77 hotfix] a stale/deleted candidate is preserved in the list (audit trail intact) but marked not actionable",
      view.candidates.length === 2 &&
        view.candidates[0].actionable === true && view.candidates[0].unavailableReason === null &&
        view.candidates[1].actionable === false && view.candidates[1].unavailableReason === "not_found"
    ));
  }

  // ---- SOR-77 hotfix regression: a candidate whose Work has since reached
  // a terminal status gets a distinct, non-leaking reason from "not found" ----
  {
    const view = toCorrelationReviewView(
      correlation({ candidateWorkIds: ["work-terminal"] }),
      context(),
      new Map([["work-terminal", "Finished project"]]),
      new Map([["work-terminal", { actionable: false, unavailableReason: "not_correlatable" }]])
    );

    results.push(check(
      "[SOR-77 hotfix] a candidate Work that reached a terminal status is not actionable and reports 'not_correlatable', not 'not_found'",
      view.candidates[0].actionable === false && view.candidates[0].unavailableReason === "not_correlatable"
    ));
  }

  // ---- SOR-77 hotfix regression: Never Guess Rule — a candidate missing
  // from the actionability map entirely (caller forgot to check it) must
  // fail closed as not actionable, never default to actionable ----
  {
    const view = toCorrelationReviewView(
      correlation({ candidateWorkIds: ["work-unchecked"] }),
      context(),
      new Map(),
      new Map() // deliberately empty — caller never resolved this id
    );

    results.push(check(
      "[SOR-77 hotfix/fail-closed] a candidate absent from the actionability map is never assumed actionable",
      view.candidates[0].actionable === false && view.candidates[0].unavailableReason === "not_found"
    ));
  }

  // ---- Privacy/allow-list: the view (and each candidate) never exposes
  // any key beyond the documented allow-list (no raw payload/token ever
  // flows through this boundary) ----
  {
    const view = toCorrelationReviewView(correlation(), context(), new Map(), ALL_ACTIONABLE(["work-a", "work-b"]));
    results.push(check(
      "[Privacy] CorrelationReviewView keys match the documented allow-list exactly",
      Object.keys(view).every((key) => (CORRELATION_REVIEW_VIEW_KEYS as readonly string[]).includes(key)) &&
        CORRELATION_REVIEW_VIEW_KEYS.every((key) => key in view)
    ));
    results.push(check(
      "[Privacy] each SuggestedWorkCandidateView's keys match its documented allow-list exactly",
      view.candidates.every((candidate) =>
        Object.keys(candidate).every((key) => (SUGGESTED_WORK_CANDIDATE_VIEW_KEYS as readonly string[]).includes(key)) &&
        SUGGESTED_WORK_CANDIDATE_VIEW_KEYS.every((key) => key in candidate)
      )
    ));
  }

  return summarize("TACT Runs UI — SOR-77 Correlation Review Projection", results);

}
