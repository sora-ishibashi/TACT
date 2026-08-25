// =========================
// TACT Evaluation Harness — runAll (Phase 20)
// =========================
//
// 目的: Phase 1〜19で蓄積したReality Testのうち、決定論的
// (Category A)またはMock-based(Category B)に検証できるものを
// 恒久的なRegression Suiteとして1コマンドで実行する。
//
// 絶対条件:
//   - LLM call = 0 / Search API call = 0(全TestFileがmock/pure
//     functionのみを使う。実LLM/実APIが必要なTestはここに含めない)
//   - 本番Architecture(Commander/Decomposer/Executor/Aggregator/
//     TaskContext/Memory/Episode/Intent Router/Ambiguity Detector/
//     Model Router/Capability Registry)を変更しない
//   - Jest/Vitest等の新しいtest frameworkは導入しない(npx tsxで
//     実行する、Phase1〜19が一貫して使ってきた方法をそのまま使う)
//
// 実行方法: npm test (package.jsonの"test"スクリプト経由)、または
// npx tsx tests/tact/runAll.ts
//
// dotenv/configを最初にimportする理由: core/llm/providers/openai.ts等が
// モジュール読み込み時(importした瞬間)にOpenAI SDKクライアントを
// 構築しており、OPENAI_API_KEYが未設定だとimportするだけで例外になる
// (実際にAPIを呼ぶかどうかとは無関係)。他のTestFileをimportする前に
// .envを読み込んでおく必要がある(ESMのimportは全て評価前に巻き上げ
// られるため、ここが実質的な最初の実行コード)。

import "dotenv/config";

import { run as runClassifyIntent } from "./intent/classifyIntent.test";
import { run as runAdditionalResearchIntent } from "./intent/additionalResearchIntent.test";
import { run as runQueryTopicContinuation } from "./research/queryTopicContinuation.test";
import { run as runTableAwareResearch } from "./research/tableAwareResearch.test";
import { run as runQueryCondensation } from "./research/queryCondensation.test";
import { run as runCandidateDiscovery } from "./research/candidateDiscovery.test";
import { run as runDetectAmbiguity } from "./ambiguity/detectAmbiguity.test";
import { run as runDecomposeTask } from "./decomposition/decomposeTask.test";
import { run as runFailureClassification } from "./retry/failureClassification.test";
import { run as runAggregator } from "./orchestrator/aggregator.test";
import { run as runEpisode } from "./orchestrator/episode.test";
import { run as runModelRouter } from "./orchestrator/modelRouter.test";
import { run as runTaskContext } from "./orchestrator/taskContext.test";
import { run as runExecutor } from "./orchestrator/executor.test";
import { run as runDeriveAnswerConfidence } from "./confidence/deriveAnswerConfidence.test";
import { run as runConfidenceExecutorWiring } from "./confidence/executorWiring.test";
import { run as runGenerateLLMAnswerRetry } from "./research/generateLLMAnswerRetry.test";
import { run as runEvaluateTaskExecution } from "./evaluation/evaluateTaskExecution.test";
import { run as runLearningSignalsWiring } from "./evaluation/learningSignalsWiring.test";
import { run as runProjectApiAuth } from "./project/projectApiAuth.test";
import { run as runOrchestrateRoute } from "./orchestrator/orchestrateRoute.test";
import { run as runMemoryCandidateBuilder } from "./orchestrator/memoryCandidateBuilder.test";
import { run as runLegacyKnowledgeFilter } from "./core/legacyKnowledgeFilter.test";
import { run as runVolatileKnowledgeExclusion } from "./core/volatileKnowledgeExclusion.test";
import { run as runAnswerabilityFreshnessSignal } from "./research/answerabilityFreshnessSignal.test";
import { run as runPublishedAtPropagation } from "./evidence/publishedAtPropagation.test";
import { run as runClarificationResubmit } from "./orchestrator/clarificationResubmit.test";
import { run as runClarificationPersistence } from "./conversation/clarification.test";
import { run as runTactConversationMapping } from "./conversation/tactConversationMapping.test";
import { run as runTactConversationApi } from "./conversation/tactConversationApi.test";
import { run as runTactConversationOrchestration } from "./conversation/tactConversationOrchestration.test";
import { run as runTactConversationClarificationAnswer } from "./conversation/tactConversationClarificationAnswer.test";
import { run as runTactConversationResearchCapability } from "./conversation/tactConversationResearchCapability.test";
import { run as runTactArtifactMutation } from "./artifact/tactArtifactMutation.test";
import { run as runTactArtifactBlocks } from "./artifact/tactArtifactBlocks.test";
import { run as runTactArtifactPhase77 } from "./artifact/tactArtifactPhase77.test";
import { run as runTactArtifactPhase78 } from "./artifact/tactArtifactPhase78.test";
import { run as runTactArtifactPhase79 } from "./artifact/tactArtifactPhase79.test";
import { run as runTactArtifactPhase80 } from "./artifact/tactArtifactPhase80.test";
import { run as runTactArtifactPhase82 } from "./artifact/tactArtifactPhase82.test";
import { run as runTactArtifactPhase83 } from "./artifact/tactArtifactPhase83.test";
import { run as runTactArtifactPhase85 } from "./artifact/tactArtifactPhase85.test";
import { run as runTactArtifactPhase91 } from "./artifact/tactArtifactPhase91.test";
import { run as runAgentHandoff } from "./agent/agentHandoff.test";
import { run as runListCodeTasksFilter } from "./codeAgent/listCodeTasksFilter.test";

