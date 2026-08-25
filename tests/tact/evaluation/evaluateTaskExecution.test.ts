// =========================
// evaluateTaskExecution Regression (Phase 27)
// =========================
//
// 対象: core/tact-orchestrator/evaluation.ts の evaluateTaskExecution()。
// Phase26のReality Test結論をそのまま恒久テストへ移した。
// Category A(Deterministic Evaluation)、LLM/API/DB呼び出み0件
// (TaskExecutionSummaryのfixtureを直接構築するのみ)。

import { evaluateTaskExecution } from "../../../core/tact-orchestrator/evaluation";
import type { TaskExecutionSummary } from "../../../core/tact-orchestrator/task";
import { check, summarize, type CheckResult } from "../lib/check";

function makeSummary(overrides: Partial<TaskExecutionSummary> = {}): TaskExecutionSummary {
  return {
    taskId: "t1",
    status: "completed",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1. Research + supported -> successful_execution ----
  {
    const s = makeSummary({ capability: "research", answerConfidence: "supported" });
    results.push(
      check(
        "[1] Research + supported -> successful_execution",
        evaluateTaskExecution(s) === "successful_execution"
      )
    );
  }

  // ---- 2. Research + partially_supported -> partially_successful ----
  {
    const s = makeSummary({ capability: "research", answerConfidence: "partially_supported" });
    results.push(
      check(
        "[2] Research + partially_supported -> partially_successful",
        evaluateTaskExecution(s) === "partially_successful"
      )
    );
  }

  // ---- 3. Research + insufficient_evidence -> insufficient_evidence ----
  {
    const s = makeSummary({ capability: "research", answerConfidence: "insufficient_evidence" });
    results.push(
      check(
        "[3] Research + insufficient_evidence -> insufficient_evidence",
        evaluateTaskExecution(s) === "insufficient_evidence"
      )
    );
  }

  // ---- 4. failed -> permanent_failure ----
  {
    const s = makeSummary({ status: "failed", error: "mock failure" });
    results.push(
      check(
        "[4] failed -> permanent_failure",
        evaluateTaskExecution(s) === "permanent_failure"
      )
    );
  }

  // ---- 5. cancelled -> permanent_failure ----
  {
    const s = makeSummary({ status: "cancelled", error: "dependency task did not complete" });
    results.push(
      check(
        "[5] cancelled -> permanent_failure",
        evaluateTaskExecution(s) === "permanent_failure"
      )
    );
  }

  // ---- 6. Chat + completed -> successful_execution ----
  {
    const s = makeSummary({ capability: undefined, output: "こんにちは" });
    results.push(
      check(
        "[6] Chat + completed -> successful_execution",
        evaluateTaskExecution(s) === "successful_execution"
      )
    );
  }

  // ---- 7. Chat + answerConfidence undefined -> successful_execution
  // (undefinedを「低信頼」と誤解釈しないことの確認、絶対条件) ----
  {
    const s = makeSummary({ capability: undefined, answerConfidence: undefined });
    results.push(
      check(
        "[7] Chat + answerConfidence undefined -> successful_execution(低信頼と誤解釈しない)",
        evaluateTaskExecution(s) === "successful_execution"
      )
    );
  }

  // ---- 8. clarification -> clarification_required ----
  {
    // Phase15の実際の経路(tasks=[])を反映し、summary自体は
    // 最小限のダミー値で構わないことも合わせて確認する。
    const s = makeSummary({ taskId: "clarification-dummy" });
    results.push(
      check(
        "[8] clarification: true -> clarification_required(summaryの中身に関わらず)",
        evaluateTaskExecution(s, { clarification: true }) === "clarification_required"
      )
    );
  }

  // ---- 9. Research + completed + answerConfidence undefined ----
  // (異常な入力でもEvaluationが壊れないことの確認)
  {
    const s = makeSummary({ capability: "research", answerConfidence: undefined });
    results.push(
      check(
        "[9] Research + completed + answerConfidence undefined -> successful_execution(異常系でも壊れない)",
        evaluateTaskExecution(s) === "successful_execution"
      )
    );
  }

  // ---- 10. uncertaintyNoteが存在してもSignal判定が変わらない ----
  {
    const withNote = makeSummary({
      capability: "research",
      answerConfidence: "insufficient_evidence",
      uncertaintyNote: "具体的な情報は確認できませんでした",
    });
    results.push(
      check(
        "[10] uncertaintyNoteが存在してもSignal判定は変わらない",
        evaluateTaskExecution(withNote) === "insufficient_evidence"
      )
    );
  }

  // ---- 11. uncertaintyNoteがundefinedでもSignal判定が正常 ----
  {
    const withoutNote = makeSummary({
      capability: "research",
      answerConfidence: "insufficient_evidence",
      uncertaintyNote: undefined,
    });
    results.push(
      check(
        "[11] uncertaintyNoteがundefinedでもSignal判定は正常",
        evaluateTaskExecution(withoutNote) === "insufficient_evidence"
      )
    );
  }

  // ---- 12. evidenceCountの値を変更してもanswerConfidenceが同じなら
  // Signalが変わらない(evidenceCount閾値に依存しないことの恒久保証、
  // 絶対条件) ----
  {
    const lowCount = makeSummary({
      capability: "research",
      answerConfidence: "supported",
      evidenceCount: 1,
    });
    const highCount = makeSummary({
      capability: "research",
      answerConfidence: "supported",
      evidenceCount: 99,
    });
    const zeroCountButSupported = makeSummary({
      capability: "research",
      answerConfidence: "supported",
      evidenceCount: 0,
    });
    const signals = [
      evaluateTaskExecution(lowCount),
      evaluateTaskExecution(highCount),
      evaluateTaskExecution(zeroCountButSupported),
    ];
    results.push(
      check(
        "[12] evidenceCountを1/99/0と変えてもanswerConfidence=supportedならSignalは常にsuccessful_execution",
        signals.every((s) => s === "successful_execution"),
        `signals=${JSON.stringify(signals)}`
      )
    );
  }

  return summarize("evaluateTaskExecution", results);

}
