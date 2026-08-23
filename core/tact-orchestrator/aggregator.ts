import type { Task, TaskExecutionSummary } from "./task";

// =========================
// aggregateResults (Phase 3)
// =========================
//
// 独立した責務として切り出す(絶対条件10)。Commander(commander.ts)は
// この関数を1回呼ぶだけで、集約ロジック自体はここに閉じ込める。
//
// Phase 3では高度なLLM-based synthesisを行わない(絶対条件: 必須では
// ない)。1 Taskの場合はその出力をそのまま返し、複数Taskの場合は
// 各Taskの説明と結果を安全に並べるだけに留める。要約・統合LLM呼び出し
// は追加コストを伴うため、Phase 3のコスト制御方針(Simple→1回実行、
// Complex→2〜3回実行、それ以上のLLM呼び出しを追加しない)に反しない
// よう、Aggregator自体はLLMを一切呼び出さない。
export function aggregateResults(
  tasks: Task[],
  summaries: TaskExecutionSummary[]
): { answer: string } {

  if (summaries.length === 1) {

    const only = summaries[0];

    if (only.status === "completed") {
      return { answer: only.output ?? "" };
    }

    return {
      answer: `タスクの実行に失敗しました: ${only.error ?? "unknown error"}`,
    };

  }

  const lines: string[] = [];

  for (const task of tasks) {

    const summary = summaries.find((s) => s.taskId === task.id);

    if (!summary) {
      continue;
    }

    if (summary.status === "completed") {

      lines.push(`【${task.description}】\n${summary.output ?? ""}`);

    } else if (summary.status === "cancelled") {

      lines.push(`【${task.description}】\n(実行されませんでした: ${summary.error ?? ""})`);

    } else {

      lines.push(`【${task.description}】\n(失敗しました: ${summary.error ?? "unknown error"})`);

    }

  }

  return { answer: lines.join("\n\n") };

}
