// =========================
// TACT Work — Domain Type / Enum Regression
// (Architecture Migration Phase B1)
// =========================
//
// 対象: core/tact-work/types.tsが公開するWORK_STATUSES/TASK_STATUSES/
// RUN_STATUSES/APPROVAL_STATUSES/ACTOR_KINDSが、
// supabase/migrations/20260905000000_create_tact_work_tables.sqlの
// CHECK制約と同じ値集合を持つこと。DBアクセス・LLM/Search API呼び
// 出みは一切発生しない。

import {
  WORK_STATUSES,
  TASK_STATUSES,
  RUN_STATUSES,
  APPROVAL_STATUSES,
  ACTOR_KINDS,
} from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Work] WORK_STATUSESはmigrationのCHECK制約と同じ8値を持つ",
      sameSet(WORK_STATUSES, [
        "created",
        "planning",
        "running",
        "waiting_for_input",
        "waiting_for_approval",
        "completed",
        "failed",
        "cancelled",
      ])
    )
  );

  results.push(
    check(
      "[Task] TASK_STATUSESは既存core/tact-orchestrator/task.tsのTaskStatusと同じ5値を持つ",
      sameSet(TASK_STATUSES, [
        "pending",
        "running",
        "completed",
        "failed",
        "cancelled",
      ])
    )
  );

  results.push(
    check(
      "[Run] RUN_STATUSESは3値(running/completed/failed、cancelledは存在しない)",
      sameSet(RUN_STATUSES, ["running", "completed", "failed"]) &&
        !RUN_STATUSES.includes("cancelled" as never)
    )
  );

  results.push(
    check(
      "[Approval] APPROVAL_STATUSESは5値を持つ",
      sameSet(APPROVAL_STATUSES, [
        "pending",
        "approved",
        "rejected",
        "cancelled",
        "expired",
      ])
    )
  );

  results.push(
    check(
      "[Actor] ACTOR_KINDSは4値(user/bot/system/ai)を持つ",
      sameSet(ACTOR_KINDS, ["user", "bot", "system", "ai"])
    )
  );

  return summarize("work/types", results);

}
