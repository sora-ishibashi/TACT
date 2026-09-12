// =========================
// TACT Referent — Real Resolver Wired Into Evaluation Harness (REF-P1c)
// =========================
//
// PART22の明示的指示: 「P1cは最終的に実resolverをevaluation harnessへ
// plugする」。ここでtests/tact/referent/fixtures.tsの全fixtureを、
// core/tact-referent/resolve.tsの実resolveReferent()へ通し、
// blocking metrics(WRONG_TARGET_AUTO_RESOLUTION / UNSAFE_AUTO_RESOLUTION)
// が0であることを確認する。resolverAdapter.tsがfixture.expectedを
// 一切resolverへ渡さないことは、resolverAdapter.ts自身の型
// (ResolveReferentInputにground truthを表すfieldが存在しない)により
// 構造的に保証されている(PART13)。

import { REFERENT_FIXTURES } from "./fixtures";
import { resolverInputFromFixture } from "./resolverAdapter";
import { resolveReferent } from "../../../core/tact-referent/resolve";
import { evaluateReferentFixtures } from "./evaluation";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const summary = evaluateReferentFixtures(REFERENT_FIXTURES, (fixture) =>
    resolveReferent(resolverInputFromFixture(fixture))
  );

  // ---- blocking metrics (PART17/PART26、絶対条件) ----

  results.push(
    check(
      "[REF-P1c wired] WRONG_TARGET_AUTO_RESOLUTION = 0(全fixtureに対して)",
      summary.wrongTargetAutoResolution === 0,
      `actual=${summary.wrongTargetAutoResolution}`
    )
  );

  results.push(
    check(
      "[REF-P1c wired] UNSAFE_AUTO_RESOLUTION = 0(全fixtureに対して)",
      summary.unsafeAutoResolution === 0,
      `actual=${summary.unsafeAutoResolution}`
    )
  );

  results.push(
    check(
      "[REF-P1c wired] unclassified = 0(全fixtureがいずれかの既知パターンへ分類される、未分類の組み合わせが残っていない)",
      summary.unclassified === 0,
      `actual=${summary.unclassified}; ${summary.results.filter((r) => r.outcome === "unclassified").map((r) => `${r.fixtureId}: ${r.detail}`).join(" / ")}`
    )
  );

  // ---- non-blocking／可視化用metrics(PART22で報告が要求されている) ----

  results.push(
    check(
      "[REF-P1c wired] staleNotPrevented = 0(pinされたstale synthetic inputはすべて安全にstaleとして扱われる)",
      summary.staleNotPrevented === 0
    )
  );

  results.push(
    check(
      "[REF-P1c wired] fixture数は30件以上、40件以下(PART16: 機械的な50件埋めをしない)",
      REFERENT_FIXTURES.length >= 30 && REFERENT_FIXTURES.length <= 40,
      `total=${REFERENT_FIXTURES.length}`
    )
  );

  const writeFixtureCount = REFERENT_FIXTURES.filter((f) => f.requestType === "act").length;

  results.push(
    check(
      "[REF-P1c wired] WRITE(act) fixtureが全体の半数以上を占める(WRITE安全性がこのphaseの中心的な関心事であることの反映)",
      writeFixtureCount >= REFERENT_FIXTURES.length / 2,
      `writeFixtureCount=${writeFixtureCount} / total=${REFERENT_FIXTURES.length}`
    )
  );

  console.log(
    "  [metrics] " +
      JSON.stringify({
        total: summary.total,
        writeFixtureCount,
        correctAutoResolution: summary.correctAutoResolution,
        wrongTargetAutoResolution: summary.wrongTargetAutoResolution,
        unsafeAutoResolution: summary.unsafeAutoResolution,
        correctClarification: summary.correctClarification,
        unnecessaryClarification: summary.unnecessaryClarification,
        correctFailClosed: summary.correctFailClosed,
        staleHandledSafely: summary.staleHandledSafely,
        staleNotPrevented: summary.staleNotPrevented,
        conflictDetected: summary.conflictDetected,
        candidateRecallFailure: summary.candidateRecallFailure,
        unclassified: summary.unclassified,
      })
  );

  return summarize("referent/wiredEvaluation", results);

}
