// =========================
// runResearch (STEP176/178/180/184/185/186)
// =========================
//
// TACT Researchの公開API。「Agentを束ねるOrchestrator」ではなく
// 「researchという能力」として外部から呼び出せることを示す
// (STEP176絶対条件5)。呼び出し元は query と CoreContext だけを渡し、
// 内部構成を一切意識しない。
//
// 依存方向(STEP176絶対条件9・STEP180絶対条件): このファイルは
// core/tact-coreの型(CoreContext/CoreCapability)と、TACT Research
// 内部モジュール(answerability/coreOnlyAnswer/queryGeneration/
// webResearch/contextAssembly/llmAnswer)にのみ依存する。
// core/tact-coreのどのファイルもこのファイルを逆にimportしていない。
//
// Legacy Workflow Engineとの関係: core/workflow/*・core/agents/*・
// core/planner/*・core/brain/*は一切importしていない(実行もしていない)。
// core/llm/*(runLLM低レベル実行関数)・core/evidence/*・
// core/tools/search|pipeline/*は「CODE/SEARCH/LLMの最小構成」として
// 明示的に再利用が許可されている既存基盤であり、Legacy Workflowの
// オーケストレーション(runWorkflow/runAgent/getTeam/Planner/Reviewer
// loop/Writer Critique・Revision/runLLMWithFallback)とは区別している。
//
// STEP180: 内部実装をmockResearchEngine(STEP176/177の暫定プレース
// ホルダー)から、STEP179監査に基づく実Pipelineへ置き換えた。
//
//   ① Core Retrieval   … 呼び出し元が既にloadContext()済みのcontextを
//                          そのまま使う(再問い合わせしない)
//   ② Answerability判定 … assessAnswerability()(CODE、LLM 0回)
//   ③ Web Research      … buildResearchQueries()+performWebResearch()
//                          (CODE+SEARCH、LLM 0回。②がCore-only不可の
//                          場合のみ実行)
//   ④ Context Assembly  … assembleResearchContext()(CODE、LLM 0回)
//   ⑤ LLM               … generateLLMAnswer()(最大1回)
//
// 公開関数のシグネチャ(runResearch(params, core))はSTEP176から一切
// 変更していない。
//
// STEP184: metadataを観測性・コスト計測基盤として再設計した。
// generateLLMAnswer()がもはや例外を投げず判別可能Union
// (LLMAnswerOutcome)を返すため、「LLM呼び出しを試行した」という
// 事実(llmAttempts)と「その結果成功したか」(llmSuccesses/
// llmFailures)を、catchでの事後推測ではなく戻り値から正確に
// 記録できるようになった。Search側もperformWebResearch()の
// 戻り値からsearchQueryCount/searchRequestCount/searchAttemptsを
// そのまま転記する。Core側もcontext.knowledge/memories/examplesの
// 件数(retrievedXxxCount)をここで初めて読む(Coreへの再問い合わせは
// 行わない、既存契約どおり)。
//
// STEP185: assessAnswerability()が単一事実として即答できなかった
// query(=Web Research分岐に入るqueryすべて)に対して、Knowledge Gap
// Detection(②'、detectKnowledgeGap())を追加した。queryを
// Requirement単位へ分解し(LLM不使用、requirementDecomposition.ts)、
// 各RequirementのCore関連度をcovered/partial/missingへ分類する
// (LLM不使用、knowledgeGap.ts)。全Requirementがcoveredであれば
// (かつ元のqueryが時間依存でなければ)既存のCore-only経路と同じ
// 意味論(LLM 0回・Search 0回)で応答する。そうでない場合は、
// covered以外(partial/missing)のRequirementに対してのみGap Query
// (buildGapResearchQueries())を生成し、coveredなRequirementの
// 不要な再検索を行わない。
//
// STEP186: Web Research分岐で計算済みのrequirements(Gap Detection
// 結果)をassembleResearchContext()へそのまま渡すようにした。これに
// より、LLMへ渡すContextが「Requirement単位でCore情報とWeb Evidence
// を区別した構造」になる(詳細はcontextAssembly.ts参照)。

