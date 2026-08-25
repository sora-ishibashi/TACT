// =========================
// tact-conversation Research Capability Connection Regression (Phase 69)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsのderiveExecutionCapability()
// (純粋関数)、およびrunOrchestration()実行結果からのplanConversationTurn()
// を通じた"research" capability導出(Phase67/68と同じmock capability
// pattern、実DB・実LLM・実Search APIアクセスなし)。
//
// Repository Evidence(Phase69完了報告に詳細記載): core/tact-bootstrap.ts
// はregisterCapability("research", runResearch)のみを行い(chat/coreは
// Capability Registry未登録)、core/tact-orchestrator/decomposer.tsは
// classifyIntent()の判定がintent="research"の場合のみ
// Task.assignedCapability="research"を設定する。executor.tsは
// task.assignedCapability==="research"の場合のみinvokeCapability("research",
// ...)を呼び、TaskExecutionSummary.capability="research"を設定する。
// これにより、Conversation → Orchestrator → Research
// の接続はPhase67時点で既にfunction-call経由(HTTP不使用)で確立
// 済みであり、Phase69の実装差分はExecutionRecord.capabilityへその
// 事実を正しく反映すること(Phase67時点ではcapabilityが常に
// "orchestrator"に固定されていた)に限定される。
//
// 環境制約(Phase66〜68と同一): 実DB書き込み(RLS)を伴うE2Eはnpm testに
// 含めない。実Research Provider(LLM API/Search API)も一切呼ばない
// ——mock capability registration(既存Harness pattern、Phase20〜28・
// Phase33・Phase67・Phase68で一貫して使用)のみを使う。API/LLM料金は
// 一切発生しない。

