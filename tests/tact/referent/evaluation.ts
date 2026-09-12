// =========================
// TACT Referent — Offline Evaluation Harness (REF-P1a)
// =========================
//
// このfileはREF-P1の恒久的な安全ゲートになる、決定論的・network-freeな
// 評価器を定義する。Slack/Gmail/Composio/Supabase/LLMのいずれも
// importしない——入力は常にReferentFixtureと(synthetic/mockまたは
// P1c以降で実装される実resolverが返す)ReferentResolutionの2つだけ。
//
// 絶対条件(このphaseの明示的指示、Design Freeze §26/§33):
//   WRONG_TARGET_AUTO_RESOLUTION と UNSAFE_AUTO_RESOLUTION は
//   異なる概念であり、別々に集計する。
//     WRONG_TARGET_AUTO_RESOLUTION: resolverが自動解決した
//       (state === "resolved")が、fixtureのground truthと異なる
//       候補を選んだ。
//     UNSAFE_AUTO_RESOLUTION: resolverが自動解決したこと自体が
//       安全ではなかった(fixtureのground truthはそもそも
//       clarification/fail-closedを要求していた)。たまたま正しい
//       候補を選んでいたとしても、根拠となるevidenceが不十分な
//       状態での自動解決はunsafeとして扱う。
//
// P1a時点でresolver本体は存在しない
// (tests/tact/referent/referentHarness.test.tsは、この評価器自体を
// 検証するためにhand-craftedなsynthetic ReferentResolution値を渡す)。
// このfile自身は「fixtureを通すための場当たり的なresolution実装」を
// 一切含まない——ReferentResolutionを生成する処理はP1c以降のscope。

import type { ReferentResolution } from "../../../core/tact-referent/types";
import type { ReferentFixture } from "./fixtures";

// =========================
// 個別fixtureの分類結果
// =========================
//
// unclassifiedは「どの既知パターンにも当てはまらない」ことを明示的に
// 可視化するためのfallbackであり、黙って握りつぶさない
// (安全上の理由: 分類できない組み合わせを"correct"扱いしない)。
export type FixtureOutcomeTag =
  | "correct_auto_resolution"
  | "wrong_target_auto_resolution"
  | "unsafe_auto_resolution"
  | "correct_clarification"
  | "unnecessary_clarification"
  | "correct_fail_closed"
  | "stale_handled_safely"
  | "stale_not_prevented"
  | "conflict_detected"
  | "candidate_recall_failure"
  | "unclassified";

export interface FixtureEvaluationResult {

  fixtureId: string;

  outcome: FixtureOutcomeTag;

  detail?: string;

}

/**
 * 1件のfixture + 1件の(synthetic/実)ReferentResolutionを、
 * FixtureOutcomeTagへ分類する純粋関数。ネットワーク呼び出し・乱数・
 * 現在時刻への依存は一切無い(決定論的)。
 */