import { CoreCapability } from "../tact-core";
import {
  ResearchParams,
  ResearchResult,
  ResearchMetadata,
  ResearchEvidenceItem,
} from "./types";
import { assessAnswerability } from "./answerability";
import {
  buildCoreOnlyAnswer,
  buildCoreOnlyAnswerFromRequirements,
} from "./coreOnlyAnswer";
import { buildResearchQueries, buildGapResearchQueries } from "./queryGeneration";
import { performWebResearch } from "./webResearch";
import { assembleResearchContext } from "./contextAssembly";
import { generateLLMAnswer } from "./llmAnswer";
import {
  detectKnowledgeGap,
  canAnswerAllFromCoreOnly,
  ResearchRequirement,
} from "./knowledgeGap";

// core.recordExecution()へ渡すscopeを、CoreContextの内容から推定する。
// core/tact-design/runDesign.tsのinferExecutionScope()と同じロジック
// (重複コードだが、両Capabilityが将来別々に進化する可能性を考え、
// あえて共有関数へ抽象化しない、というSTEP178からの既存方針を継続)。
function inferExecutionScope(
  context: ResearchParams["context"]
): "user" | "organization" | "project" | "conversation" {

  if (context.conversationId) return "conversation";

  if (context.project) return "project";

  if (context.organization) return "organization";

  return "user";

}

// STEP198: sourceURLが将来切れた場合でも「LLMが何を根拠として引用
// したか」を人間が確認できる程度の短い本文断片(snippet)を作る。
// Evidence全文(数千字になり得るraw content)をそのまま転記すること
// は禁止されている(STEP197絶対条件11・STEP198絶対条件12)ため、
// ここで単純な文字列切り出しのみを行う。要約LLM呼び出し・追加API
// 呼び出しは行わない(STEP198絶対条件8)。空文字を意味のあるsnippet
// として生成しない(trim後に空ならundefinedを返す)。
const MAX_EVIDENCE_SNIPPET_LENGTH = 500;

function buildEvidenceSnippet(
  body: string
): string | undefined {

  const trimmed = body.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > MAX_EVIDENCE_SNIPPET_LENGTH
    ? trimmed.slice(0, MAX_EVIDENCE_SNIPPET_LENGTH)
    : trimmed;

}

// STEP195: idを含めて変換する(以前はclaim/source/confidenceのみを
// 転記しており、evidence.idが失われていたため、LLMが返した
// evidenceIdsとResearchResult.evidenceの対応関係を外部から追跡
// できなかった)。呼び出し元(citedEvidence)は既にwebResult.evidence
// (core/context/types.tsのEvidence[]、id保持済み)をvalidateEvidenceIds()
// 通過後のIDでfilter済みのものであるため、ここでidを転記するだけで
// 新しい検証ロジックを追加せずに監査可能性を復元できる。
//
// STEP198: 上記に加え、Evidence.evidence(生成時点の本文/snippet、
// core/context/types.ts)からbuildEvidenceSnippet()で切り出した
// snippetをResearchEvidenceItem.snippetへ転記する。Evidence型
// (core/context/types.ts)自体は変更していない(Legacy Workflow含む
// 既存の広い利用範囲を持つ共有型であり、Research側の末端でのみ
// 必要な変換をそこへ持ち込まないため、STEP198絶対条件1「変更は
// 最小限に」を優先しこの関数内で完結させた)。
function toResearchEvidenceItems(
  evidence: { id: string; claim: string; source?: string; confidence: "low" | "medium" | "high"; evidence: string }[]
): ResearchEvidenceItem[] {

  return evidence.map((item) => ({
    id: item.id,
    claim: item.claim,
    source: item.source,
    confidence: item.confidence,
    snippet: buildEvidenceSnippet(item.evidence),
  }));

}

// STEP184: 呼び出し元がloadContext()で取得しCoreContextとして渡した
// 件数(Coreが「持っている」件数)。retrieveKnowledge等でCoreへ
// 再問い合わせすることはしない(既存のCore→Research一方向Context
// 供給契約を維持したまま、渡された配列の長さを読むだけ)。
function computeRetrievedCounts(
  context: ResearchParams["context"]
): {
  retrievedKnowledgeCount: number;
  retrievedMemoryCount: number;
  retrievedExampleCount: number;
} {

  return {
    retrievedKnowledgeCount: context.knowledge.length,
    retrievedMemoryCount: context.memories.length,
    retrievedExampleCount: context.examples.length,
  };

}

