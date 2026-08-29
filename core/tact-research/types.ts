// =========================
// TACT Research — Public Types (STEP176/177/180/184/185)
// =========================
//
// 重要(STEP176絶対条件5): 外部公開APIにAgent型(core/agents/types.ts
// のAgent/AgentId)を一切露出しない。呼び出し元は「researchという
// 能力」だけを意識すればよく、内部でresearcher/analyst/writer/
// queryBuilderのどれを使うか(あるいは使わないか)はTACT Research側が
// 決める。
//
// STEP180: 内部実装をmock(STEP176/177)から、
// Core Retrieval → Answerability判定 → (Core-onlyならCODEで即答/
// 不足ならWeb Research → Evidence Pipeline) → Context Assembly →
// LLM最大1回、という実処理へ置き換えた。Legacy Agent
// (core/agents/*)・Legacy Workflow(core/workflow/*・core/planner/*)は
// 依然として一切呼び出していない。
//
// STEP184: ResearchMetadataを観測性・コスト計測基盤として整理した。
// STEP180で追加した`llmCalls`(「成功したかどうか」の事後的な2値
// フラグでしかなく、STEP181/182で「実際には1回試行したのに0と
// 記録される」問題が確認された)を廃止し、
// llmAttempts/llmSuccesses/llmFailures/llmFailureReasonという、
// 試行と結果を分離した構造へ置き換えた。他モジュールから
// `metadata.llmCalls`を参照している箇所が無いことを事前に確認済み
// (core/tact-research/配下にのみ存在していたフィールドだったため、
// 破壊的変更にはならない)。

import type { CoreContext, CoreMemory, KnowledgeItem, Example } from "../tact-core";
import type { LLMProviderFailureReason } from "../llm/types";
import type { SearchProviderAttempt } from "../tools/search/searchWithFallback";
// STEP193: core/llm/types.tsのLLMRequest.providerが既に使っている型を
// そのまま再利用する(新しいProvider抽象を作らない)。Legacy Agent型
// (core/agents/types.tsのAgent/AgentId)ではなく、core/agent/types.ts
// (単数形、core/llmが依存する側)のProvider("openai"|"gemini"|"claude")
// のみを再利用する。
import type { Provider } from "../agent/types";
import type { AttachmentEvidence } from "../tact-attachment/types";
// LW-P3: Local Workspace(core/tact-context-source/)由来のEvidence。
// AttachmentEvidenceとは意図的に別の型として扱う(Attachment
// pipeline/DBへ統合しない、Section6)。core/tact-context-source/
// localWorkspace/types.tsはDOM/Browser API非依存のpure typeのみを
// 持つため、server側のこのファイルからimportしても安全(実際に
// FileSystemHandle等を扱うbrowserAdapter.tsはimportしない)。
import type { LocalWorkspaceEvidence } from "../tact-context-source/localWorkspace/types";
import type { ResearchAnalysis } from "../tact-analysis/research/types";
import type { ValidationIssue } from "../tact-analysis/types";
import type { ResearchPresentation } from "../tact-analysis/presentation/types";
import type { ResearchFrameworkAnalysis } from "../tact-analysis/framework/types";
import type { ResearchFrameworkArtifact } from "../tact-analysis/framework/types";
import type { CortexAnalysisPipelineResult } from "../tact-analysis/pipeline";
import type { AnalysisArtifactPlan } from "../tact-analysis/composition";

export interface ResearchOptions {

  // 将来の検索深度・件数調整等の差し込み口。STEP180からWeb Research
  // 経路のEvidence件数上限(performWebResearchのmaxEvidence)として
  // 実際に利用している。
  maxResults?: number;

  // STEP193: LLM Providerを明示的に指定するための差し込み口。省略時は
  // 既存契約どおりOpenAIを使う(llmAnswer.tsのデフォルト引数)。
  // Research層はここでProvider固有の分岐を書かず、値をそのまま
  // core/llmへ受け渡すだけ(絶対条件3)。
  llmProvider?: Provider;

