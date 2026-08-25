// =========================
// Executor(runTasks) Regression (Phase 20)
// =========================
//
// 対象: core/tact-orchestrator/executor.ts の runTasks()
// (dependency-aware wave scheduling + Concurrency Governor)。
//
// Category B(Mock-based Evaluation)。実LLM/Search API呼び出みを
// 一切行わず、core/tact-core/capabilities/registry.ts の
// registerCapability()(既存の本番API)へテスト専用のCapabilityを
// 登録し、それをTask.assignedCapabilityとして使うことで、Executor本体
// (runTasks/executeTask、無変更)の実挙動を検証する。Executor自体への
// テスト専用DI注入口は追加していない(Step10: Executorは原則変更禁止。
// 既存のCapability Registryという正規の拡張点を使うだけで足りたため、
// Executor自体を変更する必要は無かった)。

import { runTasks } from "../../../core/tact-orchestrator/executor";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { createMockCoreCapability } from "../../../core/tact-core/mockCoreCapability";
import { createConcurrencyGovernor, resolveMaxAgents } from "../../../core/tact-orchestrator/concurrencyGovernor";
import type { Task } from "../../../core/tact-orchestrator/task";
import { check, summarize, type CheckResult } from "../lib/check";

const OK_CAPABILITY = "phase20-mock-ok";
const FAIL_CAPABILITY = "phase20-mock-fail";
const CONCURRENCY_CAPABILITY = "phase20-mock-concurrency";

function makeTask(overrides: Partial<Task>): Task {
  return { id: crypto.randomUUID(), description: "テスト", status: "pending", ...overrides };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];
  const core = createMockCoreCapability();

  // ---- テスト専用Capabilityの登録(既存API、Executor自体は無変更) ----

  let okCallCount = 0;
  registerCapability<{ query: string }, { answer: string }>(OK_CAPABILITY, async (params) => {
    okCallCount++;
    return { answer: `mock-output:${params.query}` };
  });

  registerCapability<{ query: string }, { answer: string }>(FAIL_CAPABILITY, async () => {
    throw new Error("phase20 mock permanent failure (not a LLMProviderError)");
  });

  let concurrentCount = 0;
  let maxObservedConcurrency = 0;
  registerCapability<{ query: string }, { answer: string }>(CONCURRENCY_CAPABILITY, async () => {
    concurrentCount++;
    maxObservedConcurrency = Math.max(maxObservedConcurrency, concurrentCount);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrentCount--;
    return { answer: "ok" };
  });

  // ---- Phase3/Phase6: 独立した2 Taskが両方completedになる(並列実行) ----
  {
    const t1 = makeTask({ description: "A", assignedCapability: OK_CAPABILITY });
    const t2 = makeTask({ description: "B", assignedCapability: OK_CAPABILITY });

    const governor = createConcurrencyGovernor(resolveMaxAgents());
    const summaries = await runTasks([t1, t2], core, {}, governor);

    results.push(
      check(
        "[Phase3/Phase6] 独立した2 Task -> 両方completed(並列実行)",
        summaries.length === 2 && summaries.every((s) => s.status === "completed"),
        JSON.stringify(summaries.map((s) => s.status))
      )
    );
  }

  // ---- Phase3: dependencyのある2 Taskが正しい順序で実行され、
  // 後続Taskの入力に前段の出力が反映される ----
  {
    const t1 = makeTask({ description: "前段の調査", assignedCapability: OK_CAPABILITY });
    const t2 = makeTask({
      description: "後続の要約",
      assignedCapability: OK_CAPABILITY,
      dependencies: [t1.id],
    });

    const governor = createConcurrencyGovernor(resolveMaxAgents());
    const summaries = await runTasks([t1, t2], core, {}, governor);

    const s1 = summaries.find((s) => s.taskId === t1.id);
    const s2 = summaries.find((s) => s.taskId === t2.id);

    const dependencyReflected =
      s2?.output?.includes(`mock-output:前段のTaskの結果`) ?? false;

    results.push(
      check(
        "[Phase3] dependencyのある2 Task -> 両方completed、後続Taskの入力に前段結果が反映される",
        s1?.status === "completed" && s2?.status === "completed" && dependencyReflected,
        `s1=${s1?.status}, s2.output=${s2?.output}`
      )
    );
  }

  // ---- 絶対条件17: dependency先が失敗したTaskはcancelledになり、
  // Capabilityは一切呼ばれない(追加コスト0) ----
  {
    const t1 = makeTask({ description: "失敗するTask", assignedCapability: FAIL_CAPABILITY });
    const t2 = makeTask({
      description: "後続Task",
      assignedCapability: OK_CAPABILITY,
      dependencies: [t1.id],
    });

    const callsBefore = okCallCount;

    const governor = createConcurrencyGovernor(resolveMaxAgents());
    const summaries = await runTasks([t1, t2], core, {}, governor);

    const s1 = summaries.find((s) => s.taskId === t1.id);
    const s2 = summaries.find((s) => s.taskId === t2.id);

    results.push(
      check(
        "[Phase3/絶対条件17] 依存先Task失敗 -> 後続Taskはcancelled、Capabilityは呼ばれない",
        s1?.status === "failed" && s2?.status === "cancelled" && okCallCount === callsBefore,
        `s1=${s1?.status}, s2=${s2?.status}, okCallCount変化=${okCallCount - callsBefore}`
      )
    );
  }

  // ---- Phase6: Concurrency Governor(maxAgents=1)が同時実行数を
  // 実際に1件へ制限する ----
  {
    const t1 = makeTask({ description: "C1", assignedCapability: CONCURRENCY_CAPABILITY });
    const t2 = makeTask({ description: "C2", assignedCapability: CONCURRENCY_CAPABILITY });
    const t3 = makeTask({ description: "C3", assignedCapability: CONCURRENCY_CAPABILITY });

    maxObservedConcurrency = 0;

    const governor = createConcurrencyGovernor(resolveMaxAgents({ maxAgents: 1 }));
    const summaries = await runTasks([t1, t2, t3], core, {}, governor);

    results.push(
      check(
        "[Phase6] maxAgents=1 -> 同時実行数は常に1(Governorが直列化する)",
        summaries.every((s) => s.status === "completed") && maxObservedConcurrency === 1,
        `maxObservedConcurrency=${maxObservedConcurrency}`
      )
    );
  }

  return summarize("runTasks(Executor)", results);

}