// STEP185: Gap Detectionを実行しなかった経路(assessAnswerability()の
// 既存Core-only経路)では、Gap関連のmetadataは常に0/[]にする
// (「Gap Detectionのbookkeeping」であり「全Requirementの総称」では
// ないため)。
const NO_GAP_DETECTION_FIELDS = {
  requirementCount: 0,
  coveredRequirementCount: 0,
  partialRequirementCount: 0,
  missingRequirementCount: 0,
  gapQueries: [] as string[],
  safetyDowngradeCount: 0,
};

function computeRequirementCounts(
  requirements: ResearchRequirement[]
): {
  requirementCount: number;
  coveredRequirementCount: number;
  partialRequirementCount: number;
  missingRequirementCount: number;
  safetyDowngradeCount: number;
} {

  return {
    requirementCount: requirements.length,
    coveredRequirementCount: requirements.filter((r) => r.status === "covered").length,
    partialRequirementCount: requirements.filter((r) => r.status === "partial").length,
    missingRequirementCount: requirements.filter((r) => r.status === "missing").length,
    // STEP188: knowledgeGap.tsのclassifyRequirement()は、
    // status==="covered"だった場合にのみSafety Checkを実行し、
    // 降格した場合にのみsafetyIssuesへ値を入れる(元々covered以外
    // だったRequirementのsafetyIssuesは常に空配列)。そのため
    // 「safetyIssuesが1件以上あるRequirementの数」が、そのまま
    // 「実際に降格されたRequirement数」と一致する。
    safetyDowngradeCount: requirements.filter((r) => r.safetyIssues.length > 0).length,
  };

}