  // Phase 7(TACT Orchestrator Model Routing)で追加。llmProviderと同じ
  // 位置づけの差し込み口で、具体的なmodel名を明示するためのもの。
  // 省略時は既存契約どおり、各Provider実装側の既定モデル
  // (core/llm/providers/openai.tsの"gpt-4o-mini"等)を使う(既存挙動を
  // 変えない)。Research層はここでもmodel固有の分岐を書かず、値を
  // そのままcore/llmへ受け渡すだけ(llmProviderと同じ絶対条件3)。
  llmModel?: string;

  // Phase90(Structured Research Dataset Section4〜6): Table要求を
  // 事前検知できた場合の列構成・要求件数。設定されている場合、
  // assembleResearchContext()(contextAssembly.ts)がRESEARCH_LLM_
  // SYSTEM_PROMPTへ「指定した列・件数で構造化して回答せよ」という
  // 追加指示を注入する(新しいLLM呼び出しは発生しない、既存の1回の
  // LLM呼び出しのPromptを変えるだけ)。省略時は既存(Phase1〜89)と
  // 完全に同じPrompt・挙動になる。
  tableSchema?: {
    columns: string[];
    requestedRowCount?: number;
  };

}

export interface ResearchParams {

  query: string;

  // 呼び出し元が事前にCoreCapability.loadContext()で取得済みの
  // CoreContext(knowledge/memories/examplesを含む)をそのまま渡す。
  // Research自身はCoreへ「取得」の問い合わせを行わず、渡された
  // contextを読むだけ(STEP176絶対条件3のステップ2/3に対応)。
  context: CoreContext;

  /** Per-turn user-file evidence resolved by the Conversation boundary. */
  attachmentEvidence?: AttachmentEvidence[];

  // LW-P3: client-side Workspace Context Resolver(core/tact-context-source/
  // localWorkspace/resolver.ts)が既にbound済みのLocal Workspace
  // Evidence。attachmentEvidenceと同じく、Conversation boundary
  // (app/api/tact/tact-conversations/route.ts)がserver側validation
  // 通過後に詰める。AttachmentEvidenceへは統合しない(Section6)。
  workspaceEvidence?: LocalWorkspaceEvidence[];

  options?: ResearchOptions;

}

export interface ResearchEvidenceItem {

  // STEP195: core/context/types.tsのEvidence.idをそのまま引き継ぐ。
  // 以前はclaim/source/confidenceのみを公開しており、LLMが返した
  // evidenceIds(validateEvidenceIds()通過後の値)と最終
  // ResearchResult.evidenceとの対応関係が、ここでidが失われることに
  // より外部から追跡不能になっていた(STEP195で発見)。Evidence本文
  // (Evidence.evidence、Researcher形式のJSON文字列)は引き続き公開
  // しない(レスポンスサイズ・既存設計を踏まえた最小変更)が、
  // idとsource(出典URL)があれば、「どのEvidenceを根拠にしたか」の
  // 監査と、必要であればsource URL経由での本文再確認が可能になる。
  id: string;

  claim: string;

  source?: string;

  sourceType?: string;

  confidence: "low" | "medium" | "high";

  // STEP198: STEP197調査(候補E)を踏まえ、sourceURLが将来切れた場合
  // でも「LLMが何を根拠として引用したか」を人間が確認できる程度の、
  // Evidence本文からの短い抜粋(最大500文字程度、単純な文字列切り
  // 出し。要約LLMは使わない)。Evidence全文ではない。coreOnlyAnswer.ts
  // (core-only経路、LLM 0回)のようにEvidence本文自体が存在しない
  // 経路では引き続きundefined(省略可能)のまま。
  snippet?: string;

}

// STEP180: どの経路で回答したかを追跡する。
// "core-only" = LLM 0回。CoreのKnowledge/Memoryのみで回答した
//   (assessAnswerability()がcanAnswerFromCoreOnly=trueと判定した場合)。
// "web-research" = LLM最大1回。Web Researchを実施し、Evidenceを
//   Context Assemblyへ渡した上でLLMに統合・分析・回答生成させた場合。
export type ResearchExecutionMode = "core-only" | "web-research";

