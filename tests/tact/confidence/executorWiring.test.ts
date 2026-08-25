// =========================
// Confidence Signal — Executor Wiring Regression (Phase 21)
// =========================
//
// 対象: core/tact-orchestrator/executor.ts のresearch分岐が、
// deriveAnswerConfidence()の結果とResearchResult.uncertaintyを
// TaskExecutionSummaryへ正しく反映すること。
//
// Category B(Mock-based Evaluation)。"research"という名前で
// テスト専用のCapabilityを登録する(既存の本番API
// registerCapability()、Phase20のexecutor.test.tsと同じ手法)。
// このHarnessプロセス内ではbootstrapTactCapabilities()を呼んでいない
// ため、実際のResearch実装を上書きすることはない。実LLM/Search API
// 呼び出みは一切発生しない。

import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { createMockCoreCapability } from "../../../core/tact-core/mockCoreCapability";
import { executeTask } from "../../../core/tact-orchestrator/executor";
import type { Task } from "../../../core/tact-orchestrator/task";
import type { ResearchResult, ResearchParams, ResearchMetadata } from "../../../core/tact-research/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeMetadata(): ResearchMetadata {
  return {
    executionMode: "web-research",
    llmAttempts: 1,
    llmSuccesses: 1,
    llmFailures: 0,
    searchQueryCount: 1,
    searchRequestCount: 1,
    searchAttempts: [],
    retrievedKnowledgeCount: 0,
    retrievedMemoryCount: 0,
    retrievedExampleCount: 0,
    usedKnowledgeCount: 0,
    usedMemoryCount: 0,
    usedExampleCount: 0,
    usedKnowledgeIds: [],
    usedMemoryIds: [],
    usedExampleIds: [],
    durationMs: 100,
    mocked: false,
    requirementCount: 1,
    coveredRequirementCount: 0,
    partialRequirementCount: 0,
    missingRequirementCount: 1,
    gapQueries: [],
    safetyDowngradeCount: 0,
  };
}

async function runResearchTask(mockResult: ResearchResult) {

  registerCapability<ResearchParams, ResearchResult>("research", async () => mockResult);

  const core = createMockCoreCapability();
  const task: Task = {
    id: "phase21-wiring",
    description: "テスト",
    status: "pending",
    assignedCapability: "research",
  };

  return executeTask(task, core, {
    task,
    coreContext: { knowledge: [], memories: [], examples: [], recentExecutions: [] },
    memoryReferences: [],
    dependencyResults: [],
  });

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- High confidence(全evidence high) -> answerConfidence=supported ----
  {
    const summary = await runResearchTask({
      success: true,
      answer: "強い根拠のある回答",
      evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
      metadata: makeMetadata(),
    });
    results.push(
      check(
        "[Phase21] High confidence Research -> status=completed, answerConfidence=supported",
        summary.status === "completed" && summary.answerConfidence === "supported"
      )
    );
  }

  // ---- Medium/low混在 -> partially_supported ----
  {
    const summary = await runResearchTask({
      success: true,
      answer: "一部根拠が弱い回答",
      evidence: [
        { id: "e1", claim: "c1", confidence: "high" },
        { id: "e2", claim: "c2", confidence: "low" },
      ],
      metadata: makeMetadata(),
    });
    results.push(
      check(
        "[Phase21] Evidence混在(high+low) -> answerConfidence=partially_supported",
        summary.answerConfidence === "partially_supported"
      )
    );
  }

  // ---- Evidence 0件 -> insufficient_evidence ----
  {
    const summary = await runResearchTask({
      success: true,
      answer: "確認できませんでした",
      evidence: [],
      metadata: makeMetadata(),
      uncertainty: "具体的な情報は確認できませんでした",
    });
    results.push(
      check(
        "[Phase21] Evidence 0件 -> answerConfidence=insufficient_evidence、uncertaintyNoteを保持",
        summary.answerConfidence === "insufficient_evidence" &&
          summary.uncertaintyNote === "具体的な情報は確認できませんでした"
      )
    );
  }

  // ---- Research Task失敗(success:false) -> answerConfidenceはundefined
  // (絶対条件5: Execution confidence(status="failed")と混同しない) ----
  {
    const summary = await runResearchTask({
      success: false,
      answer: "",
      evidence: [],
      metadata: makeMetadata(),
      errorMessage: "mock research failure",
    });
    results.push(
      check(
        "[Phase21] Research Task失敗 -> status=failed、answerConfidenceはundefined",
        summary.status === "failed" && summary.answerConfidence === undefined
      )
    );
  }

  return summarize("confidence/executorWiring", results);

}
