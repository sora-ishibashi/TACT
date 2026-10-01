// =========================
// TACT Canonical Execution — SOR-53 Canonical Correlation Result
// =========================
//
// 対象: core/tact-execution/correlation/canonicalResult.tsの
// toCanonicalCorrelationResult()。SOR-53指示section「Canonical
// mapping」のRequired test 20を検証する。

import { toCanonicalCorrelationResult } from "@tact/runs-core/tact-execution/correlation/canonicalResult";
import { check, summarize, type CheckResult } from "../../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  results.push(check(
    "[Required test 20] matched -> CORRELATED",
    toCanonicalCorrelationResult("matched") === "CORRELATED"
  ));

  results.push(check(
    "[Required test 20] ambiguous -> AMBIGUOUS",
    toCanonicalCorrelationResult("ambiguous") === "AMBIGUOUS"
  ));

  results.push(check(
    "[Required test 20] unresolved -> UNASSIGNED",
    toCanonicalCorrelationResult("unresolved") === "UNASSIGNED"
  ));

  return summarize("TACT Canonical Execution — SOR-53 Canonical Correlation Result", results);
}