// =========================
// LLM Failure Reason (STEP184)
// =========================
//
// 既存のcore/llm/types.tsのLLMProviderFailureReason(Provider API
// 呼び出し自体の失敗理由: quota_exceeded/authentication_failed/
// rate_limited/invalid_request/network_error/unknown_error)を
// そのまま合併する(STEP184絶対条件: 既存のエラー体系を無理に
// 二重化しない)。これに、Provider呼び出しには成功したが、その後の
// 処理でResearch側が失敗と判断した2種類の理由だけを追加する。
export type ResearchLLMFailureReason =
  | LLMProviderFailureReason
  | "response_parse_error"  // LLM応答は受信したがJSONとして解析できなかった
  | "empty_response";       // LLM応答の中身が空文字列だった

export interface ResearchMetadata {

  executionMode: ResearchExecutionMode;

  // ---- LLM ----
  //
  // STEP184: 「実際にAPIリクエストを試行した回数」をllmAttemptsとして
  // 独立に記録する。成功/失敗の結果によってこの値を0へ戻さない
  // (STEP184絶対条件)。core-only経路では常に0(generateLLMAnswer()
  // 自体を呼ばないため)。web-research経路ではrunResearch()が
  // generateLLMAnswer()を呼び出した時点で必ず1になる
  // (成功しても失敗してもllmAttempts=1)。

  llmAttempts: number;

  llmSuccesses: number;

  llmFailures: number;

  // llmFailures > 0の場合のみ設定される。
  llmFailureReason?: ResearchLLMFailureReason;

  // ---- Search ----
  //
  // STEP184: buildResearchQueries()が生成したQuery数
  // (Provider呼び出し回数ではない)。
  searchQueryCount: number;

  // STEP184: 実際にSearch Providerへ送信されたリクエストの総数
  // (query数 × 実際に試行したProvider数の合計。Tavilyが毎回成功
  // すればsearchQueryCountと一致し、Tavily失敗→Brave fallbackが
  // 発生した分だけ増える)。
  searchRequestCount: number;

  // STEP184: 各Provider試行の詳細(searchWithFallback()の戻り値を
  // そのまま透過的に集約したもの)。「Search APIを呼んだ」ことと
  // 「有効な検索結果を取得できた」ことを区別できるようにする。
  searchAttempts: SearchProviderAttempt[];

  // ---- Core ----
  //
  // STEP184: 呼び出し元がloadContext()で取得しCoreContextとして
  // Researchへ渡した件数(Researchが独自にCoreへ再問い合わせした
  // 結果ではない。既存のCore→Research一方向Context供給契約は
  // 維持したまま、渡された配列の長さを読むだけ)。
  retrievedKnowledgeCount: number;

  retrievedMemoryCount: number;

  retrievedExampleCount: number;

  usedKnowledgeCount: number;

  usedMemoryCount: number;

  usedExampleCount: number;

  // STEP177: 「Core Contextを実際に利用してResearch結果を生成した」
  // ことを、件数だけでなく個々のIDレベルで確認できるようにする
  // (STEP177-E)。空配列は「該当する項目が渡されていた文脈内に
  // 0件だった」ことを表す(usedKnowledgeCount等と常に長さが一致する)。
  usedKnowledgeIds: string[];

  usedMemoryIds: string[];

  usedExampleIds: string[];

  durationMs: number;

  // STEP180: mockResearchEngine(STEP176/177)を実処理へ置き換えたため、
  // 現在は常にfalse(=実処理で生成された結果であることを表す)。
  // フィールド自体は既存契約として維持する。
  mocked: boolean;

  // ---- Knowledge Gap Detection (STEP185) ----
  //
  // Gap Detectionが実際に実行された場合のみ意味を持つ。
  // assessAnswerability()の既存Core-only経路(単一事実の即答)が
  // 発動した場合はGap Detection自体を実行しないため、常に0/[]になる
  // (「Gap Detectionのbookkeeping」であり、「全Requirementの総称」
  // ではないことに注意)。
  requirementCount: number;