import "dotenv/config";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { runOrchestration } from "../../../core/tact-orchestrator";
import { decomposeTask } from "../../../core/tact-orchestrator/decomposer";
import type { ResearchResult, ResearchParams, ResearchMetadata } from "../../../core/tact-research/types";
import type { TaskExecutionSummary } from "../../../core/tact-orchestrator";
import {
  deriveExecutionCapability,
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

  // ---- deriveExecutionCapability(): pure ----

  results.push(
    check(
      "[Test1] 全Taskがcapability='research' -> 'research'",
      deriveExecutionCapability([
        makeTaskSummary({ capability: "research" }),
      ]) === "research"
    )
  );

  results.push(
    check(
      "[Test2] 複数Taskが全てcapability='research'(比較パターン等) -> 'research'",
      deriveExecutionCapability([
        makeTaskSummary({ taskId: "t1", capability: "research" }),
        makeTaskSummary({ taskId: "t2", capability: "research" }),
      ]) === "research"
    )
  );

  results.push(
    check(
      "[Test3] capability=undefined(chat fallback、Repository Evidence通り) -> 'orchestrator'(誤ってresearchにならない)",
      deriveExecutionCapability([
        makeTaskSummary({ capability: undefined }),
      ]) === "orchestrator"
    )
  );

  results.push(
    check(
      "[Test4] research/chatが混在(逐次依存パターン等) -> 'orchestrator'(新しい'mixed'値を推測で作らない)",
      deriveExecutionCapability([
        makeTaskSummary({ taskId: "t1", capability: "research" }),
        makeTaskSummary({ taskId: "t2", capability: undefined }),
      ]) === "orchestrator"
    )
  );

  results.push(
    check(
      "[Test5] tasks=[] -> 'orchestrator'(安全側)",
      deriveExecutionCapability([]) === "orchestrator"
    )
  );

  results.push(
    check(
      "[Test6] capability='design'(research以外の登録済みCapability) -> 'orchestrator'",
      deriveExecutionCapability([
        makeTaskSummary({ capability: "design" }),
      ]) === "orchestrator"
    )
  );

  // ---- A/B/D: Conversation -> Orchestrator -> Research routing(mock capability経由) ----

  {
    let receivedQuery: string | undefined;

    registerCapability<ResearchParams, ResearchResult>("research", async (params) => {
      receivedQuery = params.query;
      return {
        success: true,
        answer: "トヨタの主な競合はデンソー・アイシン等です。",
        evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
        metadata: makeMetadata(),
      };
    });

    const input = "トヨタの競合について調べて";
    const result = await runOrchestration({ input });
    const plan = planConversationTurn(result);

    results.push(
      check(
        "[TestA/B/D] Research-intent入力 -> Research internal function(mock)へ到達し、plan.capability='research'",
        receivedQuery === input &&
          plan.kind === "normal" &&
          plan.capability === "research" &&
          plan.status === "completed",
        `receivedQuery=${receivedQuery}, plan=${JSON.stringify(plan)}`
      )
    );
  }

  // ---- C: Research resultがAssistant Messageへ戻る(plan.answerとして) ----

  {
    registerCapability<ResearchParams, ResearchResult>("research", async () => ({
      success: true,
      answer: "研究結果の回答本文",
      evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
      metadata: makeMetadata(),
    }));

    const result = await runOrchestration({ input: "中京大学について調べて" });
    const plan = planConversationTurn(result);

    results.push(
      check(
        "[TestC] Research resultのanswerがplan.answerとしてそのまま返る(Assistant Message content化される値)",
        plan.kind === "normal" && plan.answer === "研究結果の回答本文",
        `plan=${JSON.stringify(plan)}`
      )
    );
  }

  // ---- E/F/G: 成功/失敗時のstatus・capability ----

  {
    registerCapability<ResearchParams, ResearchResult>("research", async () => ({
      success: false,
      answer: "",
      evidence: [],
      metadata: makeMetadata(),
      errorMessage: "search failed",
    }));

    const result = await runOrchestration({ input: "存在しない架空企業について調べて" });
    const plan = planConversationTurn(result);

    results.push(
      check(
        "[TestF] Research失敗(success:false) -> plan.status='failed'、capability='research'は維持(routing自体は正しく行われた証拠)",
        plan.kind === "normal" && plan.status === "failed" && plan.capability === "research",
        `plan=${JSON.stringify(plan)}`
      )
    );

    results.push(
      check(
        "[TestG] Research失敗時もplan.answerが空文字ではない(aggregateResults()の既存失敗説明文、Assistant Messageとして保存される値)",
        plan.kind === "normal" && plan.answer.length > 0,
        `answer=${plan.kind === "normal" ? plan.answer : "(n/a)"}`
      )
    );
  }

  // ---- I: Chat-intent入力がResearchへ誤ってroutingされない ----
  //
  // 絶対条件(Section14「API料金が発生するテストを自動test suiteへ
  // 組み込まない」): runOrchestration()にchat-intent入力をそのまま
  // 渡すと、assignedCapability=undefinedのTaskはexecutor.tsの
  // Chat Handler(core/tact-intent/chatHandler.ts、実LLM呼び出し、
  // Capability Registry・mock機構の対象外)へ実際に到達してしまう
  // (research用のmock capability登録では防げない、実装時に実測で
  // 確認した)。そのため、ここではdecomposeTask()(決定論的、
  // classifyIntent()も含めLLM/API呼び出み0件、
  // tests/tact/decomposition/decomposeTask.test.ts、Phase20と同じ
  // 既存Pattern)を直接呼び、"研究への実行"に到達する前の
  // ルーティング決定(Task.assignedCapability)だけを検証する。
  // Task.assignedCapabilityがundefinedならderiveExecutionCapability()
  // (Test3で検証済み)が'orchestrator'を返すことは既に保証されている
  // ため、これで実行コストゼロのままTestIの意図を満たせる。

  {
    const tasks = decomposeTask({ input: "今日は疲れた" });

    results.push(
      check(
        "[TestI] Chat-intent入力 -> decomposeTask()がassignedCapability='research'を設定しない(Research capabilityへ実行が到達しない)",
        tasks.every((task) => task.assignedCapability !== "research"),
        `tasks=${JSON.stringify(tasks.map((t) => ({ description: t.description, assignedCapability: t.assignedCapability })))}`
      )
    );
  }

  // ---- H: Clarification -> Research Answer flow(mock capability経由、Phase68 flowの延長) ----

  {
    let researchCalled = false;

    registerCapability<ResearchParams, ResearchResult>("research", async (params) => {
      researchCalled = true;
      return {
        success: true,
        answer: `再実行結果: ${params.query}`,
        evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
        metadata: makeMetadata(),
      };
    });

    // Step1: 曖昧な入力 -> Clarification(Research capabilityは未実行)
    const firstResult = await runOrchestration({ input: "調べて" });
    const firstPlan = planConversationTurn(firstResult);
    // Step2実行前の時点でresearchCalledを確定させる(Step2自体が
    // researchCalledをtrueにするため、Step2より後に読むと初回時点の
    // 状態を正しく検証できない)。
    const researchCalledAfterFirstStep = researchCalled;

    // Step2: 補足を結合した再実行入力 -> Research capability(mock)経由で解決される
    const resendInput = "調べて\n(補足: 「何について調べればいいですか?」への回答: トヨタの競合について)";
    const secondResult = await runOrchestration({ input: resendInput });
    const secondPlan = planConversationTurn(secondResult);

    results.push(
      check(
        "[TestH] Clarification -> Research Answer flow: 初回はresearch未実行、補足結合後の再実行でresearchへ到達しcapability='research'",
        firstPlan.kind === "clarification" &&
          !researchCalledAfterFirstStep &&
          secondPlan.kind === "normal" &&
          secondPlan.capability === "research",
        `firstPlan=${JSON.stringify(firstPlan)}, secondPlan=${JSON.stringify(secondPlan)}`
      )
    );

    results.push(
      check(
        "[TestH-2] 再実行後、researchCalled=true(mock research capabilityへ実際に到達した)",
        researchCalled
      )
    );

  }

  return summarize("tact-conversation research capability connection (Phase 69)", results);

}
