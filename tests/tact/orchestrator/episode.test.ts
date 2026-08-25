// =========================
// buildEpisode Regression (Phase 20)
// =========================
//
// 対象: core/tact-orchestrator/episode.ts の buildEpisode()。
// 純粋関数(DBアクセス・LLM呼び出しなし)のため、Category Aとして
// 実LLM/API呼び出み無しで検証できる。

import { buildEpisode } from "../../../core/tact-orchestrator/episode";
import type { OrchestrationRequest, OrchestrationResult } from "../../../core/tact-orchestrator/types";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const request: OrchestrationRequest = {
    userId: "phase20-test-user",
    input: "トヨタの競合はどこですか？",
  };

  const result: OrchestrationResult = {
    answer: "トヨタの競合には...",
    executionId: "exec-phase20-001",
    tasks: [
      { taskId: "t1", status: "completed", capability: "research", output: "トヨタの競合には..." },
    ],
    memoryUsed: [],
    toolsUsed: [],
    memoryWrites: [],
    learningSignals: ["successful_execution"],
    metadata: { executionMode: "single-execution", durationMs: 1234 },
  };

  // ---- timestamp省略時: episodeId=executionId、timestampIsApproximate=true ----
  {
    const episode = buildEpisode(request, result);
    results.push(
      check(
        "[Phase11] episodeId = result.executionId",
        episode.episodeId === result.executionId
      )
    );
    results.push(
      check(
        "[Phase11] timestamp省略時 -> timestampIsApproximate=true",
        episode.timestampIsApproximate === true
      )
    );
    results.push(
      check(
        "[Phase11] userId = request.userId",
        episode.userId === request.userId
      )
    );
  }

  // ---- timestamp明示時: timestampIsApproximate=false、値がそのまま反映 ----
  {
    const explicitTimestamp = "2026-01-01T00:00:00.000Z";
    const episode = buildEpisode(request, result, { timestamp: explicitTimestamp });
    results.push(
      check(
        "[Phase11] timestamp明示時 -> timestampIsApproximate=false かつ値を反映",
        episode.timestampIsApproximate === false && episode.timestamp === explicitTimestamp,
        `timestamp=${episode.timestamp}`
      )
    );
  }

  // ---- Clarification結果(Phase15)を渡した場合、DBアクセス等の
  // 前提を壊さず素直に束ねられること ----
  {
    const clarificationResult: OrchestrationResult = {
      answer: "何について調べればいいですか?",
      executionId: "exec-phase20-002",
      tasks: [],
      memoryUsed: [],
      toolsUsed: [],
      clarification: { question: "何について調べればいいですか?" },
      memoryWrites: [],
      learningSignals: ["clarification_required"],
      metadata: { executionMode: "clarification-needed" },
    };
    const episode = buildEpisode({ input: "調べて" }, clarificationResult);
    results.push(
      check(
        "[Phase11/Phase15] Clarification結果を渡しても例外なくEpisodeを構築できる",
        episode.episodeId === clarificationResult.executionId && episode.goal === "調べて"
      )
    );
  }

  return summarize("buildEpisode", results);

}
