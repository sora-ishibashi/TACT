// =========================
// tact-conversation Orchestrator Integration Regression (Phase 67)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsの純粋関数
// (mapOrchestrationTasksToExecutionStatus()・planConversationTurn())、
// および runConversationOrchestration()自体のUser Message → Orchestrator
// → 分岐ロジック(mock capability経由、実DBアクセスなし)。
//
// tests/tact/orchestrator/orchestrateRoute.test.ts(Phase33)と同じ
// 環境制約: このHarness環境にはSupabase Service Role Keyが無く実
// テストUserセッションを用意できないため、core/tact-conversation/
// store.tsが必要とするStage1 RLS(accessToken必須)を経由した実DB書き込み
// はここでは検証しない(npm testには含めない)。そのため、
// runConversationOrchestration()自体の直接呼び出しテストは行わず、
// 代わりに:
//   - status mapping / plan導出は純粋関数として直接検証する
//     (DBアクセスなし、決定論的)
//   - runOrchestration()自体はPhase33と同じmock capability登録パターンで
//     実際に呼び出し、その戻り値(OrchestrationResult)を
//     planConversationTurn()へ渡すところまでを検証する(store.tsの
//     DB書き込みより前の段階で完結させる)
//
// Phase67完了報告に記載の通り、store.ts経由の実書き込み
// (ExecutionRecord/Assistant Message/Clarification Messageの実際の
// Persistence、Clarification時にExecutionRecordが作られないことの
// 実DB確認)は、Phase66と同じくPostgres RLS Reality Test
// (`supabase db query --linked`によるauth.uid()ロールシミュレーション)
// で別途検証し、一時SQLは実行後に削除する。

import "dotenv/config";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { runOrchestration } from "../../../core/tact-orchestrator";
import type { ResearchResult, ResearchParams, ResearchMetadata } from "../../../core/tact-research/types";
import type { TaskExecutionSummary } from "../../../core/tact-orchestrator";
import {
  mapOrchestrationTasksToExecutionStatus,
  planConversationTurn,
} from "../../../core/tact-conversation/orchestration";
import { check, summarize, type CheckResult } from "../lib/check";

function makeMetadata(): ResearchMetadata {
  return {
    executionMode: "web-research", llmAttempts: 1, llmSuccesses: 1, llmFailures: 0,
    searchQueryCount: 1, searchRequestCount: 1, searchAttempts: [],
    retrievedKnowledgeCount: 0, retrievedMemoryCount: 0, retrievedExampleCount: 0,
    usedKnowledgeCount: 0, usedMemoryCount: 0, usedExampleCount: 0,
    usedKnowledgeIds: [], usedMemoryIds: [], usedExampleIds: [],
    durationMs: 100, mocked: false, requirementCount: 1, coveredRequirementCount: 0,
    partialRequirementCount: 0, missingRequirementCount: 1, gapQueries: [], safetyDowngradeCount: 0,
  };
}

