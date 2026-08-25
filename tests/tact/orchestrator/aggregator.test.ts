// =========================
// aggregateResults Regression (Phase 20)
// =========================
//
// 対象: core/tact-orchestrator/aggregator.ts の aggregateResults()。
// 純粋関数(Task[]・TaskExecutionSummary[]を受け取るだけ)のため、
// 実LLM/API呼び出み無しでCategory Aとして検証できる。

import { aggregateResults } from "../../../core/tact-orchestrator/aggregator";
import type { Task, TaskExecutionSummary } from "../../../core/tact-orchestrator/task";
import { check, summarize, type CheckResult } from "../lib/check";

function makeTask(id: string, description: string): Task {
  return { id, description, status: "pending" };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 単一Task成功 -> outputをそのまま返す ----
  {
    const tasks = [makeTask("t1", "調べる")];
    const summaries: TaskExecutionSummary[] = [
      { taskId: "t1", status: "completed", output: "回答です" },
    ];
    const { answer } = aggregateResults(tasks, summaries);
    results.push(
      check("[Phase3] 単一Task成功 -> answer=output", answer === "回答です", `answer=${answer}`)
    );
  }

  // ---- 単一Task失敗 -> エラーメッセージを含む文言 ----
  {
    const tasks = [makeTask("t1", "調べる")];
    const summaries: TaskExecutionSummary[] = [
      { taskId: "t1", status: "failed", error: "network error" },
    ];
    const { answer } = aggregateResults(tasks, summaries);
    results.push(
      check(
        "[Phase3] 単一Task失敗 -> answerにerrorを含む",
        answer.includes("network error"),
        `answer=${answer}`
      )
    );
  }

  // ---- 複数Task(成功/失敗/cancelled混在) -> 各Taskの説明+結果を並べる ----
  {
    const tasks = [
      makeTask("t1", "Aについて調査する"),
      makeTask("t2", "Bについて調査する"),
      makeTask("t3", "調査結果をもとに要約する"),
    ];
    const summaries: TaskExecutionSummary[] = [
      { taskId: "t1", status: "completed", output: "Aの結果" },
      { taskId: "t2", status: "failed", error: "rate limited" },
      { taskId: "t3", status: "cancelled", error: "dependency task t2 did not complete successfully" },
    ];
    const { answer } = aggregateResults(tasks, summaries);
    const ok =
      answer.includes("Aの結果") &&
      answer.includes("rate limited") &&
      answer.includes("実行されませんでした");
    results.push(
      check(
        "[Phase3/Phase19] 複数Task混在(成功/失敗/cancelled) -> 全結果を反映",
        ok,
        `answer=${answer.replace(/\n/g, " / ")}`
      )
    );
  }

  return summarize("aggregateResults", results);

}