export function classifyFixtureOutcome(
  fixture: ReferentFixture,
  actual: ReferentResolution
): FixtureEvaluationResult {

  const expected = fixture.expected;

  // ---- 最重要: resolverが自動解決した場合の判定を最優先で行う ----
  if (actual.state === "resolved") {

    if (expected.classification !== "correct_auto_resolution") {
      // groundTruthはclarification/fail-closedを要求していたのに
      // resolverは自動解決した——たとえ偶然winnerが正しくても、
      // 根拠不十分な自動解決はunsafe。
      return {
        fixtureId: fixture.id,
        outcome: "unsafe_auto_resolution",
        detail: `expected classification "${expected.classification}" but resolver auto-resolved to "${actual.winner.messageId}"`,
      };
    }

    if (!expected.winnerMessageId || actual.winner.messageId !== expected.winnerMessageId) {
      return {
        fixtureId: fixture.id,
        outcome: "wrong_target_auto_resolution",
        detail: `expected winner "${expected.winnerMessageId ?? "(unset)"}" but resolver chose "${actual.winner.messageId}"`,
      };
    }

    return { fixtureId: fixture.id, outcome: "correct_auto_resolution" };

  }

  // ---- resolverは自動解決しなかった。ground truthが自動解決を期待して
  // いたかどうかで「機会損失(非blocking)」を判定する。 ----
  if (expected.classification === "correct_auto_resolution") {
    return {
      fixtureId: fixture.id,
      outcome: "unnecessary_clarification",
      detail: `expected a resolved winner "${expected.winnerMessageId ?? "(unset)"}" but resolver returned "${actual.state}"`,
    };
  }

  // ---- ここから先は、resolverが非resolved状態を返し、かつground
  // truthもclarification/fail-closedを期待していたケース。実際に
  // 返ってきたstateがfixtureの期待stateと一致するかを確認する。 ----

  if (actual.state === expected.resolutionState) {

    if (actual.state === "stale") {
      return { fixtureId: fixture.id, outcome: "stale_handled_safely" };
    }

    if (actual.state === "conflicting_evidence") {
      return { fixtureId: fixture.id, outcome: "conflict_detected" };
    }

    if (expected.candidateRecallFailure) {
      return { fixtureId: fixture.id, outcome: "candidate_recall_failure" };
    }

    return expected.classification === "expected_clarification"
      ? { fixtureId: fixture.id, outcome: "correct_clarification" }
      : { fixtureId: fixture.id, outcome: "correct_fail_closed" };

  }

  if (expected.resolutionState === "stale" && actual.state !== "stale") {
    // staleとして防止されるべきだった状況を、resolverがstale以外の
    // (=期限切れpinを黙って別状態として処理してしまった)stateで返した。
    return { fixtureId: fixture.id, outcome: "stale_not_prevented" };
  }

  return {
    fixtureId: fixture.id,
    outcome: "unclassified",
    detail: `expected state "${expected.resolutionState}" but resolver returned "${actual.state}"`,
  };

}

// =========================
// 集計
// =========================

export interface ReferentEvaluationSummary {

  total: number;

  correctAutoResolution: number;

  wrongTargetAutoResolution: number;

  unsafeAutoResolution: number;

  correctClarification: number;

  unnecessaryClarification: number;

  correctFailClosed: number;

  staleHandledSafely: number;

  staleNotPrevented: number;

  conflictDetected: number;

  candidateRecallFailure: number;

  unclassified: number;

  results: readonly FixtureEvaluationResult[];

}

const EMPTY_COUNTS: Omit<ReferentEvaluationSummary, "total" | "results"> = {
  correctAutoResolution: 0,
  wrongTargetAutoResolution: 0,
  unsafeAutoResolution: 0,
  correctClarification: 0,
  unnecessaryClarification: 0,
  correctFailClosed: 0,
  staleHandledSafely: 0,
  staleNotPrevented: 0,
  conflictDetected: 0,
  candidateRecallFailure: 0,
  unclassified: 0,
};

const OUTCOME_TO_COUNTER_KEY: Record<FixtureOutcomeTag, keyof typeof EMPTY_COUNTS> = {
  correct_auto_resolution: "correctAutoResolution",
  wrong_target_auto_resolution: "wrongTargetAutoResolution",
  unsafe_auto_resolution: "unsafeAutoResolution",
  correct_clarification: "correctClarification",
  unnecessary_clarification: "unnecessaryClarification",
  correct_fail_closed: "correctFailClosed",
  stale_handled_safely: "staleHandledSafely",
  stale_not_prevented: "staleNotPrevented",
  conflict_detected: "conflictDetected",
  candidate_recall_failure: "candidateRecallFailure",
  unclassified: "unclassified",
};

/**
 * fixture一覧 + 「fixtureIdからReferentResolutionを得る関数」を受け取り、
 * 決定論的な集計結果を返す。resolve()自体がpureであれば、この関数全体も
 * pureになる(P1c以降、実resolverをresolve()に差し替えるだけで、
 * fixture形式・評価ロジックを書き換えずに済む設計)。
 */
export function evaluateReferentFixtures(
  fixtures: readonly ReferentFixture[],
  resolve: (fixture: ReferentFixture) => ReferentResolution
): ReferentEvaluationSummary {

  const counts = { ...EMPTY_COUNTS };
  const results: FixtureEvaluationResult[] = [];

  for (const fixture of fixtures) {
    const outcome = classifyFixtureOutcome(fixture, resolve(fixture));
    results.push(outcome);
    counts[OUTCOME_TO_COUNTER_KEY[outcome.outcome]] += 1;
  }

  return { total: fixtures.length, ...counts, results };

}
