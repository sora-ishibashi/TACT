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
import { run as runEmptyStateGreeting } from "./research/emptyStateGreeting.test";
import { run as runDetectAmbiguity } from "./ambiguity/detectAmbiguity.test";
import { run as runDecomposeTask } from "./decomposition/decomposeTask.test";
import { run as runFailureClassification } from "./retry/failureClassification.test";
import { run as runAggregator } from "./orchestrator/aggregator.test";
import { run as runEpisode } from "./orchestrator/episode.test";
import { run as runModelRouter } from "./orchestrator/modelRouter.test";
import { run as runTaskContext } from "./orchestrator/taskContext.test";
import { run as runExecutor } from "./orchestrator/executor.test";
import { run as runCapabilityInvocationDecoupling } from "./orchestrator/capabilityInvocationDecoupling.test";
import { run as runDeriveAnswerConfidence } from "./confidence/deriveAnswerConfidence.test";
import { run as runConfidenceExecutorWiring } from "./confidence/executorWiring.test";
import { run as runWorkTypes } from "./work/types.test";
import { run as runWorkMapping } from "./work/mapping.test";
import { run as runWorkStoreAuthorization } from "./work/storeAuthorization.test";
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
import { run as runCodeAgentAdapterHandoff } from "./agent/codeAgentAdapterHandoff.test";
import { run as runCodingTaskOrchestrator } from "./agent/codingTaskOrchestrator.test";
import { run as runCodingTaskReport } from "./agent/codingTaskReport.test";
import { run as runAttachmentContext } from "./agent/attachmentContext.test";
import { run as runListCodeTasksFilter } from "./codeAgent/listCodeTasksFilter.test";
import { run as runDocumentModelOps } from "./design/documentModelOps.test";
import { run as runPptxRoundtrip } from "./design/pptxRoundtrip.test";
import { run as runTactAttachmentPhase1 } from "./attachment/tactAttachmentPhase1.test";
import { run as runPdfAttachmentComposer } from "./research/pdfAttachmentComposer.test";
import { run as runArtifactPreview } from "./research/artifactPreview.test";
import { run as runContextSourceFiltering } from "./contextSource/filtering.test";
import { run as runContextSourceToEvidence } from "./contextSource/toEvidence.test";
import { run as runContextSourceBrowserAdapter } from "./contextSource/browserAdapter.test";
import { run as runContextSourceEntryTree } from "./contextSource/entryTree.test";
import { run as runContextSourceHandleStore } from "./contextSource/handleStore.test";
import { run as runContextSourceSearch } from "./contextSource/search.test";
import { run as runContextSourceContentIndex } from "./contextSource/contentIndex.test";
import { run as runContextSourceRead } from "./contextSource/read.test";
import { run as runContextSourceResolver } from "./contextSource/resolver.test";
import { run as runContextSourceWorkspaceResolverAdapter } from "./contextSource/workspaceResolverAdapter.test";
import { run as runContextSourceRequestValidation } from "./contextSource/requestValidation.test";
import { run as runResearchWorkspaceContextIntegration } from "./research/workspaceContextIntegration.test";
import { run as runResearchLocalWorkspacePreview } from "./research/localWorkspacePreview.test";
import { run as runBotBuildBotContext } from "./bot/buildBotContext.test";
import { run as runBotIdentityResolver } from "./bot/identityResolver.test";
import { run as runBotNotConnectedConnector } from "./bot/notConnectedConnector.test";
import { run as runBotReceiveBotMessage } from "./bot/receiveBotMessage.test";
import { run as runBotExecuteBotActions } from "./bot/executeBotActions.test";
import { run as runBotIdentityStore } from "./bot/identityStore.test";
import { run as runBotConversationConnector } from "./bot/conversationConnector.test";
import { run as runBotTrustedConversationTurn } from "./bot/trustedConversationTurn.test";

