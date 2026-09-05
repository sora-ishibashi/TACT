import { invokeCapability } from "../tact-core/capabilities/registry";
import type { ResearchParams, ResearchResult } from "./types";
import type { CoreCapability } from "../tact-core/types";
import { deriveAnswerConfidence } from "../tact-orchestrator/confidence";
import type {
  CapabilityInvocationRequest,
  CapabilityInvocationResult,
} from "../tact-orchestrator/types";

// =========================
// TACT Research — Capability Adapter
// (Architecture Migration Phase A: Capability Invocation Decoupling)
// =========================
//
// 目的: core/tact-orchestrator/executor.tsが「researchという名前の
// Capabilityを呼ぶ場合だけResearchParamsの内部構造(options.
// llmProvider/llmModel/tableSchema等)を知っている」という結合を
// 解消する。executor.tsは"research"の場合、汎用のinvokeCapability()
// を直接呼ぶ代わりにこのrunResearchCapability()を呼ぶ——
// Orchestrator語彙(CapabilityInvocationRequest/Result、
// core/tact-orchestrator/types.ts)⇄ResearchParams/ResearchResultの
// 変換だけを行う薄いAdapter。
//
// 重要(既存テスト互換性): "research"としてCapability Registryへ
// 登録される実体はcore/tact-bootstrap.tsが従来通りrunResearch()を
// 登録する(変更していない)。runResearchCapability()は自らrunResearch()
// を直接importして呼ぶのではなく、invokeCapability("research", ...)
// 経由でRegistryを引く——これにより、既存の多数のtest
// (registerCapability<ResearchParams, ResearchResult>("research", mock)
// で"research"を上書きするCategory Bのtest、Phase20〜93で確立済みの
// Harness pattern)が、Adapter導入後も変更無しでそのまま機能する
// (mockが返すResearchResultも、このAdapterのmapResearchResult
// ToCapabilityResult()で正しく解釈される)。
//
// runResearch()自体の実装(Answerability判定・Search・Context
// Assembly・LLM呼び出し)は一切変更しない(絶対条件: Researchの
// 挙動を変えない)。
//
// 依存方向についての補足: このファイルはcore/tact-orchestrator/
// confidence.ts・core/tact-orchestrator/types.tsをimportする。
// core/tact-orchestrator/types.tsは型定義のみ(実行時import無し)、
// confidence.tsの実行時importも無い(ResearchResultのtype-only
// importのみ)ため、実行時循環参照は発生しない。「Orchestratorの
// 語彙へ変換するAdapterは、変換先の語彙(Orchestrator側の型・純粋
// 関数)を知ってよい」という、Phase Aで採用したAdapterパターンの
// 一部であり、core/tact-research本体(runResearch.ts等)がOrchestrator
// へ依存するようになるわけではない。

// =========================
// ResearchResult -> CapabilityInvocationResult
// =========================
//
// 従来core/tact-orchestrator/executor.tsのexecuteTask()内(research
// 分岐)に存在していた変換ロジックをそのまま移設した(挙動は一切
// 変更していない)。pure関数としてexportし、実LLM/Search無しで
// テストできるようにする(Phase20のisTemporaryFailure()等と同じ
// 理由)。
export function mapResearchResultToCapabilityResult(
  result: ResearchResult
): CapabilityInvocationResult {

  return {

    success: result.success,

    output: result.success ? result.answer : undefined,

    errorMessage: result.success ? undefined : result.errorMessage,

    memoryUsed: buildMemoryReferencesFromResearchResult(result),

    // Phase 5: memoryCandidateBuilder.tsが「Coreに既にあった情報の
    // 再掲か、Web検索で得た新しい情報か」を区別するために使う。
    researchExecutionMode: result.metadata.executionMode,

    evidenceCount: result.evidence.length,

    // Phase76(Repository Evidence): TACT Artifact Mutation
    // (core/tact-conversation/orchestration.ts)がEvidence Blockを
    // 構築できるよう、result.evidenceをそのまま透過する。
    evidence: result.evidence,

    keyFindings: result.keyFindings,

    // Phase 21: confidence.tsのderiveAnswerConfidence()(純粋関数、
    // 新しいLLM呼び出し無し)。result.success===falseの場合は
    // undefinedを返す(Execution confidenceとの混同を避ける)。
    answerConfidence: deriveAnswerConfidence(result),

    uncertaintyNote: result.uncertainty,

    presentations: result.presentations,

    presentationWarnings: result.presentationWarnings,

    presentationRequested: result.presentationRequested,

    frameworkArtifacts: result.frameworkArtifacts,

    frameworkArtifactRequested: result.frameworkArtifactRequested,

    analysisArtifactPlan: result.analysisArtifactPlan,

    cortexArtifactPlanRequested: result.cortexArtifactPlanRequested,

  };

}

// core/tact-orchestrator/executor.tsに存在していた
// buildMemoryReferencesFromResearch()をそのまま移設した(挙動は
// 変更していない)。STEP208時点でPersistent CoreはUser Scopeのみの
// ため、scopeは常に"user"として扱う。
function buildMemoryReferencesFromResearchResult(
  result: ResearchResult
): NonNullable<CapabilityInvocationResult["memoryUsed"]> {

  const refs: NonNullable<CapabilityInvocationResult["memoryUsed"]> = [];

  for (const id of result.metadata.usedKnowledgeIds) {
    refs.push({ kind: "knowledge", id, scope: "user" });
  }

  for (const id of result.metadata.usedMemoryIds) {
    refs.push({ kind: "memory", id, scope: "user" });
  }

  for (const id of result.metadata.usedExampleIds) {
    refs.push({ kind: "example", id, scope: "user" });
  }

  return refs;

}

// =========================
// CapabilityInvocationRequest -> ResearchParams
// =========================
//
// 従来executor.tsが構築していた値(query/context/attachmentEvidence/
// workspaceEvidence/options.{llmProvider,llmModel,tableSchema})と
// 完全に同じ形を組み立てる(挙動は一切変更していない)。
function toResearchParams(request: CapabilityInvocationRequest): ResearchParams {

  return {

    query: request.query,

    context: request.context,

    attachmentEvidence: request.attachmentEvidence,

    workspaceEvidence: request.workspaceEvidence,

    options: {
      llmProvider: request.provider,
      llmModel: request.model,
      tableSchema: request.tableSchema,
    },

  };

}

// =========================
// runResearchCapability
// =========================
//
// core/tact-orchestrator/executor.tsが"research"の場合に呼ぶ実体。
// executor.tsはこの関数のシグネチャ(CapabilityInvocationRequest ->
// CapabilityInvocationResult)だけを知り、ResearchParams/
// ResearchResultを一切importしない。invokeCapability("research", ...)
// 経由でCapability Registryを引くため、Capability Registryが依然
// として"research"の実行境界である(絶対条件: Registryを迂回しない。
// "research"自体はcore/tact-bootstrap.tsが従来通りrunResearch()を
// 登録する——変更していない)。
export async function runResearchCapability(
  request: CapabilityInvocationRequest,
  core: CoreCapability
): Promise<CapabilityInvocationResult> {

  const result = await invokeCapability<ResearchParams, ResearchResult>(
    "research",
    toResearchParams(request),
    core
  );

  return mapResearchResultToCapabilityResult(result);

}
