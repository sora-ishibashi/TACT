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
      "[Task] TASK_STATUSESはmigrationのCHECK制約(RUNS-P1bで追加されたwaiting_for_retryを含む)と同じ6値を持つ",
      sameSet(TASK_STATUSES, [
        "pending",
        "running",
        "waiting_for_retry",
        "completed",
        "failed",
        "cancelled",
      ])
    )
  );

  // RUNS-P1b: core/tact-orchestrator/task.tsのTaskStatus(ephemeral、
  // 1 turn内でしか存在しないOrchestrator Task用)は意図的に5値のまま
  // 変更していない——"waiting_for_retry"はcross-turnで永続化された
  // WorkTaskだけが持ちうる状態であり、turnをまたいで存在しない
  // Orchestrator Taskには意味を持たない(Repository Reality Audit
  // finding)。したがって、この2つのTaskStatusはもはや「同じ値集合」
  // ではなく「core/tact-work側が意図的に1値多いsuperset」であることを
  // 明示的にlockする(以前はこのfileの上のcheckが「両者は完全に同じ
  // 5値」と誤って主張していた——今回、両者が別の型として意図的に
  // 分岐したことをこのtestで正しく記録する)。
  results.push(
    check(
      '[Task] TASK_STATUSES(core/tact-work)は、core/tact-orchestrator/task.tsのTaskStatus(ephemeral、5値、変更なし)のsupersetであり、差分は"waiting_for_retry"の1値だけである',
      ["pending", "running", "completed", "failed", "cancelled"].every((value) =>
        TASK_STATUSES.includes(value as typeof TASK_STATUSES[number])
      ) &&
        TASK_STATUSES.length === 6 &&
        TASK_STATUSES.includes("waiting_for_retry")
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