const suites: { name: string; run: () => Promise<{ pass: number; fail: number }> }[] = [
  { name: "intent/classifyIntent", run: runClassifyIntent },
  { name: "intent/additionalResearchIntent", run: runAdditionalResearchIntent },
  { name: "research/queryTopicContinuation", run: runQueryTopicContinuation },
  { name: "research/tableAwareResearch", run: runTableAwareResearch },
  { name: "research/queryCondensation", run: runQueryCondensation },
  { name: "research/candidateDiscovery", run: runCandidateDiscovery },
  { name: "research/emptyStateGreeting", run: runEmptyStateGreeting },
  { name: "ambiguity/detectAmbiguity", run: runDetectAmbiguity },
  { name: "decomposition/decomposeTask", run: runDecomposeTask },
  { name: "retry/failureClassification", run: runFailureClassification },
  { name: "orchestrator/aggregator", run: runAggregator },
  { name: "orchestrator/episode", run: runEpisode },
  { name: "orchestrator/modelRouter", run: runModelRouter },
  { name: "orchestrator/taskContext", run: runTaskContext },
  { name: "orchestrator/executor", run: runExecutor },
  { name: "orchestrator/capabilityInvocationDecoupling", run: runCapabilityInvocationDecoupling },
  { name: "confidence/deriveAnswerConfidence", run: runDeriveAnswerConfidence },
  { name: "confidence/executorWiring", run: runConfidenceExecutorWiring },
  { name: "work/types", run: runWorkTypes },
  { name: "work/mapping", run: runWorkMapping },
  { name: "work/storeAuthorization", run: runWorkStoreAuthorization },
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
  { name: "agent/codeAgentAdapterHandoff", run: runCodeAgentAdapterHandoff },
  { name: "agent/codingTaskOrchestrator", run: runCodingTaskOrchestrator },
  { name: "agent/codingTaskReport", run: runCodingTaskReport },
  { name: "agent/attachmentContext", run: runAttachmentContext },
  { name: "codeAgent/listCodeTasksFilter", run: runListCodeTasksFilter },
  { name: "design/documentModelOps", run: runDocumentModelOps },
  { name: "design/pptxRoundtrip", run: runPptxRoundtrip },
  { name: "attachment/tactAttachmentPhase1", run: runTactAttachmentPhase1 },
  { name: "research/pdfAttachmentComposer", run: runPdfAttachmentComposer },
  { name: "research/artifactPreview", run: runArtifactPreview },
  { name: "contextSource/filtering", run: runContextSourceFiltering },
  { name: "contextSource/toEvidence", run: runContextSourceToEvidence },
  { name: "contextSource/browserAdapter", run: runContextSourceBrowserAdapter },
  { name: "contextSource/entryTree", run: runContextSourceEntryTree },
  { name: "contextSource/handleStore", run: runContextSourceHandleStore },
  { name: "contextSource/search", run: runContextSourceSearch },
  { name: "contextSource/contentIndex", run: runContextSourceContentIndex },
  { name: "contextSource/read", run: runContextSourceRead },
  { name: "contextSource/resolver", run: runContextSourceResolver },
  { name: "contextSource/workspaceResolverAdapter", run: runContextSourceWorkspaceResolverAdapter },
  { name: "contextSource/requestValidation", run: runContextSourceRequestValidation },
  { name: "research/workspaceContextIntegration", run: runResearchWorkspaceContextIntegration },
  { name: "research/localWorkspacePreview", run: runResearchLocalWorkspacePreview },
  { name: "bot/buildBotContext", run: runBotBuildBotContext },
  { name: "bot/identityResolver", run: runBotIdentityResolver },
  { name: "bot/notConnectedConnector", run: runBotNotConnectedConnector },
  { name: "bot/receiveBotMessage", run: runBotReceiveBotMessage },
  { name: "bot/executeBotActions", run: runBotExecuteBotActions },
  { name: "bot/identityStore", run: runBotIdentityStore },
  { name: "bot/conversationConnector", run: runBotConversationConnector },
  { name: "bot/trustedConversationTurn", run: runBotTrustedConversationTurn },
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
