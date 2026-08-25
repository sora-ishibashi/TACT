// =========================
// learningSignals Wiring Reality Test (Phase 28)
// =========================
//
// 対象: core/tact-orchestrator/commander.ts の runOrchestration()が
// OrchestrationResult.learningSignals(Phase28で追加)を正しく生成する
// こと。Phase27のevaluateTaskExecution()自体の単体テストは
// tests/tact/evaluation/evaluateTaskExecution.test.tsで既に完結して
// いるため、ここでは「実際のOrchestration経路(Commander→Decomposer→
// Executor→commander.tsのlearningSignals配線)を通しても正しく
// 反映されるか」を検証する(Phase28 Step7・Step10)。
//
// Category B(Mock-based Evaluation)。"research"という名前でテスト
// 専用のCapabilityを登録する(既存の本番API registerCapability()、
// Phase20/21のexecutor.test.ts/executorWiring.test.tsと同じ手法)。
// LLM/Search APIは一切呼ばない。

import "dotenv/config";
import { bootstrapTactCapabilities } from "../../../core/tact-bootstrap";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { createMockCoreCapability } from "../../../core/tact-core/mockCoreCapability";
import { runOrchestration } from "../../../core/tact-orchestrator/commander";
import { runTasks } from "../../../core/tact-orchestrator/executor";
import { evaluateTaskExecution } from "../../../core/tact-orchestrator/evaluation";
import { createConcurrencyGovernor, resolveMaxAgents } from "../../../core/tact-orchestrator/concurrencyGovernor";
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

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // bootstrapTactCapabilities()を先に自分で1回呼び、その直後に
  // "research"をmockへ上書きする(registerCapability()は同名登録を
  // 上書きする既存仕様)。runOrchestration()内部でも
  // bootstrapTactCapabilities()が呼ばれるが、これは冪等実装
  // (core/tact-bootstrap.tsのbootstrapped flag)のため、ここで
  // 登録したmockが上書きされ直すことはない。
  bootstrapTactCapabilities();

  // 注意: 以下のrunOrchestration()呼び出しはuserIdを渡さない。
  // commander.tsはCoreCapabilityとしてcreateSupabaseCoreCapability()を
  // 直接生成する(mock差し替え不可、既存設計)ため、userIdを渡すと
  // buildTaskContext()が実Supabaseへ接続しようとしてしまう
  // (実測で確認: 本Harness環境では接続できずtask context build
  // failedとなった)。taskContext.ts側は既存仕様として「userId未指定
  // → 空のCoreContextを返す(Supabaseへ問い合わせない)」という
  // 安全側フォールバックを持つ(Phase4確立済み)ため、これを使うことで
  // 実DB接続を経由せずに本番のrunOrchestration()経路を検証できる。

  // ---- Case A: Research + supported -> successful_execution
  // (実際のrunOrchestration()経路、LLM/Search呼び出みは0) ----
  {
    registerCapability<ResearchParams, ResearchResult>("research", async () => ({
      success: true,
      answer: "強い根拠のある回答",
      evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
      metadata: makeMetadata(),
    }));

    const result = await runOrchestration({
      input: "日本の首相は誰ですか？",
    });

    results.push(
      check(
        "[Case A] Research + supported -> learningSignals=[\"successful_execution\"]",
        result.tasks.length === 1 &&
          JSON.stringify(result.learningSignals) === JSON.stringify(["successful_execution"]),
        `tasks=${result.tasks.length}, learningSignals=${JSON.stringify(result.learningSignals)}`
      )
    );
  }

  // ---- Case B: Research + partially_supported -> partially_successful ----
  {
    registerCapability<ResearchParams, ResearchResult>("research", async () => ({
      success: true,
      answer: "一部根拠が弱い回答",
      evidence: [
        { id: "e1", claim: "c1", confidence: "high" },
        { id: "e2", claim: "c2", confidence: "low" },
      ],
      metadata: makeMetadata(),
    }));

    const result = await runOrchestration({
      input: "トヨタの競合はどこですか？",
    });

    results.push(
      check(
        "[Case B] Research + partially_supported -> learningSignals=[\"partially_successful\"]",
        JSON.stringify(result.learningSignals) === JSON.stringify(["partially_successful"]),
        `learningSignals=${JSON.stringify(result.learningSignals)}`
      )
    );
  }

  // ---- Case C: Research + insufficient_evidence -> insufficient_evidence ----
  {
    registerCapability<ResearchParams, ResearchResult>("research", async () => ({
      success: true,
      answer: "確認できませんでした",
      evidence: [],
      metadata: makeMetadata(),
      uncertainty: "具体的な情報は確認できませんでした",
    }));

    const result = await runOrchestration({
      input: "生成AIの最新動向について調べて",
    });

    results.push(
      check(
        "[Case C] Research + insufficient_evidence -> learningSignals=[\"insufficient_evidence\"]",
        JSON.stringify(result.learningSignals) === JSON.stringify(["insufficient_evidence"]),
        `learningSignals=${JSON.stringify(result.learningSignals)}`
      )
    );
  }

  // ---- Case F(指示書のCase F): Clarification -> ["clarification_required"]
  // (Ambiguity Detectionはdecomposer/executor到達前に判定するため、
  // Capability呼び出み自体が発生しない、真の0コスト経路) ----
  {
    const result = await runOrchestration({
      input: "調べて",
    });

    results.push(
      check(
        "[Case F] Clarification -> learningSignals=[\"clarification_required\"](tasks=[]のまま)",
        result.tasks.length === 0 &&
          result.clarification !== undefined &&
          JSON.stringify(result.learningSignals) === JSON.stringify(["clarification_required"]),
        `tasks=${result.tasks.length}, learningSignals=${JSON.stringify(result.learningSignals)}`
      )
    );
  }

  // ---- Case D/E/G: 複数Task(Chat相当の非researchCapability・失敗・
  // 成功が混在)での順序維持を、実際のrunTasks()(commander.tsが内部で
  // 呼ぶ本番Executor関数そのもの)を通して検証する。decomposeTask()の
  // 既存パターンだけでは3種類の異なる結果を持つTaskを1回のuser入力から
  // 現実的に作れないため(COMPARE_PATTERN等は最大2 research Task)、
  // ここではTask[]を直接構築してrunTasks()へ渡す(commander.tsが
  // 呼ぶのと全く同じ関数、decomposeTask()の手前だけを省略している)。
  {
    const OK_CAPABILITY = "phase28-mock-chat-like";
    const FAIL_CAPABILITY = "phase28-mock-fail";

    registerCapability<{ query: string }, { answer: string }>(OK_CAPABILITY, async () => ({
      answer: "chat相当の完了",
    }));

    registerCapability<{ query: string }, { answer: string }>(FAIL_CAPABILITY, async () => {
      throw new Error("phase28 mock permanent failure");
    });

    const t1: Task = { id: "g1", description: "chat相当", status: "pending", assignedCapability: OK_CAPABILITY };
    const t2: Task = { id: "g2", description: "失敗するTask", status: "pending", assignedCapability: FAIL_CAPABILITY };
    const t3: Task = { id: "g3", description: "chat相当2", status: "pending", assignedCapability: OK_CAPABILITY };

    const core = createMockCoreCapability();
    const governor = createConcurrencyGovernor(resolveMaxAgents());
    const summaries = await runTasks([t1, t2, t3], core, {}, governor);

    // commander.tsが実際に行っているのと全く同じ1行
    // (summaries.map(evaluateTaskExecution))を、テストからも直接呼ぶ。
    const learningSignals = summaries.map((summary) => evaluateTaskExecution(summary));

    results.push(
      check(
        "[Case D/E/G] 複数Task混在(chat相当成功/失敗/chat相当成功) -> Task順序を維持してlearningSignalsが正しく生成される",
        summaries.map((s) => s.status).join(",") === "completed,failed,completed" &&
          learningSignals.join(",") === "successful_execution,permanent_failure,successful_execution",
        `statuses=${JSON.stringify(summaries.map((s) => s.status))}, signals=${JSON.stringify(learningSignals)}`
      )
    );
  }

  return summarize("learningSignals wiring (runOrchestration/runTasks)", results);

}