  coveredRequirementCount: number;

  partialRequirementCount: number;

  missingRequirementCount: number;

  // STEP185: partial/missingのRequirementに対して実際に生成された
  // 検索Query。ユーザーの生Query全体を複製するのではなく、
  // Gap Detectionが「不足していると判断した部分」だけを保持する。
  gapQueries: string[];

  // STEP188: Requirement Safety Check(requirementSafety.ts、STEP187)
  // によって、relevance上はcoveredだった判定が実際にpartial/missingへ
  // 降格されたRequirementの数。「Safety Checkが発動した回数」ではなく
  // 「実際にstatusが変化したRequirement数」を表す(元々covered以外
  // だったRequirementはSafety Check自体が実行されないため、
  // ここには含まれない)。
  safetyDowngradeCount: number;

}

export interface ResearchResult {

  success: boolean;

  answer: string;

  evidence: ResearchEvidenceItem[];

  metadata: ResearchMetadata;

  errorMessage?: string;

  // Phase 21: llmAnswer.tsのgenerateLLMAnswer()が既に生成している
  // LLMAnswerSuccess.uncertainty(contextAssembly.tsの指示に基づき、
  // 確認できなかった点・限界をLLM自身が申告した自然文)をそのまま
  // 透過する。新しい判定・新しいLLM呼び出しではない(絶対条件2)。
  // web-research経路でのみ設定されうる(core-only経路はLLMを呼ばない
  // ためundefinedのまま)。Evidence単体のconfidence(ResearchEvidenceItem.
  // confidence)とは別の概念であり、混同しないこと(絶対条件5)。
  uncertainty?: string;

  // Phase76(Repository Evidence): llmAnswer.tsのgenerateLLMAnswer()が
  // web-research経路で既に生成しているLLMAnswerSuccess.keyFindings
  // (「回答の根拠となった重要な事実を短く列挙」、STEP180の
  // contextAssembly.tsプロンプト仕様で確立済み)を、これまで
  // runResearch.ts側が一切拾わずに破棄していたことが判明した。新しい
  // LLM呼び出しは追加せず、既に生成済みの値をそのまま透過するだけ
  // (uncertaintyと同じ扱い)。core-only経路(LLM 0回)はkeyFindings
  // 自体が存在しないためundefinedのまま。TACT Artifact
  // (core/tact-artifact/*)のFinding Block構築に利用する。
  keyFindings?: string[];

  /** Optional Cortex output; absent when no explicit, safely executable analysis was requested. */
  analysis?: ResearchAnalysis[];

  /** Non-fatal reasons why an explicit analysis request was skipped. */
  analysisWarnings?: ValidationIssue[];

  /** Optional deterministic Dataset-derived Artifact presentation candidates. */
  presentations?: ResearchPresentation[];

  /** Non-fatal reasons why a requested presentation was not created. */
  presentationWarnings?: ValidationIssue[];

  /** True only when the user explicitly requested a Cortex presentation. */
  presentationRequested?: boolean;

  frameworks?: ResearchFrameworkAnalysis[];
  frameworkWarnings?: ValidationIssue[];
  frameworkArtifacts?: ResearchFrameworkArtifact[];
  frameworkArtifactRequested?: boolean;

  /** Optional canonical Cortex Pipeline trace; absent for ordinary Research. */
  cortexAnalysis?: CortexAnalysisPipelineResult;

  /** Canonical, pure Cortex Artifact plan; Conversation owns mutation/persistence. */
  analysisArtifactPlan?: AnalysisArtifactPlan;
  cortexArtifactPlanRequested?: boolean;

}

// Coreから渡された関連文脈の型エイリアス(再exportではなく、
// Research側が「自分が何を必要とするか」を明示するためのもの)。
export type RelevantKnowledge = KnowledgeItem[];
export type RelevantMemories = CoreMemory[];
export type RelevantExamples = Example[];
