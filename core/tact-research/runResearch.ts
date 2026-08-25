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
//   ⑤ LLM               … generateLLMAnswer()(最大2回。Phase24で、
//                          一時的Failure(quota_exceeded/rate_limited/
//                          network_error)の場合のみ最大1回Retryする
//                          仕組みを追加した。Search/Context Assembly
//                          はRetryの対象外——既に確定済みのassembled/
//                          webResult.evidenceをそのまま再利用して
//                          generateLLMAnswer()をもう一度呼ぶだけ)
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
  ResearchLLMFailureReason,
} from "./types";
import { assessAnswerability } from "./answerability";
import {
  buildCoreOnlyAnswer,
  buildCoreOnlyAnswerFromRequirements,
} from "./coreOnlyAnswer";
import { buildResearchQueries, buildGapResearchQueries, buildDeepeningQueries } from "./queryGeneration";
import { performWebResearch, WebResearchResult, DEFAULT_MAX_EVIDENCE } from "./webResearch";
import {
  discoverCandidateEntities,
  selectDeepeningCandidates,
  prioritizeIndividualEntityEvidence,
} from "./candidateDiscovery";
import { removeDuplicates } from "../tools/pipeline/removeDuplicates";
import { selectEvidence } from "../evidence/selectEvidence";
import { assembleResearchContext, AssembledResearchContext } from "./contextAssembly";
import { generateLLMAnswer, LLMAnswerOutcome } from "./llmAnswer";
import {
  detectKnowledgeGap,
  canAnswerAllFromCoreOnly,
  ResearchRequirement,
} from "./knowledgeGap";
import type { Provider } from "../agent/types";
import type { Evidence } from "../context/types";
import { runLLM } from "../llm";

// =========================
// Research内部LLM Retry (Phase 23調査 → Phase 24実装)
// =========================
//
// generateLLMAnswer()(⑤LLM、Research Pipeline全体でLLMを呼び出す
// 唯一の場所)が一時的Failureで失敗した場合のみ、最大1回だけ
// もう一度呼び直す。対象はPhase19のexecutor.tsが採用しているものと
// 全く同じ3つのreasonのみ(絶対条件11: 新しいFailure分類体系を
// 作らない)。authentication_failed/invalid_request/unknown_error、
// および今回スコープ外としたresponse_parse_error/empty_responseは
// 対象外(絶対条件3・4・5)。
//
// Search呼び出し(performWebResearch())・Context Assembly
// (assembleResearchContext())はこのRetryの対象に含まれない
// (絶対条件6・7)。Retryは、この呼び出し時点で既に確定済みの
// ローカル変数(assembled・webResult.evidence)をそのまま再利用して
// generateLLMAnswer()をもう一度呼ぶだけであり、Search/Evidence/
// Context Assemblyを再実行する経路はコード構造上存在しない
// (Phase23 Reality Testで実測確認済み)。
//
// Phase19のexecutor.tsのwithTemporaryFailureRetry()(例外を
// catchして判定する設計)とは異なり、generateLLMAnswer()は例外を
// 投げず判別可能Union(LLMAnswerOutcome)を返す設計(STEP184)のため、
// ここでは戻り値のsuccess/failureReasonを見て判定する
// (絶対条件9: Executor Retryとは独立した、二重にならない別レイヤー)。
const TEMPORARY_LLM_RETRY_REASONS: ReadonlySet<ResearchLLMFailureReason> =
  new Set(["quota_exceeded", "rate_limited", "network_error"]);

export interface LLMAnswerRetryResult {

  outcome: LLMAnswerOutcome;

  // 1(通常成功、または一時的でない失敗) または 2(Retryが発生した)。
  attempts: 1 | 2;

}