const suites: { name: string; run: () => Promise<{ pass: number; fail: number }> }[] = [
  { name: "intent/classifyIntent", run: runClassifyIntent },
  { name: "intent/additionalResearchIntent", run: runAdditionalResearchIntent },
  { name: "research/queryTopicContinuation", run: runQueryTopicContinuation },
  { name: "research/tableAwareResearch", run: runTableAwareResearch },
  { name: "research/queryCondensation", run: runQueryCondensation },
  { name: "research/candidateDiscovery", run: runCandidateDiscovery },
  { name: "ambiguity/detectAmbiguity", run: runDetectAmbiguity },
  { name: "decomposition/decomposeTask", run: runDecomposeTask },
  { name: "retry/failureClassification", run: runFailureClassification },
  { name: "orchestrator/aggregator", run: runAggregator },
  { name: "orchestrator/episode", run: runEpisode },
  { name: "orchestrator/modelRouter", run: runModelRouter },
  { name: "orchestrator/taskContext", run: runTaskContext },
  { name: "orchestrator/executor", run: runExecutor },
  { name: "confidence/deriveAnswerConfidence", run: runDeriveAnswerConfidence },
  { name: "confidence/executorWiring", run: runConfidenceExecutorWiring },
  { name: "research/generateLLMAnswerRetry", run: runGenerateLLMAnswerRetry },
  { name: "evaluation/evaluateTaskExecution", run: runEvaluateTaskExecution },
  { name: "evaluation/learningSignalsWiring", run: runLearningSignalsWiring },
  { name: "project/projectApiAuth", run: runProjectApiAuth },
  { name: "orchestrator/orchestrateRoute", run: runOrchestrateRoute },
  { name: "orchestrator/memoryCandidateBuilder", run: runMemoryCandidateBuilder },
  { name: "core/legacyKnowledgeFilter", run: runLegacyKnowledgeFilter },
  { name: "core/volatileKnowledgeExclusion", run: runVolatileKnowledgeExclusion },
  { name: "research/answerabilityFreshnessSignal", run: runAnswerabilityFreshnessSignal },
  { name: "evidence/publishedAtPropagation", run: runPublishedAtPropagation },
  { name: "orchestrator/clarificationResubmit", run: runClarificationResubmit },
  { name: "conversation/clarificationPersistence", run: runClarificationPersistence },
  { name: "conversation/tactConversationMapping", run: runTactConversationMapping },
  { name: "conversation/tactConversationApi", run: runTactConversationApi },
  { name: "conversation/tactConversationOrchestration", run: runTactConversationOrchestration },
  { name: "conversation/tactConversationClarificationAnswer", run: runTactConversationClarificationAnswer },
  { name: "conversation/tactConversationResearchCapability", run: runTactConversationResearchCapability },
  { name: "artifact/tactArtifactMutation", run: runTactArtifactMutation },
  { name: "artifact/tactArtifactBlocks", run: runTactArtifactBlocks },
  { name: "artifact/tactArtifactPhase77", run: runTactArtifactPhase77 },
  { name: "artifact/tactArtifactPhase78", run: runTactArtifactPhase78 },
  { name: "artifact/tactArtifactPhase79", run: runTactArtifactPhase79 },
  { name: "artifact/tactArtifactPhase80", run: runTactArtifactPhase80 },
  { name: "artifact/tactArtifactPhase82", run: runTactArtifactPhase82 },
  { name: "artifact/tactArtifactPhase83", run: runTactArtifactPhase83 },
  { name: "artifact/tactArtifactPhase85", run: runTactArtifactPhase85 },
  { name: "artifact/tactArtifactPhase91", run: runTactArtifactPhase91 },
  { name: "agent/agentHandoff", run: runAgentHandoff },
  { name: "codeAgent/listCodeTasksFilter", run: runListCodeTasksFilter },
];

async function main() {

  console.log("=== TACT Evaluation Harness (Phase 20) ===");
  console.log("LLM call = 0 / Search API call = 0 が前提の決定論的/mock-based Regression Suite\n");

  let totalPass = 0;
  let totalFail = 0;

  for (const suite of suites) {

    console.log(`--- ${suite.name} ---`);
    const { pass, fail } = await suite.run();
    totalPass += pass;
    totalFail += fail;
    console.log("");

  }

  console.log("=== Summary ===");
  console.log(`${totalPass} passed, ${totalFail} failed (${suites.length} suites)`);

  if (totalFail > 0) {
    process.exitCode = 1;
  }

}

main();