export async function runResearch(
  params: ResearchParams,
  core: CoreCapability
): Promise<ResearchResult> {

  const startedAt = Date.now();

  const { query, context, options } = params;

  const retrievedCounts = computeRetrievedCounts(context);

  // STEP184: 予期しない例外がどの段階で発生しても、catch節が
  // それまでに判明していた検索統計・LLM試行有無を正確に報告できる
  // よう、try本体の外側で可変の記録用変数を保持する
  // (STEP181/182で発見した「catchでの事後推測」問題を、LLM側だけで
  // なくSearch側でも繰り返さないため)。
  let searchQueryCount = 0;
  let searchRequestCount = 0;
  let searchAttempts: ResearchMetadata["searchAttempts"] = [];
  let llmAttempted = false;

  try {

    // ===============================
    // ② Answerability判定(CODE、LLM 0回)
    // ===============================
    const answerability = assessAnswerability(query, context);

    if (answerability.canAnswerFromCoreOnly) {

      const coreOnly = buildCoreOnlyAnswer(answerability.match);

      const metadata: ResearchMetadata = {

        executionMode: "core-only",

        llmAttempts: 0,

        llmSuccesses: 0,

        llmFailures: 0,

        searchQueryCount: 0,

        searchRequestCount: 0,

        searchAttempts: [],

        ...retrievedCounts,

        ...NO_GAP_DETECTION_FIELDS,

        usedKnowledgeCount: coreOnly.usedKnowledgeIds.length,

        usedMemoryCount: coreOnly.usedMemoryIds.length,

        usedExampleCount: coreOnly.usedExampleIds.length,

        usedKnowledgeIds: coreOnly.usedKnowledgeIds,

        usedMemoryIds: coreOnly.usedMemoryIds,

        usedExampleIds: coreOnly.usedExampleIds,

        durationMs: Date.now() - startedAt,

        mocked: false,

      };

      await core.recordExecution({

        scope: inferExecutionScope(context),

        capability: "tact-research",

        summary: `Research (core-only, LLM 0): ${query}`,

        outcome: "success",

      });

      return {

        success: true,

        answer: coreOnly.answer,

        evidence: coreOnly.evidence,

        metadata,

      };

    }

    // ===============================
    // ②' Knowledge Gap Detection(CODE、LLM 0回)
    // ===============================
    //
    // STEP185: assessAnswerability()が「単一の完全一致」で即答
    // できなかった場合でも、query全体をそのままWeb Researchへ
    // 投げる前に、query を情報要求単位(Requirement)へ分解し、
    // 各Requirementについて「Coreに既にあるか」を判定する。
    const requirements = detectKnowledgeGap(query, context);

    const requirementCounts = computeRequirementCounts(requirements);

    // STEP185絶対条件(セクション13): 全Requirementがcoveredであっても
    // hasTimeSensitiveSignal()を再度確認し、assessAnswerability()と
    // 矛盾しないようにする(canAnswerAllFromCoreOnly()内部で実施)。
    if (canAnswerAllFromCoreOnly(query, requirements)) {

      const gapCoreOnly = buildCoreOnlyAnswerFromRequirements(requirements, context);

      const metadata: ResearchMetadata = {

        executionMode: "core-only",

        llmAttempts: 0,

        llmSuccesses: 0,

        llmFailures: 0,

        searchQueryCount: 0,

        searchRequestCount: 0,

        searchAttempts: [],

        ...retrievedCounts,

        ...requirementCounts,

        gapQueries: [],

        usedKnowledgeCount: gapCoreOnly.usedKnowledgeIds.length,

        usedMemoryCount: gapCoreOnly.usedMemoryIds.length,

        usedExampleCount: gapCoreOnly.usedExampleIds.length,

        usedKnowledgeIds: gapCoreOnly.usedKnowledgeIds,

        usedMemoryIds: gapCoreOnly.usedMemoryIds,

        usedExampleIds: gapCoreOnly.usedExampleIds,

        durationMs: Date.now() - startedAt,

        mocked: false,

      };

      await core.recordExecution({

        scope: inferExecutionScope(context),

        capability: "tact-research",

        summary: `Research (core-only via Knowledge Gap Detection, LLM 0): ${query}`,

        outcome: "success",

      });

      return {

        success: true,

        answer: gapCoreOnly.answer,

        evidence: gapCoreOnly.evidence,

        metadata,

      };

    }

    // ===============================
    // ③ Web Research(CODE + SEARCH、LLM 0回)
    // ===============================
    //
    // STEP185: partial/missingのRequirementについてのみGap Queryを
    // 生成する(coveredなRequirementの検索は行わない)。
    // buildGapResearchQueries()が空配列を返すのは理論上
    // canAnswerAllFromCoreOnly()がtrueになるはずのケースのみだが
    // (defense-in-depth)、万一空になった場合でも無検索のまま
    // Web Researchへ進んでしまわないよう、既存のbuildResearchQueries()
    // (query全体)へ安全側でフォールバックする。
    const gapQueries = buildGapResearchQueries(requirements);

    const queries = gapQueries.length > 0 ? gapQueries : buildResearchQueries(query);

    const webResult = await performWebResearch(
      queries,
      query,
      options?.maxResults
    );

    searchQueryCount = webResult.searchQueryCount;
    searchRequestCount = webResult.searchRequestCount;
    searchAttempts = webResult.searchAttempts;

    // ===============================
    // ④ Context Assembly(CODE、LLM 0回)
    // ===============================
    // STEP186: Knowledge Gap Detection(requirements)の判定結果を
    // Context Assemblyへ明示的に渡す。covered/partial/missingの
    // 状態と、対応するCore情報・Web Evidenceを、LLMが区別できる
    // 構造で提示する。
    const assembled = assembleResearchContext({
      query,
      context,
      evidence: webResult.evidence,
      requirements,
    });

    // ===============================
    // ⑤ LLM(最大1回)
    // ===============================
    // STEP184: generateLLMAnswer()を呼び出した時点で、成功・失敗に
    // 関わらずllmAttemptsは必ず1になる(この関数はもはや例外を
    // 投げず、判別可能Unionを返すため)。
    llmAttempted = true;

    // STEP193: options.llmProviderを渡す(省略時はgenerateLLMAnswer()側の
    // デフォルト引数によりOpenAIのまま。Research層でのProvider分岐は
    // 書かない)。Phase 7: options.llmModelも同様にそのまま渡す
    // (省略時はgenerateLLMAnswer()→runLLM()→各Provider実装の既定
    // モデルへフォールバック、既存挙動と同じ)。
    const outcome = await generateLLMAnswer(
      assembled,
      webResult.evidence,
      options?.llmProvider,
      options?.llmModel
    );

    const commonMetadataFields = {

      executionMode: "web-research" as const,

      searchQueryCount,

      searchRequestCount,

      searchAttempts,

      ...retrievedCounts,

      ...requirementCounts,

      gapQueries,

      usedKnowledgeCount: assembled.usedKnowledgeIds.length,

      usedMemoryCount: assembled.usedMemoryIds.length,

      usedExampleCount: assembled.usedExampleIds.length,

      usedKnowledgeIds: assembled.usedKnowledgeIds,

      usedMemoryIds: assembled.usedMemoryIds,

      usedExampleIds: assembled.usedExampleIds,

      durationMs: Date.now() - startedAt,

      mocked: false,

    };

    if (!outcome.success) {

      const metadata: ResearchMetadata = {

        ...commonMetadataFields,

        llmAttempts: 1,

        llmSuccesses: 0,

        llmFailures: 1,

        llmFailureReason: outcome.failureReason,

      };

      await core.recordExecution({

        scope: inferExecutionScope(context),

        capability: "tact-research",

        summary: `Research failed (web-research, LLM failure: ${outcome.failureReason}): ${query}`,

        outcome: "failure",

      });

      return {

        success: false,

        answer: "",

        evidence: [],

        metadata,

        errorMessage: outcome.errorMessage,

      };

    }

    const citedEvidence = webResult.evidence.filter((item) =>
      outcome.evidenceIds.includes(item.id)
    );

    const metadata: ResearchMetadata = {

      ...commonMetadataFields,

      llmAttempts: 1,

      llmSuccesses: 1,

      llmFailures: 0,

    };

    await core.recordExecution({

      scope: inferExecutionScope(context),

      capability: "tact-research",

      summary: `Research (web-research, LLM 1): ${query}`,

      outcome: "success",

    });

    return {

      success: true,

      answer: outcome.answer,

      evidence: toResearchEvidenceItems(citedEvidence),

      metadata,

    };

  } catch (error) {

    // STEP184: ここへ到達するのは、Answerability判定・Search・
    // Context Assembly・generateLLMAnswer()の呼び出し自体(想定される
    // 失敗経路はすべてLLMAnswerOutcomeとして返るため、ここでの
    // 例外はgenerateLLMAnswer()の呼び出し以前、またはランタイムの
    // 想定外エラーに限られる)以外で発生した、真に予期しない例外の
    // 場合のみ。llmAttemptedをここまでの実行状況から正確に反映する
    // (「試行していないのに1」「試行したのに0」のどちらも避ける)。
    const metadata: ResearchMetadata = {

      executionMode: "web-research",

      llmAttempts: llmAttempted ? 1 : 0,

      llmSuccesses: 0,

      llmFailures: llmAttempted ? 1 : 0,

      llmFailureReason: llmAttempted ? "unknown_error" : undefined,

      searchQueryCount,

      searchRequestCount,

      searchAttempts,

      ...retrievedCounts,

      // STEP185: Gap Detectionが実際に実行されたかどうかに関わらず、
      // 真に予期しない例外の場合は0/[]で報告する(catchの時点で
      // Gap Detectionの結果を正確に持ち越す価値は薄く、search統計と
      // 同じ「後付け推測をしない」原則の範囲内で、シンプルに保つ)。
      ...NO_GAP_DETECTION_FIELDS,

      usedKnowledgeCount: 0,

      usedMemoryCount: 0,

      usedExampleCount: 0,

      usedKnowledgeIds: [],

      usedMemoryIds: [],

      usedExampleIds: [],

      durationMs: Date.now() - startedAt,

      mocked: false,

    };

    await core.recordExecution({

      scope: inferExecutionScope(context),

      capability: "tact-research",

      summary: `Research failed: ${query}`,

      outcome: "failure",

    });

    return {

      success: false,

      answer: "",

      evidence: [],

      metadata,

      errorMessage:
        error instanceof Error
          ? error.message
          : String(error),

    };

  }

}
