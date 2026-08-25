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

  return summarize("decomposeTask", results);

}
