// =========================
// decomposeTask Regression (Phase 20)
// =========================
//
// 対象: core/tact-orchestrator/decomposer.ts の decomposeTask()。
// Phase3(依存構造)・Phase10(比較表現の自然言語耐性)のReality Test
// ケースを恒久testへ移した。Category A(Deterministic Evaluation)、
// LLM/API呼び出み0件(classifyIntent()も含め決定論的)。

import { decomposeTask } from "../../../core/tact-orchestrator/decomposer";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Simple Task(1 Task、Phase3/Phase18) ----

  const simpleChat = decomposeTask({ input: "コードは何ですか？" });
  results.push(
    check(
      "[Phase3] Simple Task(chat) -> 1 Task, assignedCapability=undefined",
      simpleChat.length === 1 && simpleChat[0].assignedCapability === undefined,
      `tasks=${simpleChat.length}, capability=${simpleChat[0]?.assignedCapability}`
    )
  );

  const simpleResearch = decomposeTask({ input: "日本の首相は誰ですか？" });
  results.push(
    check(
      "[Phase18] Simple Task(research question) -> 1 Task, assignedCapability=research",
      simpleResearch.length === 1 && simpleResearch[0].assignedCapability === "research",
      `tasks=${simpleResearch.length}, capability=${simpleResearch[0]?.assignedCapability}`
    )
  );

  // ---- 依存パターン(Phase3、SEQUENTIAL_PATTERN) ----

  const sequential = decomposeTask({
    input: "トヨタについて調べて、その結果をもとに要約してください",
  });
  const seqOk =
    sequential.length === 2 &&
    sequential[0].assignedCapability === "research" &&
    sequential[0].dependencies === undefined &&
    Array.isArray(sequential[1].dependencies) &&
    sequential[1].dependencies?.[0] === sequential[0].id;
  results.push(
    check(
      "[Phase3] Sequential dependency -> 2 Tasks, task[1].dependencies=[task[0].id]",
      seqOk,
      `tasks=${sequential.length}, dep=${JSON.stringify(sequential[1]?.dependencies)}`
    )
  );

  // ---- 比較パターン(COMPARE_PATTERN、独立2 Task・依存なし) ----

  const compare = decomposeTask({
    input: "トヨタについて調べて、ホンダと比較して",
  });
  const compareOk =
    compare.length === 2 &&
    compare.every((t) => t.assignedCapability === "research") &&
    compare.every((t) => t.dependencies === undefined);
  results.push(
    check(
      "[Phase3] Compare pattern -> 2 independent research Tasks (no dependency)",
      compareOk,
      `tasks=${compare.length}, descriptions=${JSON.stringify(compare.map((t) => t.description))}`
    )
  );

  // ---- Phase10: 「AとBをそれぞれ調べて比較して」構造 ----

  const listedCompare = decomposeTask({
    input: "トヨタとホンダについてそれぞれ調べて比較して",
  });
  const listedCompareOk =
    listedCompare.length === 2 &&
    listedCompare.every((t) => t.assignedCapability === "research");
  results.push(
    check(
      "[Phase10] \"AとBをそれぞれ調べて比較して\" -> 2 independent research Tasks",
      listedCompareOk,
      `tasks=${listedCompare.length}, descriptions=${JSON.stringify(listedCompare.map((t) => t.description))}`
    )
  );

  // ---- Phase10 False Positive防止: 個別調査の明示が無い比較依頼は
  // 1 Taskのまま(絶対条件18: FPをRecallより優先) ----

  const noMarkerCompare = decomposeTask({
    input: "iPhoneとAndroidを比較して",
  });
  results.push(
    check(
      "[Phase10-FP] \"AとBを比較して\"(それぞれ等の明示無し) -> 1 Task(分解しない)",
      noMarkerCompare.length === 1,
      `tasks=${noMarkerCompare.length}`
    )
  );

  // ---- RUNS-P1b(Section10、dependency propagation audit lock):
  // 現在decomposeTask()が生成しうる全パターンのうち、TaskDependencyが
  // 実際に作られるのはSEQUENTIAL_PATTERN(research → 後続要約Task)
  // だけであり、その依存先(dependsOnTaskId)は常にresearch Task
  // (assignedCapability="research")である——Integration Capability
  // (assignedCapability.startsWith("integration."))が他Taskの依存先に
  // なることは、現在のdecomposeTask()の出力からは構造的に発生しない
  // (Context Resolution Plan由来のNotion/Gmail Taskは常に独立した
  // sibling Taskとして生成され、dependenciesを一切持たない)。
  //
  // これは、RUNS-P1bのSection10が懸念する「waiting_for_retryなTaskに
  // 依存する後続Taskの扱い」が、現時点のTask分解パターンでは到達
  // 不可能であることのrepository realityに基づく直接的な証拠であり
  // (waiting_for_retryはIntegration Capability経由のTaskだけが到達
  // しうる状態のため)、将来decomposeTask()に新しい分解パターンが
  // 追加され、Integration Capability Taskが他Taskの依存先になり得る
  // ようになった場合には、このcheckが失敗して知らせる(絶対条件:
  // 存在しないシナリオ向けの実装を先回りして作らない、代わりに
  // 前提が崩れたことを検知するregressionを残す)。
  {

    const allOutputs = [
      decomposeTask({ input: "トヨタについて調べて、その結果をもとに要約してください" }),
      decomposeTask({ input: "トヨタについて調べて、ホンダと比較して" }),
      decomposeTask({ input: "トヨタとホンダについてそれぞれ調べて比較して" }),
      decomposeTask({ input: "日本の首相は誰ですか？" }),
      decomposeTask({ input: "コードは何ですか？" }),
      decomposeTask({
        input: "(context-derived)",
        contextResolutionPlan: {
          kind: "ready",
          requestText: "更新案件を確認して",
          sources: { notion: { query: "更新案件" }, gmail: { query: "更新案件" } },
        },
      }),
    ];

    let dependencyEdgeCount = 0;
    let integrationUpstreamCount = 0;

    for (const tasks of allOutputs) {

      const byId = new Map(tasks.map((t) => [t.id, t]));

      for (const task of tasks) {
        for (const dependsOnId of task.dependencies ?? []) {

          dependencyEdgeCount++;

          const upstream = byId.get(dependsOnId);

          if (upstream?.assignedCapability?.startsWith("integration.")) {
            integrationUpstreamCount++;
          }

        }
      }

    }

    results.push(
      check(
        "[RUNS-P1b dependency-audit] decomposeTask()が生成するTaskDependencyの依存先(upstream)は、現時点でIntegration Capability(gmail/notion/slack)のTaskになることが無い(dependencyは1件以上観測され、そのうちIntegration Capability依存は0件)",
        dependencyEdgeCount > 0 && integrationUpstreamCount === 0
      )
    );

  }

  return summarize("decomposeTask", results);

}
