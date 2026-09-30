// =========================
// SOR-131 — Runs v1 Observation Priority Regression
// =========================
//
// 対象: core/tact-execution/registry/types.tsのOBSERVATION_MODE_PRIORITY_V1。
// docs/architecture/runs-v1-observation-first-connection-strategy.md §4
// が定めるinline > instrumented > reconciledの優先順位を、コード側の
// 定数としても固定する(prose-onlyではなくmachine-readableにする)。

import { OBSERVATION_MODE_PRIORITY_V1 } from "../../../../core/tact-execution/registry/types";
import { check, summarize, type CheckResult } from "../../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[SOR-131] Runs v1 observation priorityはinline > instrumented > reconciledの順(Browser/Desktopはv1に含まない)",
      OBSERVATION_MODE_PRIORITY_V1.length === 3 &&
        OBSERVATION_MODE_PRIORITY_V1[0] === "inline" &&
        OBSERVATION_MODE_PRIORITY_V1[1] === "instrumented" &&
        OBSERVATION_MODE_PRIORITY_V1[2] === "reconciled"
    )
  );

  return summarize("SOR-131 — Runs v1 Observation Priority", results);

}
