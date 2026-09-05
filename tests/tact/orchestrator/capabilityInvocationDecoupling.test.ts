// =========================
// Architecture Migration Phase A — Capability Invocation Decoupling
// Regression
// =========================
//
// 対象: core/tact-orchestrator/executor.ts の executeTask()。
// 以前存在した`if (task.assignedCapability === "research")`という
// 分岐の中にあった「ResearchParamsの組み立て」「ResearchResultの
// フィールド単位の解釈」がexecutor.tsから撤廃され、
// core/tact-research/capabilityAdapter.tsのrunResearchCapability()へ
// 移設されたこと、およびCapability名に関わらず同じRequest構築・
// 同じResult転記ロジックが使われることを検証する。
//
// 重要: "research"としてCapability Registryへ登録される実体は
// 従来通りrunResearch()自身のまま変更していない(既存の多数のtest、
// registerCapability<ResearchParams, ResearchResult>("research", mock)
// で"research"を上書きするCategory B Harness、Phase20〜93で確立済み、
// が変更無しでそのまま機能することを優先した設計、core/tact-bootstrap.ts
// 参照)。このためこのtestでも、"research"を上書きするmockは既存と
// 同じくResearchParams -> ResearchResultの契約で登録する。
//
// Category B(Mock-based Evaluation)。実LLM/Search API呼び出みは
// 一切発生しない。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { createMockCoreCapability } from "../../../core/tact-core/mockCoreCapability";
import { executeTask } from "../../../core/tact-orchestrator/executor";
import { runDesign } from "../../../core/tact-design";
import type { Task } from "../../../core/tact-orchestrator/task";
import type {
  CapabilityInvocationRequest,
  CapabilityInvocationResult,
} from "../../../core/tact-orchestrator/types";
import type { ResearchParams, ResearchResult, ResearchMetadata } from "../../../core/tact-research/types";
import { LLMProviderError } from "../../../core/llm/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeTask(overrides: Partial<Task>): Task {
  return { id: crypto.randomUUID(), description: "テスト", status: "pending", ...overrides };
}