function makeTaskSummary(overrides: Partial<TaskExecutionSummary> = {}): TaskExecutionSummary {
  return {
    taskId: "t1",
    status: "completed",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- mapOrchestrationTasksToExecutionStatus(): pure status mapping ----

  results.push(
    check(
      "[Test1] 全Task completed -> completed",
      mapOrchestrationTasksToExecutionStatus([
        makeTaskSummary({ status: "completed" }),
        makeTaskSummary({ status: "completed" }),
      ]) === "completed"
    )
  );

  results.push(
    check(
      "[Test2] 全Task failed -> failed",
      mapOrchestrationTasksToExecutionStatus([
        makeTaskSummary({ status: "failed" }),
        makeTaskSummary({ status: "failed" }),
      ]) === "failed"
    )
  );

  results.push(
    check(
      "[Test3] 一部completed・一部failed -> partial",
      mapOrchestrationTasksToExecutionStatus([
        makeTaskSummary({ status: "completed" }),
        makeTaskSummary({ status: "failed" }),
      ]) === "partial"
    )
  );

  results.push(
    check(
      "[Test4] 一部completed・一部cancelled -> partial",
      mapOrchestrationTasksToExecutionStatus([
        makeTaskSummary({ status: "completed" }),
        makeTaskSummary({ status: "cancelled" }),
      ]) === "partial"
    )
  );

  results.push(
    check(
      "[Test5] 全Task cancelled(1件もcompletedでない) -> failed",
      mapOrchestrationTasksToExecutionStatus([
        makeTaskSummary({ status: "cancelled" }),
      ]) === "failed"
    )
  );

  results.push(
    check(
      "[Test6] tasks=[](異常系、安全側でfailed)",
      mapOrchestrationTasksToExecutionStatus([]) === "failed"
    )
  );

  // ---- planConversationTurn(): 通常完了 ----
  {
    const plan = planConversationTurn({
      answer: "モック回答",
      executionId: "exec-123",
      tasks: [makeTaskSummary({ status: "completed" })],
      memoryUsed: [],
      toolsUsed: [],
      memoryWrites: [],
      learningSignals: ["successful_execution"],
      metadata: { executionMode: "single-execution" },
    });

    results.push(
      check(
        "[Test7] 通常完了 -> plan.kind='normal'、executionId/status/answerを保持",
        plan.kind === "normal" &&
          plan.executionId === "exec-123" &&
          plan.status === "completed" &&
          plan.answer === "モック回答",
        `plan=${JSON.stringify(plan)}`
      )
    );

    results.push(
      check(
        "[Test7-Invariant2] planにTask ID(taskId)そのものが含まれない(Task IDをConversation Layerへ露出しない)",
        !("tasks" in plan) && !("taskId" in plan)
      )
    );
  }

  // ---- planConversationTurn(): Clarification ----
  {
    const plan = planConversationTurn({
      answer: "何について調べればいいですか?",
      executionId: "exec-should-not-be-used",
      tasks: [],
      memoryUsed: [],
      toolsUsed: [],
      memoryWrites: [],
      learningSignals: ["clarification_required"],
      clarification: { question: "何について調べればいいですか?" },
      metadata: { executionMode: "clarification-needed" },
    });

    results.push(
      check(
        "[Test8] Clarification -> plan.kind='clarification'、questionを保持",
        plan.kind === "clarification" && plan.question === "何について調べればいいですか?",
        `plan=${JSON.stringify(plan)}`
      )
    );

    results.push(
      check(
        "[Test8-Invariant4] Clarification plan自体にexecutionIdフィールドが存在しない(ExecutionRecordへ流用できない設計)",
        !("executionId" in plan)
      )
    );
  }

  // ---- runOrchestration()経由(Phase33と同じmock capability pattern) ----
  // -> planConversationTurn()へ渡すところまでを検証する(store.ts書き込みは含まない)

  {
    registerCapability<ResearchParams, ResearchResult>("research", async () => ({
      success: true,
      answer: "実行結果の回答",
      evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
      metadata: makeMetadata(),
    }));

    const result = await runOrchestration({ input: "トヨタの競合はどこですか？" });
    const plan = planConversationTurn(result);

    results.push(
      check(
        "[Test9] runOrchestration()実行結果 -> planConversationTurn()が通常完了planを導出する",
        plan.kind === "normal" && plan.status === "completed" && plan.executionId === result.executionId,
        `plan=${JSON.stringify(plan)}, resultExecutionId=${result.executionId}`
      )
    );
  }

  {
    let capabilityCalled = false;
    registerCapability<ResearchParams, ResearchResult>("research", async () => {
      capabilityCalled = true;
      return { success: true, answer: "should not be called", evidence: [], metadata: makeMetadata() };
    });

    const result = await runOrchestration({ input: "調べて" });
    const plan = planConversationTurn(result);

    results.push(
      check(
        "[Test10] Clarification入力 -> planConversationTurn()がclarification planを導出し、Capabilityは未実行(ExecutionRecord対象外)",
        plan.kind === "clarification" && !capabilityCalled,
        `plan=${JSON.stringify(plan)}, capabilityCalled=${capabilityCalled}`
      )
    );
  }

  return summarize("tact-conversation orchestrator integration (Phase 67)", results);

}