// runResearch()本体からRetryループを切り出した、独立してテスト可能な
// 純粋寄りの関数(Phase20のisTemporaryFailure/withTemporaryFailureRetry
// (core/tact-orchestrator/executor.ts、Phase19)と同じ理由でexportする
// ——Evaluation Harnessが実装と乖離しないよう、この関数自体を直接
// テストできるようにする)。runLLMImplはgenerateLLMAnswer()が既に
// 持つDIパラメータをそのまま透過するだけで、新しいMock機構は作らない。
export async function generateLLMAnswerWithRetry(
  assembled: AssembledResearchContext,
  evidencePool: Evidence[],
  provider?: Provider,
  model?: string,
  runLLMImpl: typeof runLLM = runLLM
): Promise<LLMAnswerRetryResult> {

  const first = await generateLLMAnswer(
    assembled,
    evidencePool,
    provider,
    model,
    runLLMImpl
  );

  if (first.success || !TEMPORARY_LLM_RETRY_REASONS.has(first.failureReason)) {
    return { outcome: first, attempts: 1 };
  }

  // Search/Context Assemblyは再実行しない。assembled/evidencePoolは
  // 呼び出し元から渡された同じ参照をそのまま再利用するだけ
  // (絶対条件6・7・8)。
  const second = await generateLLMAnswer(
    assembled,
    evidencePool,
    provider,
    model,
    runLLMImpl
  );

  return { outcome: second, attempts: 2 };

}

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
  // Phase24: 真偽値(llmAttempted)から実際の試行回数(0〜2)へ拡張した。
  // Research内部LLM Retry(下記TEMPORARY_LLM_RETRY_REASONS参照)により
  // generateLLMAnswer()が最大2回呼ばれうるようになったため、
  // metadata.llmAttemptsへ正確な回数を反映する必要がある
  // (STEP184の「試行していないのに1」「試行したのに0」を避ける、
  // という既存原則をRetry導入後も維持する)。
  let llmAttemptCount = 0;

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
    // ③' Discovery → Deepening(CODE + SEARCH、LLM 0回、Phase93)
    // ===============================
    //
    // Root Cause(Phase92投資調査、Repository Evidence: Phase90〜92の
    // 3回の実Reality Test): ここまでのWeb Research(=Discovery)1回
    // だけでは、検索結果がポータル/一覧ページに集中し、個別Entityの
    // 属性(開催日・参加費・定員等)がEvidence本文に含まれないことが
    // 確認された。discoverCandidateEntities()(candidateDiscovery.ts、
    // 決定論的heuristic・LLM不使用)で「ポータルではなく個別の調査対象
    // らしいもの」を抽出し、既に要求Attributeが揃っているCandidateを
    // 除いた上で(selectDeepeningCandidates())、見つかった場合のみ
    // 最大1ラウンドだけ追加Search(Deepening)を行う。Candidateが
    // 1件も無い場合(実際にPortalしか無かった場合を含む)は、従来通り
    // Discoveryの結果のみで進む(無駄なSearchを増やさない、Section7
    // 「Deepeningを何度も再帰的に実行する仕組みは作らない」)。
    const candidates = discoverCandidateEntities(webResult.evidence);

    const deepeningTargets = selectDeepeningCandidates(candidates, {
      attributes: options?.tableSchema?.columns,
      requestedRowCount: options?.tableSchema?.requestedRowCount,
    });

    let deepeningResult: WebResearchResult | undefined;

    if (deepeningTargets.length > 0) {

      const deepeningQueries = buildDeepeningQueries(
        deepeningTargets.map((c) => c.name),
        options?.tableSchema?.columns
      );

      deepeningResult = await performWebResearch(
        deepeningQueries,
        query,
        options?.maxResults
      );

      // Discovery分に加算する(既存metadata契約=「実際に行ったSearch
      // 回数を正確に報告する」というSTEP184の原則を、Deepening導入後も
      // そのまま維持する)。
      searchQueryCount += deepeningResult.searchQueryCount;
      searchRequestCount += deepeningResult.searchRequestCount;
      searchAttempts = [...searchAttempts, ...deepeningResult.searchAttempts];

    }

    // Discovery/Deepening両方のEvidenceを1つのpoolへ統合する。重複排除は
    // 既存executeEvidencePipeline()(core/tools/pipeline/evidence.ts)と
    // 同じkey(claim+source)でremoveDuplicates()(既存汎用関数)を
    // 再利用し、統合後は既存selectEvidence()で改めて関連度順に並べる
    // (新しい重複判定・スコアリングロジックは作らない)。
    //
    // Phase99(Repository Evidence: Phase98 Reality Test): ここで
    // selectEvidence()がそのままmaxEvidence件に絞り込むと、Deepeningが
    // 個別Entityを対象に検索できていても、関連度スコアが高いPortal/
    // 一覧ページ(汎用的な地域・属性キーワードをタイトルに含みやすい)に
    // 押し出されて最終Evidenceから漏れることが実データで確認された。
    // 絞り込み前に一旦重複排除後のpool全体を関連度順にランクし直し
    // (selectEvidence()自体は無変更、limitをpool長にして「並べ替えの
    // みで絞り込まない」呼び出しに留める)、
    // prioritizeIndividualEntityEvidence()(candidateDiscovery.ts、
    // Phase93/97のisLikelyCollectionOrPortal()を再利用するだけの決定論的
    // 後処理)でIndividual Entityらしい項目を優先してからmaxEvidence件へ
    // 絞り込む。Portal Evidenceを排除するわけではなく、Individual
    // Entityが無ければ従来通りPortal Evidenceで埋まる(全面排除の禁止)。
    const combinedEvidence = deepeningResult
      ? (() => {

          const dedupedPool = removeDuplicates(
            [...webResult.evidence, ...deepeningResult.evidence],
            (item) => `${item.claim}${item.source}`
          );

          const relevanceRanked = selectEvidence(
            dedupedPool,
            query,
            dedupedPool.length
          );

          return prioritizeIndividualEntityEvidence(
            relevanceRanked,
            options?.maxResults ?? DEFAULT_MAX_EVIDENCE
          );

        })()
      : webResult.evidence;

    // ===============================
    // ④ Context Assembly(CODE、LLM 0回)
    // ===============================
    // STEP186: Knowledge Gap Detection(requirements)の判定結果を
    // Context Assemblyへ明示的に渡す。covered/partial/missingの
    // 状態と、対応するCore情報・Web Evidenceを、LLMが区別できる
    // 構造で提示する。
    // Phase90: options.tableSchema(Table要求を事前検知できた場合の
    // 列構成・要求件数)をそのまま透過する。undefinedの場合は既存
    // Phase1〜89と完全に同じPromptになる。
    // Phase93: evidenceにはDiscovery単独ではなく、Deepeningを含めた
    // combinedEvidenceを渡す(Deepeningが発生しなかった場合は
    // webResult.evidenceと同一のため、既存Phase1〜92の挙動と完全に
    // 一致する)。
    const assembled = assembleResearchContext({
      query,
      context,
      evidence: combinedEvidence,
      requirements,
      tableSchema: options?.tableSchema,
    });

    // ===============================
    // ⑤ LLM(最大2回、Phase24: 一時的Failure時のみRetryで+1)
    // ===============================
    // STEP193: options.llmProviderを渡す(省略時はgenerateLLMAnswer()側の
    // デフォルト引数によりOpenAIのまま。Research層でのProvider分岐は
    // 書かない)。Phase 7: options.llmModelも同様にそのまま渡す
    // (省略時はgenerateLLMAnswer()→runLLM()→各Provider実装の既定
    // モデルへフォールバック、既存挙動と同じ)。
    // Phase24: 一時的Failure時のみ最大1回RetryするgenerateLLMAnswerWithRetry()
    // (上で定義、Search/Context Assemblyは再実行しない)を経由する。
    // Phase93: LLM呼び出し自体は増やさない(Section20「Candidateごとに
    // 個別LLMを呼び出す設計は禁止」)。Discovery+DeepeningのEvidence全体
    // に対して、従来通り1回(Retry込みで最大2回)だけLLMを呼ぶ。
    const { outcome, attempts } = await generateLLMAnswerWithRetry(
      assembled,
      combinedEvidence,
      options?.llmProvider,
      options?.llmModel
    );

    llmAttemptCount = attempts;

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

        // Phase24: Retryが発生した場合(llmAttemptCount===2)、両方の
        // 試行が失敗したことを表す(1回目の理由は保持しないが、
        // 絶対条件5の通り新しいFailure分類体系は作らない。最終
        // 試行のfailureReasonのみをllmFailureReasonへ反映する)。
        llmAttempts: llmAttemptCount,

        llmSuccesses: 0,

        llmFailures: llmAttemptCount,

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

    // Phase93: 引用対象もcombinedEvidence(Discovery+Deepening統合後)から
    // 探す(DeepeningでのみEvidence化された項目もLLMが引用できるように
    // なったため)。
    const citedEvidence = combinedEvidence.filter((item) =>
      outcome.evidenceIds.includes(item.id)
    );

    const metadata: ResearchMetadata = {

      ...commonMetadataFields,

      // Phase24: Retryを経て成功した場合(llmAttemptCount===2)、
      // 1回目は失敗・2回目で成功したことを表す
      // (llmAttempts:2, llmSuccesses:1, llmFailures:1)。
      llmAttempts: llmAttemptCount,

      llmSuccesses: 1,

      llmFailures: llmAttemptCount - 1,

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

      // Phase 21: generateLLMAnswer()(llmAnswer.ts)がcontextAssembly.tsの
      // 指示(「missingなRequirementでWeb Evidenceが0件の場合、確認できな
      // かったことをuncertaintyへ明記する」等)に基づき既に生成している
      // 値をそのまま透過するだけ。新しいLLM呼び出しは発生しない
      // (絶対条件2)。STEP186時点ではこの値はrunResearch()内で読まれず
      // 破棄されていた(Phase21調査で確認)。
      uncertainty: outcome.uncertainty,

      // Phase76: 同じくgenerateLLMAnswer()が既に生成している
      // outcome.keyFindingsを透過する(新しいLLM呼び出しなし、
      // Repository Evidenceで判明した既存の未配線箇所)。
      keyFindings: outcome.keyFindings,

    };

  } catch (error) {

    // STEP184: ここへ到達するのは、Answerability判定・Search・
    // Context Assembly・generateLLMAnswer()の呼び出し自体(想定される
    // 失敗経路はすべてLLMAnswerOutcomeとして返るため、ここでの
    // 例外はgenerateLLMAnswer()の呼び出し以前、またはランタイムの
    // 想定外エラーに限られる)以外で発生した、真に予期しない例外の
    // 場合のみ。llmAttemptCountをここまでの実行状況から正確に反映する
    // (「試行していないのに1」「試行したのに0」のどちらも避ける。
    // Phase24: Retryにより最大2まで取りうる値になったため、真偽値では
    // なく実際の試行回数をそのまま使う)。
    const metadata: ResearchMetadata = {

      executionMode: "web-research",

      llmAttempts: llmAttemptCount,

      llmSuccesses: 0,

      llmFailures: llmAttemptCount,

      llmFailureReason: llmAttemptCount > 0 ? "unknown_error" : undefined,

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