const emptyTaskContext = {
  task: undefined as unknown as Task,
  coreContext: { knowledge: [], memories: [], examples: [], recentExecutions: [] },
  memoryReferences: [],
  dependencyResults: [],
};

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
    requirementCount: 0,
    coveredRequirementCount: 0,
    partialRequirementCount: 0,
    missingRequirementCount: 0,
    gapQueries: [],
    safetyDowngradeCount: 0,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];
  const core = createMockCoreCapability();

  // ---- [静的確認] executor.tsはResearchParams/ResearchResult(Research
  // の公開型)を一切importしていない(ResearchParams/ResearchResultの
  // 内部構造をOrchestratorが知り続けない、という絶対条件のコード上の
  // 証跡)。"research"の場合に呼ぶrunResearchCapability()自体(関数)の
  // importは許容する(Adapter呼び出し自体はexecutor.tsの責務)。 ----
  {
    const source = readFileSync(
      join(__dirname, "../../../core/tact-orchestrator/executor.ts"),
      "utf-8"
    );

    // import文だけを対象にする(コメント中の説明的な言及は対象外)。
    // "../tact-research/capabilityAdapter"(関数のみ)のimportは許容し、
    // ResearchParams/ResearchResultの定義元である"../tact-research/types"
    // ・barrel("../tact-research")からのimportが無いことを確認する。
    const importLines = source.match(/^import[\s\S]*?from\s+"[^"]+";/gm) ?? [];

    results.push(
      check(
        "[Phase A] executor.tsはtact-research/types(ResearchParams/ResearchResultの定義元)を一切importしていない",
        importLines.every(
          (line) =>
            !line.includes('"../tact-research/types"') &&
            !/from\s+"\.\.\/tact-research"/.test(line)
        )
      )
    );
  }

  // ---- research-via-registry: "research"へ登録された、既存契約
  // (ResearchParams -> ResearchResult)のmockが、core/tact-research/
  // capabilityAdapter.tsのrunResearchCapability()経由で正しく
  // TaskExecutionSummaryへ変換される ----
  {
    let receivedParams: ResearchParams | undefined;

    registerCapability<ResearchParams, ResearchResult>("research", async (params) => {
      receivedParams = params;
      return {
        success: true,
        answer: "研究結果の回答",
        evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
        metadata: makeMetadata(),
      };
    });

    const task = makeTask({ assignedCapability: "research", tableSchema: { columns: ["a"] } });
    const summary = await executeTask(task, core, emptyTaskContext);

    results.push(
      check(
        "[research-via-registry] Adapter経由でResearchParamsを受け取り、TaskExecutionSummaryへ正しく反映される",
        summary.status === "completed" &&
          summary.capability === "research" &&
          summary.output === "研究結果の回答" &&
          summary.evidenceCount === 1 &&
          summary.answerConfidence === "supported" &&
          receivedParams?.query === "テスト" &&
          receivedParams?.options?.tableSchema?.columns[0] === "a"
      )
    );
  }

  // ---- arbitrary-registered-capability-by-name: "research"という
  // 名前で無い、Orchestrator語彙(successフィールド)を返すCapabilityも
  // 全く同じ経路で正しく扱われる(Capability名による特別扱いが
  // 汎用経路には無いことの確認) ----
  {
    registerCapability<CapabilityInvocationRequest, CapabilityInvocationResult>(
      "phase-a-arbitrary-capability",
      async () => ({ success: true, output: "任意Capabilityの結果" })
    );

    const task = makeTask({ assignedCapability: "phase-a-arbitrary-capability" });
    const summary = await executeTask(task, core, emptyTaskContext);

    results.push(
      check(
        "[arbitrary-registered-capability-by-name] research以外の名前でも同じ経路で正しく反映される",
        summary.status === "completed" &&
          summary.capability === "phase-a-arbitrary-capability" &&
          summary.output === "任意Capabilityの結果"
      )
    );
  }

  // ---- unknown-capability-explicit-error: 未登録のCapability名は
  // 例外をOrchestrator全体へ伝播させず、status:"failed"として
  // 明示的なerrorメッセージを返す ----
  {
    const task = makeTask({ assignedCapability: "phase-a-unregistered-capability" });
    const summary = await executeTask(task, core, emptyTaskContext);

    results.push(
      check(
        "[unknown-capability-explicit-error] 未登録Capability -> status=failed、理由を含むerror",
        summary.status === "failed" &&
          typeof summary.error === "string" &&
          summary.error.includes("phase-a-unregistered-capability")
      )
    );
  }

  // ---- capability-failure-safely-reflected: Research Adapterが
  // success:falseを返す場合(例外を投げない)、status:"failed"・error
  // へ正しく反映される ----
  {
    registerCapability<ResearchParams, ResearchResult>("research", async () => ({
      success: false,
      answer: "",
      evidence: [],
      metadata: makeMetadata(),
      errorMessage: "mock research failure",
    }));

    const task = makeTask({ assignedCapability: "research" });
    const summary = await executeTask(task, core, emptyTaskContext);

    results.push(
      check(
        "[capability-failure-safely-reflected] success:false -> status=failed、errorMessageをerrorへ反映",
        summary.status === "failed" && summary.error === "mock research failure"
      )
    );
  }

  // ---- research-retry-exempt: "research"はSearch+LLMの複数ステップ
  // パイプラインであるため、一時的失敗でもExecutor側でRetryしない
  // (絶対条件: 「一時的失敗1回につき最大+1 call」を満たすため) ----
  {
    let callCount = 0;

    registerCapability<ResearchParams, ResearchResult>("research", async () => {
      callCount++;
      throw new LLMProviderError("openai", "network_error", "mock temporary failure");
    });

    const task = makeTask({ assignedCapability: "research" });
    const summary = await executeTask(task, core, emptyTaskContext);

    results.push(
      check(
        "[research-retry-exempt] research経路は一時的失敗でも1回しか呼ばれない(status=failed)",
        callCount === 1 && summary.status === "failed"
      )
    );
  }

  // ---- generic-capability-retried-once: research以外のCapabilityは
  // 既存(Phase19〜)通り、一時的失敗(LLMProviderError)を1回だけRetryする ----
  {
    let callCount = 0;

    registerCapability<CapabilityInvocationRequest, CapabilityInvocationResult>(
      "phase-a-retry-capability",
      async () => {
        callCount++;
        if (callCount === 1) {
          throw new LLMProviderError("openai", "network_error", "mock temporary failure");
        }
        return { success: true, output: "retry後に成功" };
      }
    );

    const task = makeTask({ assignedCapability: "phase-a-retry-capability" });
    const summary = await executeTask(task, core, emptyTaskContext);

    results.push(
      check(
        "[generic-capability-retried-once] research以外は一時的失敗を1回Retryして成功する",
        callCount === 2 && summary.status === "completed" && summary.retried === true
      )
    );
  }

  // ---- design-mock-callable: "design"(既存の登録、Phase Aで変更して
  // いない)も、Capability名決め打ちの分岐無しに引き続き例外を投げずに
  // 呼び出せる(Design自体の実装は今回のPhaseの対象外) ----
  {
    registerCapability("design", runDesign);

    const task = makeTask({ assignedCapability: "design" });
    const summary = await executeTask(task, core, emptyTaskContext);

    results.push(
      check(
        "[design-mock-callable] designも同じ経路で例外を投げずに呼び出せる",
        summary.status === "completed" || summary.status === "failed"
      )
    );
  }

  return summarize("orchestrator/capabilityInvocationDecoupling", results);

}
