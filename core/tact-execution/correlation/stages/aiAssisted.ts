// =========================
// TACT Canonical Execution — AI-assisted Correlator (SOR-52)
// =========================
//
// Correlation Methods優先順位4(最終段階)。deterministic/structuralで
// 一意に決まらない場合のみ使用する。
//
// 絶対条件(SOR-52 Closeout Hardening Part5、最重要): 時間的近接
// (recency)はcandidate ranking/絞り込みのsignalとしては使えるが、
// **recencyだけでWork identityを確定してはならない**。この段階が
// 実際に確認できるreal semantic evidence(LLM/embedding等)を一切
// 持たない現時点では、matchedを一切返さない——0候補はunresolvedへ、
// 1件以上の候補は(1件であっても)ambiguousへ倒す。「1件だから確定」
// という扱いはしない(1件の弱い証拠を、複数候補と同じ「まだ判断
// できない」状態として扱う)。
//
// 将来、実際にsemantic evidence(LLM/embedding等)を用いた再ranking
// 機構を導入する際に、このstageのmatched判定を再設計する
// (SOR-52指示「将来LLM/semantic correlator導入時に再度threshold
// を設計する」)——このfileの入出力契約(candidates + Execution →
// WorkCorrelationDecision | null)は変えずに内部実装だけを差し替え
// られる形を維持する。

import type { Work } from "../../../tact-work/types";
import type { CanonicalExecution } from "../../types";
import type { WorkCorrelationDecision } from "../types";
import { CORRELATOR_VERSION } from "../version";
// SOR-76: this constant moved to confidencePolicy.ts (one documented place
// for every stage's confidence value); the value and this stage's decision
// logic are unchanged.
import { AI_ASSISTED_AMBIGUOUS_CONFIDENCE as MULTIPLE_CANDIDATES_CONFIDENCE } from "../confidencePolicy";

// candidatesはstages/temporalParticipant.tsが既に「活動中のWorkのみ」
// へ絞り込んだ後の集合(絶対条件: このstage単体では候補を広げない)。
export function runAiAssistedCorrelation(
  candidates: readonly Work[],
  execution: CanonicalExecution
): WorkCorrelationDecision | null {

  if (candidates.length === 0) {
    // 候補が無い = このstageでも決められない(次に回す先が無いため
    // 呼び出し元がunresolvedへ倒す)。
    return null;
  }

  const correlatedAt = new Date().toISOString();

  if (candidates.length > 1) {

    return {
      executionId: execution.id,
      status: "ambiguous",
      workId: null,
      method: "ai_assisted",
      confidence: MULTIPLE_CANDIDATES_CONFIDENCE,
      reasonCode: "ai_assisted_multiple_recent_active_candidates",
      correlatorVersion: CORRELATOR_VERSION,
      candidateWorkIds: candidates.map((c) => c.id),
      correlatedAt,
    };

  }

  // 絶対条件(Part5、最重要): 候補が1件であっても、real semantic
  // evidenceを持たないこのstageはmatchedを返さない——呼び出し元の
  // 最終fallback(unresolved)へ委ねる(推測でWork identityを確定
  // しない、Never Guess Ruleの延長)。
  return null;

}
