import { buildPrompt } from "../prompt/builder";
import { runLLMWithFallback } from "../llm/runLLMWithFallback";
import { resolveExecutionStrategy } from "../llm/executionStrategy";
import { TaskProfile, ModelTier } from "./taskProfile";
import { executeToolCalls } from "../tools/executeToolCalls";
import { retrieveEvidence } from "../evidence/retrieveEvidence";
import { selectEvidence } from "../evidence/selectEvidence";
import {
  validateEvidenceIds,
  AnalystOutput,
} from "../evidence/validateEvidenceIds";
import {
  hasSuccessfulToolResult,
  containsUnverifiedQuantitativeClaim,
} from "../evidence/evidenceGuard";
import { detectResearchRequirement } from "../evidence/researchRequirement";
import { Agent } from "../agents/types";
import type { Provider } from "../agent/types";
import { WorkflowStep } from "./types";
import { WorkflowContext, Evidence } from "../context/types";
import { accumulateLLMCost, recordActualExecution } from "../context";
import { IDEA_MODE_MARKER } from "./ideaMode";
import {
  resolveConclusionState,
  buildConclusionStateBlock,
  buildWriterAnalystView,
  buildPhase1DeferralBlock,
  ConclusionState,
} from "./conclusionState";
import fs from "fs";
import path from "path";

function cleanJSON(text: string) {
  return text
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

// Analystが実際に参照したEvidence(primary)を優先し、
// 不足分だけReviewer自身のselectEvidence()結果(supplementary)で補う。
// IDが重複するものは追加しない。内容・順序は加工しない。
function mergeEvidenceById(
  primary: Evidence[],
  supplementary: Evidence[],
  limit: number
): Evidence[] {

  const seen = new Set(
    primary.map((e) => e.id)
  );

  const merged = [...primary];

  for (const item of supplementary) {

    if (merged.length >= limit) break;

    if (seen.has(item.id)) continue;

    seen.add(item.id);

    merged.push(item);

  }

  return merged.slice(0, limit);

}

// =========================
// retryResearcherSearch (STEP33)
// =========================
//
// 「外部検索が明確に必要な要求」と判定されたにもかかわらず、
// Researcherが一度もtoolRequestsを発行しなかった場合にのみ、
// 最大1回だけ「検索してください」という指示を明示的に追加して
// 再実行する。既存のTool実行→再生成という2-passの流れ
// (runAgent本体の該当ブロック)をそのまま踏襲するだけで、
// 新しいWorkflow構造・新しいAgentは追加しない。
//
// 再試行してもtoolRequestsが得られない場合は、再試行後の応答
// (parsed)をそのまま返しつつ、toolResultsは空のままにする。
// 検索なしの状態をそのまま下流(Evidence Guard)へ伝えるためであり、
// ここで検索の要否を強制することはしない(判断はLLMに委ねる)。
// STEP77: 戻り値にfinalPromptを追加した。呼び出し元(runAgent()本体)が
// 「実際にLLMへ送信し、かつ最終的に採用されたparsedを生んだ
// プロンプト文字列」をsaveAgentLog()へ正確に渡せるようにするため。
// buildPrompt()のシグネチャ・この関数自体の判定ロジックは変更しない
// (戻り値に1フィールド追加するだけ)。
async function retryResearcherSearch(
  agent: Agent,
  step: WorkflowStep,
  context: WorkflowContext,
  relevantEvidence: Evidence[]
): Promise<{
  parsed: any;
  toolResults: Record<string, unknown>;
  finalPrompt: string;
}> {

  console.warn(
    "[ResearchGuard] search-required request but no toolRequests. retrying once."
  );

  // STEP163: Base(context.taskProfile.modelTier)とBrain Recommendation
  // をresolveEffectiveModelTier()(core/brain/effectiveModelTier.ts)で
  // 調停済みのcontext.effectiveModelTierを優先する。未確定の場合
  // (taskProfile自体が未確定な場合を含む)はcontext.taskProfile?.modelTier
  // へ、それも無ければresolveExecutionStrategy()内部の既定動作
  // (economy相当)へフォールバックする。Brainの生Recommendationを
  // 直接渡さない(STEP163絶対条件2)。
  const executionStrategy =
    resolveExecutionStrategy(
      context.effectiveModelTier ?? context.taskProfile?.modelTier
    );

  // buildPrompt()のmemory引数はRecord<string, string[]>だが、
  // WorkflowContext.memoryはBrainRuleも許容する(既存の型不一致。
  // runAgent()本体はcontext: anyのため表面化していなかった)。
  // STEP33の範囲外のため、ここでは変換せずキャストのみで対応する。
  const promptMemory =
    context.memory as unknown as Record<string, string[]>;

  const retryPrompt =
    buildPrompt(
      agent.id,
      context.userInput,
      step.task,
      context.outputs,
      context.stepOutputs,
      {},
      promptMemory,
      context.handoffs,
      relevantEvidence,
      context.mode,
      context.currentOutput,
      context.brainMemory
    ) +
    `

重要(再確認):

今回のユーザー要求は、外部の最新情報・一次情報の検索を
明確に必要としています。

しかし直前の回答にtoolRequestsが含まれていませんでした。

必要な調査のため、web-searchのtoolRequestsを
必ず1つ以上含めてJSONを返してください。

既存Evidenceだけで今回の要求を十分に裏付けられる場合を除き、
検索せずに具体的な数値・統計・企業情報等を新しく作成しては
いけません。
`;

  const retryResult =
    await runLLMWithFallback({
      provider: executionStrategy.provider,
      model: executionStrategy.model,
      systemPrompt: agent.systemPrompt,
      userPrompt: retryPrompt,
    });

  const retryResponse = retryResult.response;

  // STEP159: Workflow全体のコスト集計へ加算する。
  accumulateLLMCost(context.costAccumulator, retryResponse.cost);

  // STEP168: 実際に使用されたProvider/Modelを記録する
  // (Fallback発生時はSecondary側の値になる)。
  recordActualExecution(
    context.actualExecution,
    retryResult.actualProvider,
    retryResult.actualModel
  );

  const retryCleaned =
    cleanJSON(retryResponse.content ?? "");

  if (!retryCleaned) {
    return { parsed: null, toolResults: {}, finalPrompt: retryPrompt };
  }

  let retryParsed: any;

  try {
    retryParsed = JSON.parse(retryCleaned);
  } catch {
    // 再試行の応答が壊れていた場合は、呼び出し元が元のparsedを
    // 維持できるようnullを返す(安全側)。
    return { parsed: null, toolResults: {}, finalPrompt: retryPrompt };
  }

  if (
    !Array.isArray(retryParsed.toolRequests) ||
    retryParsed.toolRequests.length === 0
  ) {

    // 再試行してもtoolRequestsを発行しなかった場合。
    // 検索は「未実行」のまま扱い、判断はEvidence Guardに委ねる。
    return { parsed: retryParsed, toolResults: {}, finalPrompt: retryPrompt };

  }

  const toolResults =
    await executeToolCalls(
      retryParsed.toolRequests,
      context.userInput,
      context.taskProfile?.searchIntensity
    );

  for (const toolOutputs of Object.values(toolResults)) {

    if (!Array.isArray(toolOutputs)) continue;

    for (const toolResult of toolOutputs as any[]) {

      if (
        toolResult?.data?.evidence &&
        Array.isArray(toolResult.data.evidence)
      ) {

        context.evidence.push(
          ...toolResult.data.evidence
        );

      }

    }

  }

  // STEP77: userPrompt1/2と同じ理由でローカル変数へ保持する。
  const finalPrompt =
    buildPrompt(
      agent.id,
      context.userInput,
      step.task,
      context.outputs,
      context.stepOutputs,
      toolResults,
      promptMemory,
      context.handoffs,
      relevantEvidence,
      context.mode,
      context.currentOutput,
      context.brainMemory
    ) +
    `

重要:

Tool実行は完了しています。

Tool Results を利用して、
あなた本来のJSONを完成させてください。

toolRequestsだけを返して終了してはいけません。

toolRequestsは必ず空配列にしてください。

`;

  const finalResult =
    await runLLMWithFallback({
      provider: executionStrategy.provider,
      model: executionStrategy.model,
      systemPrompt: agent.systemPrompt,
      userPrompt: finalPrompt,
    });

  const finalResponse = finalResult.response;

  // STEP159: Workflow全体のコスト集計へ加算する。
  accumulateLLMCost(context.costAccumulator, finalResponse.cost);

  // STEP168: 実際に使用されたProvider/Modelを記録する。
  recordActualExecution(
    context.actualExecution,
    finalResult.actualProvider,
    finalResult.actualModel
  );

  const finalCleaned =
    cleanJSON(finalResponse.content ?? "");

  if (!finalCleaned) {
    return { parsed: retryParsed, toolResults, finalPrompt: retryPrompt };
  }

  try {

    const finalParsed =
      JSON.parse(finalCleaned);

    return { parsed: finalParsed, toolResults, finalPrompt };

  } catch {

    return { parsed: retryParsed, toolResults, finalPrompt: retryPrompt };

  }

}

// =========================
// reviewWriterOutput (STEP67)
// =========================
//
// 背景: STEP65の調査で、現在のReviewerはWriter実行前(Researcher/
// Analyst/Designer/Engineer/Stakeholderの成果物)しか見ておらず、
// Writerが実際に生成した最終文章そのものを読んで批評する経路が
// 存在しないことが判明した。本関数は、既存のreviewer Agent定義
// (systemPrompt・Output Format)を一切変更せず、Writer実行後に
// 「文章を読むCritic」として1回だけ追加で呼び出すための専用関数。
//
// 既存のrunAgent()本体とは意図的に分離している:
// ・runAgent()は`context.outputs[agent.id] = parsed`で結果を保存する
//   ため、そのまま流用するとWriter実行前Reviewerの判定
//   (context.outputs.reviewer。core/brain/analyzer.tsと
//   core/advisor/buildAdvisorContext.tsが既存の意味で参照している)を
//   上書きしてしまう。
// ・本関数の戻り値は呼び出し元(core/workflow/index.ts)が
//   context.writerCritique(STEP67で追加した新フィールド)へ格納する
//   だけで、context.outputs.reviewer・context.reviewHistory・
//   handleReviewer()のretry/loop処理には一切触れない
//   (=自動修正・再実行は発生しない)。
//
// Evidenceの渡し方は、runAgent()本体のreviewer分岐と同じ考え方
// (Analystが実際に参照したEvidenceを主とし、自身のselectEvidence()
// 結果で補う)をそのまま再利用する。新しいEvidence管理機構は
// 作らない。
//
// Writer自体は再実行しない。失敗時はnullを返すだけで、
// 例外を投げてWorkflow全体を止めることはしない
// (呼び出し元でも念のためtry/catchする)。
export async function reviewWriterOutput(
  reviewerAgent: Agent,
  context: WorkflowContext
): Promise<unknown | null> {

  // STEP163: context.effectiveModelTier(Brain Recommendationを
  // resolveEffectiveModelTier()で調停済みの値)を優先し、未確定なら
  // context.taskProfile?.modelTierへフォールバックする。
  const executionStrategy =
    resolveExecutionStrategy(
      context.effectiveModelTier ?? context.taskProfile?.modelTier
    );

  const writerOutput = context.outputs.writer;

  if (!writerOutput) {
    return null;
  }

  const ownSelectedEvidence: Evidence[] =
    selectEvidence(
      context.evidence,
      [
        context.userInput,
        "final output summary structure",
      ]
        .filter(Boolean)
        .join(" "),
      15
    );

  const relevantEvidence: Evidence[] =
    context.analystEvidence
      ? mergeEvidenceById(
          context.analystEvidence,
          ownSelectedEvidence,
          15
        )
      : ownSelectedEvidence;

  const promptMemory =
    context.memory as unknown as Record<string, string[]>;

  // STEP81: composedTask(context.userInput、buildPrompt()の
  // "Original User Request"として既に渡っている)は、Task
  // Reconstruction(LLM)による言い換えを経ているため、ユーザーが
  // 明示した禁止フレーズ・制約の正確な文言が失われている場合がある
  // (STEP80実測: 「単に『AIスキルもクリティカルシンキングも重要』
  // という結論にはしないでください」という明示的な禁止が、
  // composedTaskでは「一般論にならないように」という曖昧な制約へ
  // 言い換えられていた)。STEP75/76で確立した既存パターン
  // (rawUserInputがあれば優先、無ければuserInputへフォールバック)を
  // ここでも踏襲し、⑦軸の判定材料としてのみ生のユーザー発言を
  // 追加で示す。新しい状態管理・新しいcontextフィールドは追加しない
  // (context.rawUserInputは既存STEP75フィールド)。
  const rawUserRequestForCritique =
    context.rawUserInput &&
    context.rawUserInput !== context.userInput
      ? context.rawUserInput
      : null;

  const criticPrompt =
    buildPrompt(
      "reviewer",
      context.userInput,
      "Writerが生成した最終文章(Workflow History内のWRITERの出力)を、" +
        "独立したCriticとしてレビューする(STEP67)。",
      context.outputs,
      context.stepOutputs,
      {},
      promptMemory,
      context.handoffs,
      relevantEvidence,
      context.mode,
      context.currentOutput,
      context.brainMemory
    ) +
    `

========================
今回のレビュー対象(STEP67: Writer最終文章のCritic)
========================

今回はいつもの「Researcher/Analyst/Designer/Engineer/Stakeholderの
成果物」に対するレビューではありません。

Workflow History内のWRITERの出力(title/executiveSummary/sections[]/
keyFindings/recommendations等)が、今回の評価対象です。

Writerのsections[].evidenceIdsは、Shared Evidence内に実在するIDです
(形式・実在性は既にコード側で機械検証済みです)。ここでは形式では
なく、「そのEvidenceが実際にsectionの主張を支持しているか」という
意味的な妥当性だけを確認してください。
${
  rawUserRequestForCritique
    ? `
------------------------
ユーザーの生の発言(参考・⑦の判定に使用)
------------------------

上記の"Original User Request"はTask Reconstruction(LLM)による
言い換えを経ています。ユーザーが実際に使った禁止表現・制約の
正確な文言を確認する際は、以下の生の発言を優先してください。

${rawUserRequestForCritique}
`
    : ""
}
以下の観点でWriterの文章そのものを評価してください。

①Evidenceとの整合性
Writerの主張がEvidenceから支持されているか。
Evidenceに存在しない事実を断定していないか、Evidenceの意味を
過度に拡張していないか、数値・固有名詞・因果関係を書き換えて
いないかを確認してください。

②論理の飛躍
Evidence→主張→結論の間に不自然な飛躍がないか確認してください。
「Aという事実がある。したがってBである。」という文章で、
AからBが論理的に導けない場合は問題として指摘してください。

③反証(Counterargument)の扱い
Workflow History内のANALYSTがinsights[].counterArgumentsを
持っている場合、Writerがその反証を無視して断定していないか、
結論の確信度がEvidenceに対して強すぎないか確認してください。
counterArgumentsが存在しないこと自体は問題にしないでください。

④重複
同じ内容を複数のsectionで繰り返していないか確認してください。

⑤構造
文章が単なるEvidenceの羅列になっていないか、
「何が分かったのか」「なぜそう言えるのか」「どこに限界があるのか」
が適切に整理されているか確認してください。

⑥表現の過剰さ
Evidenceから言える範囲を超えて、「必ず」「明らかに」「すべて」
「決定的に」「圧倒的に」などの過剰な断定をしていないか確認して
ください。

⑦ユーザーの核心論点への対応度(STEP81)
「ユーザーのテーマについて書いているか」ではなく、
「ユーザーが何を考えさせようとしていたかに答えているか」を
評価してください。具体的には以下を確認してください。

・ユーザーが明示した核心的な問いに、Writerの文章が実際に
  答えているか(問いに触れているだけで、答えを出していない場合も
  問題として扱ってください)
・ユーザーが「避けてほしい」「〜だけにしないでほしい」等と明示した
  結論・フレームに、Writerが安易に収束していないか
・ユーザーが求めた比較・対立する立場・前提の検討が、Writerの文章
  から抜け落ちていないか
・ユーザーが「なぜ」「そもそも」「本質的に」等の深掘りを要求して
  いる場合、Writerがそれを表層的な「どうすればよいか(How)」の話に
  すり替えていないか
・ユーザー独自の問題設定が、一般論(誰にでも言えるテーマの説明)へ
  すり替わっていないか
・Writerの結論が、ユーザーが設定した問題そのものから論理的に
  導かれているか(問題設定と無関係な一般的結論になっていないか)

この軸は、①〜⑥のようなWriterの文章内部の整合性ではなく、
「ユーザーの元の要求」と「Writerの文章」を突き合わせて評価する
軸です。Writerの文章が内部的に破綻なく書けていても、ユーザーの
核心的な問いに答えていなければ、この軸では問題として扱ってください。

------------------------
出力について
------------------------

既存のReviewer Output Format(approved/score/issues/strengths/
improvements/missingEvidence/retry)をそのまま使ってください。
新しいフィールドは追加しません。

issues・improvementsの各項目の先頭に、上記①〜⑦のどれに該当するか
を[]で明記してください(例:「[論理飛躍] 〜」「[Evidence整合性] 〜」
「[ユーザー論点] 〜」)。
根拠が薄い、またはevidenceIdsが空なのに具体的な事実を含むsectionが
ある場合は、missingEvidenceに記載してください。

このレビューは記録・診断のみが目的です。今回はこの結果を使って
Writerを再実行することはありません。retryは必ず空配列 [] にして
ください。
`;

  let response;

  try {

    const result =
      await runLLMWithFallback({
        provider: executionStrategy.provider,
        model: executionStrategy.model,
        systemPrompt: reviewerAgent.systemPrompt,
        userPrompt: criticPrompt,
      });

    response = result.response;

    // STEP159: Workflow全体のコスト集計へ加算する。
    accumulateLLMCost(context.costAccumulator, response.cost);

    // STEP168: 実際に使用されたProvider/Modelを記録する。
    recordActualExecution(
      context.actualExecution,
      result.actualProvider,
      result.actualModel
    );

  } catch (error) {

    console.warn(
      "[WriterCritique] LLM call failed:",
      error
    );

    return null;

  }

  const cleaned = cleanJSON(response.content ?? "");

  if (!cleaned) {
    return null;
  }

  let parsed: unknown;

  try {

    parsed = JSON.parse(cleaned);

  } catch (error) {

    console.warn(
      "[WriterCritique] JSON parse failed:",
      error
    );

    return null;

  }

  saveAgentLog(
    "reviewer_writer_critique",
    {
      prompt: criticPrompt,
      response,
      parsed,
      evidence: relevantEvidence,
    }
  );

  return parsed;

}

// =========================
// reviseWriterOutput (STEP68)
// =========================
//
// 背景: STEP67のreviewWriterOutput()は「Writerの文章を読んで批評する」
// ところまでで、批評結果を反映してWriterが書き直す経路が無かった。
// 本関数は、既存のwriter Agent定義(systemPrompt)を一切変更せず、
// reviewWriterOutput()と同じ「userPrompt addendumを追記する専用
// ヘルパー」パターンで、Reviewerの指摘だけを踏まえた最小限の
// 書き直しをWriterへ1回だけ依頼する。
//
// runAgent()本体を経由しない理由はreviewWriterOutput()と同じ:
// runAgent()のbuildPrompt()呼び出しでは、agentId="writer"時の
// visibleOutputs.writerに"writer"自身が含まれないため、Writer自身の
// 直前の出力を明示的に見せられない。また、conversation.currentOutput
// (前Turnの成果物。core/prompt/builder.tsのcurrentOutputSection)を
// 「今回書き直す対象」として流用すると、複数Turn編集用の既存の
// 意味と衝突するおそれがある。そのため、Revision対象のWriter出力・
// Reviewerの指摘は、reviewWriterOutput()と同じくaddendumブロックで
// 明示的に渡す。
//
// Evidenceは新規取得せず、reviewWriterOutput()と同じ考え方
// (Analystが実際に参照したEvidenceを主とし、自身のselectEvidence()
// 結果で補う)で選び直すだけ。新しいEvidence管理機構は作らない。
//
// 戻り値は、STEP66のvalidateEvidenceIds()を適用した後のWriter出力。
// 呼び出し元(core/workflow/index.ts)がcontext.outputs.writerへ
// 反映するかどうかを判断する(本関数はcontextを書き換えない)。
// 失敗時はnullを返すだけで、例外を投げてWorkflow全体を止めない
// (呼び出し元でも念のためtry/catchする)。
export async function reviseWriterOutput(
  writerAgent: Agent,
  context: WorkflowContext,
  critique: unknown
): Promise<unknown | null> {

  // STEP163: context.effectiveModelTierを優先し、未確定なら
  // context.taskProfile?.modelTierへフォールバックする。
  const executionStrategy =
    resolveExecutionStrategy(
      context.effectiveModelTier ?? context.taskProfile?.modelTier
    );

  const currentWriterOutput = context.outputs.writer;

  if (!currentWriterOutput) {
    return null;
  }

  const ownSelectedEvidence: Evidence[] =
    selectEvidence(
      context.evidence,
      [
        context.userInput,
        "final output summary structure",
      ]
        .filter(Boolean)
        .join(" "),
      15
    );

  const relevantEvidence: Evidence[] =
    context.analystEvidence
      ? mergeEvidenceById(
          context.analystEvidence,
          ownSelectedEvidence,
          15
        )
      : ownSelectedEvidence;

  const promptMemory =
    context.memory as unknown as Record<string, string[]>;

  const c = critique as {
    approved?: unknown;
    score?: unknown;
    issues?: unknown;
    improvements?: unknown;
    missingEvidence?: unknown;
  };

  // STEP82: STEP81で追加した⑦「ユーザーの核心論点への対応度」の
  // 指摘が含まれるかどうかを、issues/improvements内の
  // "[ユーザー論点]"タグ(STEP81のreviewWriterOutput()が
  // 付与する既存の分類タグ、新しいフィールドではない)の有無で
  // 機械的に判定する。新しいLLM呼び出しは追加しない。
  const issuesList: unknown[] =
    Array.isArray(c.issues) ? c.issues : [];

  const improvementsList: unknown[] =
    Array.isArray(c.improvements) ? c.improvements : [];

  const hasUserIntentIssue =
    [...issuesList, ...improvementsList].some(
      (item) =>
        typeof item === "string" &&
        item.includes("[ユーザー論点]")
    );

  // STEP82: reviewWriterOutput()(STEP81)と同じ理由・同じパターンで、
  // composedTask(context.userInput)がTask Reconstructionの言い換えを
  // 経て、ユーザーが明示した禁止フレーズ・制約の正確な文言を
  // 失っている場合があることを踏まえ、Revisionにも生のユーザー発言を
  // 判定材料として渡す。既存STEP75フィールド(context.rawUserInput)を
  // 再利用するだけで、新しいcontextフィールドは追加しない。
  const rawUserRequestForRevision =
    context.rawUserInput &&
    context.rawUserInput !== context.userInput
      ? context.rawUserInput
      : null;

  // STEP82: ⑦の指摘がある場合のみ、「構造的な修正」を許可する
  // 追加ブロック。通常のCritique(Evidence整合性・論理飛躍・反証・
  // 重複・構造・表現)に対する既存の「最小修正」方針はそのまま維持し、
  // このブロックが無い場合の挙動は従来と完全に同じにする。
  const structuralRevisionBlock =
    hasUserIntentIssue
      ? `

------------------------
⑦ユーザー核心論点への対応(STEP82: 構造的修正の許可)
------------------------

今回のReviewerの指摘には、上記の「修正方針」が前提とする
軽微な修正だけでは解消できない種類の指摘が含まれています
([ユーザー論点]タグが付いたissues/improvements)。

この[ユーザー論点]の指摘に限り、以下の「修正方針」の
「元の文章の良い部分はそのまま維持する」「小さな言い回しの
調整を超える改変はしない」という制約の例外として、
文章構造そのものの変更を許可します。

[ユーザー論点]の指摘を解消するために、以下を行ってよい。

・新しい論点の追加
・セクションの追加
・セクション順序の変更
・比較構造(賛成/反対、複数の立場の対比等)の追加
・結論の再構成(既存の結論を書き直すことを含む)
・必要に応じた既存段落の削除・統合

目的は文章量を増やすことではありません。
[ユーザー論点]の指摘が指し示す、ユーザーが本来求めていた問い・
論点をFinal Outputへ戻すことが目的です。

ただし、以下は禁止のままです。

・ユーザーが求めていない新しい話題を勝手に追加すること
・新しい事実・数値・引用・出典を創作すること(下記「修正方針」の
  禁止事項は[ユーザー論点]の指摘であっても変わりません)
・Evidenceに反する内容を作ること

何がユーザーの求めていた問い・制約かを判断する際は、
下記の"Original User Request"よりも、以下の
「ユーザーの生の発言」を優先してください
(Original User RequestはTask Reconstructionによる言い換えを
経ており、ユーザーが実際に使った禁止表現・制約の正確な文言が
失われている場合があります)。
${
  rawUserRequestForRevision
    ? `
------------------------
ユーザーの生の発言(参考・⑦の指摘解消に使用)
------------------------

${rawUserRequestForRevision}
`
    : "\n(今回、composedTaskと異なる生の発言は渡されていません。" +
      "Original User Requestをそのまま判断材料としてください)\n"
}
[ユーザー論点]以外の指摘(Evidence整合性・論理飛躍・反証・重複・
構造・表現)については、引き続き下記の「修正方針」どおり
最小修正としてください。
`
      : "";

  const revisionPrompt =
    buildPrompt(
      "writer",
      context.userInput,
      "ReviewerのCritiqueを踏まえて、直前のWriter出力を修正する" +
        "(Revision, STEP68。ユーザー核心論点に関する指摘がある場合の" +
        "構造的修正はSTEP82)。",
      context.outputs,
      context.stepOutputs,
      {},
      promptMemory,
      context.handoffs,
      relevantEvidence,
      context.mode,
      context.currentOutput,
      context.brainMemory
    ) +
    `

========================
Revision(STEP68: Reviewerの指摘を反映した書き直し)
========================

これは新規作成ではありません。今回はあなた自身が既に作成した
以下の「現在のWriter出力」を、Reviewerの指摘に基づいて
修正するタスクです。

------------------------
現在のWriter出力(修正対象)
------------------------

${JSON.stringify(currentWriterOutput, null, 2)}

------------------------
Reviewerの評価(このRevisionの根拠)
------------------------

approved: ${JSON.stringify(c.approved)}
score: ${JSON.stringify(c.score)}

issues:
${JSON.stringify(c.issues ?? [], null, 2)}

improvements:
${JSON.stringify(c.improvements ?? [], null, 2)}

missingEvidence:
${JSON.stringify(c.missingEvidence ?? [], null, 2)}
${structuralRevisionBlock}
------------------------
修正方針
------------------------

・元の文章の良い部分はそのまま維持してください
・Reviewerがissues/improvementsで指摘した問題だけを修正してください
・Evidenceと矛盾する記述は削除または修正してください
・Evidenceから導けない断定は、Evidenceが支持する範囲まで弱めて
  ください
・論理が飛躍している箇所を補正してください
・重複している内容を削減してください
・Workflow History内のANALYSTがcounterArgumentsを持っている場合、
  それを無視した断定になっていないか確認し、必要なら修正して
  ください
・Reviewerが問題視していない部分は、不必要に大きく書き換えないで
  ください(小さな言い回しの調整を超える改変はしない。ただし上記の
  「⑦ユーザー核心論点への対応」ブロックが存在する場合、
  [ユーザー論点]の指摘についてはその指示を優先してください)
・新しい事実・数値・引用・出典を創作してはいけません
・新しいEvidence IDを作成してはいけません。sections[].evidenceIdsは
  Shared Evidence(またはWorkflow History内のAnalystの
  insights[].evidenceIds等)に実在するIDのみを使用してください
・今回はEvidenceを再調査する場面ではありません。Evidenceが不足して
  いる場合は、不足したまま書くか、既存のlimitations等のフィールドで
  その旨を示してください
・最終的な文章が「より正確になること」を最優先してください

------------------------
出力について
------------------------

必ずこのプロンプトの末尾に付与されている既存の
「Writer Output Format」に従い、修正後の完全なJSONを1つだけ
返してください(差分やコメントではなく、完全な出力全体を返して
ください)。
`;

  let response;

  try {

    const result =
      await runLLMWithFallback({
        provider: executionStrategy.provider,
        model: executionStrategy.model,
        systemPrompt: writerAgent.systemPrompt,
        userPrompt: revisionPrompt,
      });

    response = result.response;

    // STEP159: Workflow全体のコスト集計へ加算する。
    accumulateLLMCost(context.costAccumulator, response.cost);

    // STEP168: 実際に使用されたProvider/Modelを記録する。
    recordActualExecution(
      context.actualExecution,
      result.actualProvider,
      result.actualModel
    );

  } catch (error) {

    console.warn(
      "[WriterRevision] LLM call failed:",
      error
    );

    return null;

  }

  const cleaned = cleanJSON(response.content ?? "");

  if (!cleaned) {
    return null;
  }

  let parsed: unknown;

  try {

    parsed = JSON.parse(cleaned);

  } catch (error) {

    console.warn(
      "[WriterRevision] JSON parse failed:",
      error
    );

    return null;

  }

  // STEP66のvalidateEvidenceIds()をRevision後の出力にも必ず適用する。
  // 新しいEvidence validationシステムは作らない。
  const { cleaned: validated, issues: evidenceIssues } =
    validateEvidenceIds(
      parsed as AnalystOutput,
      relevantEvidence,
      ["sections"]
    );

  if (evidenceIssues.length > 0) {

    console.warn(
      "Writer Revision evidenceId issues:",
      evidenceIssues
    );

  }

  saveAgentLog(
    "writer_revision",
    {
      prompt: revisionPrompt,
      response,
      parsed: validated,
      evidence: relevantEvidence,
      evidenceIssues,
    }
  );

  return validated;

}

// =========================
// generateHoldConclusion (STEP113)
// =========================
//
// 背景: STEP112までの実測で、HOLD時にWriterへ「新しい結論を作るな」と
// どれだけ指示しても、Case C/F(recommendations=[]、insights/risks/
// opportunitiesが唯一の材料)では、Writerが1回の生成の中で「事実→
// 分析→統合結論」という既存の生成習慣(responsibilities.ts「結論から
// 書く」・core/agents/writer.tsの「事実→分析→結論」)に引っ張られ、
// 新しい統合結論を合成してしまう問題が残っていた(GEN単体でCase C/F
// 0%→20%止まり)。
//
// STEP113で、ExecutiveSummary生成を「事実・分析の要約(Phase1、
// runAgent()本体・phase1DeferralBlockが担当)」と「なぜ判断できないかの
// 結論(Phase2、本関数)」に分離したところ、Case Cが20%→80%まで改善
// することを実測した。
//
// 本関数はPhase1で生成された(意図的に結論を含まない)executiveSummary
// を受け取り、「なぜ現時点で優先順位を決定できないか」という結論部分
// だけを追記した完全なexecutiveSummaryを返す。status !== "HOLD"の
// 場合は呼び出し側(runAgent()本体)がそもそも呼び出さないため、本関数
// 内部でstatusの分岐は行わない。
//
// reviewWriterOutput()/reviseWriterOutput()と同じく、失敗時はnullを
// 返すだけでWorkflow全体を止めない。呼び出し元はnullの場合Phase1の
// 結果をそのまま使う。
export async function generateHoldConclusion(
  writerAgent: Agent,
  phase1ExecutiveSummary: string,
  analystOutput: unknown,
  conclusionState: ConclusionState,
  evidence: Evidence[],
  // STEP157: 呼び出し元のcontext.taskProfileをそのまま受け取るだけ
  // (この関数自体はWorkflowContextを持たないため、必要な値だけを
  // 引数として渡す)。省略時はresolveExecutionStrategy()が
  // economy相当へフォールバックする。
  taskProfile?: TaskProfile,
  // STEP159: 呼び出し元のcontext.costAccumulatorをそのまま受け取り、
  // このLLM呼び出し分のcostを加算するためだけに使う。この関数自体は
  // WorkflowContextを持たないため(STEP157の設計を踏襲)、戻り値の
  // 契約(Promise<string|null>)は変更せず、参照渡しの累積器へ直接
  // 加算する。
  costAccumulator?: { tokens: number; estimatedUSD: number },
  // STEP163: 呼び出し元のcontext.effectiveModelTier(Brain
  // Recommendationをresolve EffectiveModelTier()で調停済みの値)を
  // そのまま受け取るだけ。省略時はtaskProfile?.modelTierへ、
  // それも無ければresolveExecutionStrategy()の既定動作
  // (economy相当)へフォールバックする。
  effectiveModelTier?: ModelTier,
  // STEP168: 呼び出し元のcontext.actualExecutionをそのまま受け取り、
  // 実際に使用されたProvider/Modelを記録するためだけに使う
  // (costAccumulatorと同じ「参照渡しの保持先」パターン)。
  actualExecution?: { provider?: Provider; model?: string }
): Promise<string | null> {

  // STEP163: effectiveModelTierを優先し、未確定ならtaskProfile?.modelTier
  // へフォールバックする。
  const executionStrategy =
    resolveExecutionStrategy(
      effectiveModelTier ?? taskProfile?.modelTier
    );

  const evidenceSummary =
    evidence
      .map((e) => `ID: ${e.id}\nclaim: ${e.claim}`)
      .join("\n\n");

  const prompt = `
あなたはTACTのWriterです。以下は、レポートのexecutiveSummaryの
前半部分(事実と分析の要約のみ、意図的に結論を含んでいません)です。

========================
前半部分(すでに確定・変更しないこと)
========================

${phase1ExecutiveSummary}

========================
Analystの分析状態
========================

STATUS: ${conclusionState.status}
REASON: ${conclusionState.reason}

========================
Analystの分析結果(参考)
========================

${JSON.stringify(analystOutput, null, 2)}

========================
Shared Evidence
========================

${evidenceSummary}

========================
あなたのタスク
========================

上記の前半部分に続けて、「なぜ現時点で優先順位・方針を決定できない
のか」を説明する結論部分(1〜3文)だけを追加してください。前半部分は
書き換えないでください。

以下は絶対に書かないでください。

・新しい優先順位(「Aを優先すべき」等)
・「両方進めるべき」「バランスよく育成すべき」等の統合的な提言
・Analystが示していない具体的な方針・提案

「なぜ判断できないのか」「何が分かれば判断できるのか」だけを
書いてください。

========================
出力
========================

必ずJSONのみで返してください。前半部分と結論部分を結合した、
完全なexecutiveSummary全文を返してください。

{
  "executiveSummary": "完全なexecutiveSummary全文(前半+結論)"
}
`;

  let response;

  try {

    const result =
      await runLLMWithFallback({
        provider: executionStrategy.provider,
        model: executionStrategy.model,
        systemPrompt: writerAgent.systemPrompt,
        userPrompt: prompt,
      });

    response = result.response;

    // STEP159: Workflow全体のコスト集計へ加算する。
    accumulateLLMCost(costAccumulator, response.cost);

    // STEP168: 実際に使用されたProvider/Modelを記録する。
    recordActualExecution(
      actualExecution,
      result.actualProvider,
      result.actualModel
    );

  } catch (error) {

    console.warn(
      "[HoldConclusion] LLM call failed:",
      error
    );

    return null;

  }

  const cleaned = cleanJSON(response.content ?? "");

  if (!cleaned) {
    return null;
  }

  let parsed: unknown;

  try {

    parsed = JSON.parse(cleaned);

  } catch (error) {

    console.warn(
      "[HoldConclusion] JSON parse failed:",
      error
    );

    return null;

  }

  const executiveSummary =
    (parsed as { executiveSummary?: unknown })?.executiveSummary;

  if (typeof executiveSummary !== "string" || executiveSummary.length === 0) {
    return null;
  }

  saveAgentLog(
    "writer_hold_conclusion",
    {
      prompt,
      response,
      phase1ExecutiveSummary,
      finalExecutiveSummary: executiveSummary,
    }
  );

  return executiveSummary;

}

function saveAgentLog(
  agentId: string,
  data: unknown
) {

  const logDir =
    path.join(
      process.cwd(),
      "logs"
    );

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }

  const fileName =
    `${Date.now()}-${agentId}.json`;

  fs.writeFileSync(

    path.join(
      logDir,
      fileName
    ),

    JSON.stringify(
      data,
      null,
      2
    )

  );

}

export async function runAgent(
  agent: Agent,
  step: any,
  context: any
) {

  context.logs.push({
    type: "start",
    agent: agent.id,
    timestamp: new Date().toISOString(),
  });

  console.log("\n====================================");
  console.log(`${agent.name} START`);
  console.log(`Task : ${step.task}`);
  console.log("====================================");

  // STEP163: context.effectiveModelTier(Brain Recommendationを
  // resolveEffectiveModelTier()で調停済みの値)を優先し、未確定なら
  // context.taskProfile?.modelTierへ、それも無ければ
  // resolveExecutionStrategy()内部の既定動作(economy相当)へ
  // フォールバックする。Planner自身の実行時点ではtaskProfile/
  // effectiveModelTierとも未確定のため、常にeconomy相当
  // (既存のgpt-4o-mini)になる(Plannerのモデル選択を無理に変更
  // しない、というSTEP157の方針を維持)。
  const executionStrategy =
    resolveExecutionStrategy(
      context.effectiveModelTier ?? context.taskProfile?.modelTier
    );

let toolResults: Record<string, unknown> = {};


// ===============================
// QueryBuilder Output
// ===============================

const queryBuilderOutput =
  context.outputs.queryBuilder ?? null;

const shouldRetrieveEvidence =
  [
    "researcher",
    "analyst",
    "designer",
    "engineer",
    "stakeholder",
    "reviewer",
    "writer",
  ].includes(agent.id);

const evidenceQueryByAgent = {

researcher: [
  context.userInput,
  step.task,
  context.outputs.queryBuilder
    ? JSON.stringify(context.outputs.queryBuilder)
    : "",
]
.filter(Boolean)
.join(" "),

analyst: [
  context.userInput,
  step.task,
  "competitor market SWOT pricing positioning comparison",
]
  .filter(Boolean)
  .join(" "),

designer: [
  context.userInput,
  step.task,
  "UI UX layout flow",
]
  .filter(Boolean)
  .join(" "),

engineer: [
  context.userInput,
  step.task,
  "API DB architecture implementation",
]
  .filter(Boolean)
  .join(" "),

stakeholder: [
  context.userInput,
  step.task,
  "value risk user business",
]
  .filter(Boolean)
  .join(" "),
  
reviewer: [
  context.userInput,
  step.task,
  "consistency quality gaps",
]
  .filter(Boolean)
  .join(" "),

writer: [
  context.userInput,
  step.task,
  "final output summary structure",
]
  .filter(Boolean)
  .join(" "),

} as Record<string, string>;

const ownSelectedEvidence: Evidence[] =
  shouldRetrieveEvidence
    ? selectEvidence(
        context.evidence,
        evidenceQueryByAgent[agent.id] ??
          `${context.userInput} ${step.task}`,
        15
      )
    : [];

// Reviewerは、Analystが実際に参照したEvidence(context.analystEvidence)を
// 主として使い、不足分だけ自身のselectEvidence()結果で補う。
// Analystが実行されていないWorkflowでは従来どおり自身の選定結果のみを使う。
const relevantEvidence: Evidence[] =
  agent.id === "reviewer" &&
  context.analystEvidence
    ? mergeEvidenceById(
        context.analystEvidence,
        ownSelectedEvidence,
        15
      )
    : ownSelectedEvidence;

if (agent.id === "analyst") {
  context.analystEvidence = relevantEvidence;
}

// ===============================
// Writer Evidence Safety Net (STEP34)
// ===============================
//
// 背景: STEP33でResearcherの未検証Evidenceは遮断できるようになったが、
// その後段のWriterが、Shared Evidenceが空(または今回のWeb Evidenceが
// 存在しない)状況でも、市場規模・企業名等の具体的な事実を独自に
// 生成してしまうケースが実機で確認された。
//
// Writerのsystem prompt(core/agents/writer.ts)自体は変更せず、
// 以下の条件を満たす場合のみ、既存のTool Results追記(2-pass)と
// 同じパターンでuserPromptへ追加指示を差し込む。
//
// 条件(STEP33のcontext.researchGuardをそのまま再利用。新しい状態
// 管理は追加しない):
// ・researchRequired === true (今回のTaskで外部検索が必要と判定)
// ・searchSucceeded === false (検索が成功していない=未実行/失敗)
// ・relevantEvidenceにWeb由来(sourceTypeがuser_file以外)の
//   Evidenceが1件も存在しない
//
// ユーザー添付ファイル由来のEvidence(sourceType: user_file)は
// 対象外とし、そちらに基づく記述は従来どおり許可する。
let writerSafetyNetBlock = "";

// STEP34: 後段(2-pass後の事後チェック)でも同じ判定結果を使うため、
// この関数スコープ内で共有できるよう外側で宣言する。
let writerSafetyNetActive = false;

if (agent.id === "writer") {

  const hasWebEvidence =
    relevantEvidence.some(
      (e) => e.sourceType !== "user_file"
    );

  writerSafetyNetActive =
    context.researchGuard?.researchRequired === true &&
    context.researchGuard?.searchSucceeded === false &&
    !hasWebEvidence;

  if (writerSafetyNetActive) {

    console.warn(
      "[WriterSafetyNet] active: no web evidence for a search-required task."
    );

    writerSafetyNetBlock = `

========================
重要(Evidence不足時の安全網 - STEP34)
========================

今回のTaskは外部の最新情報・事実確認を必要としていますが、
Web検索によるEvidenceを取得できませんでした
(ユーザーが添付したファイル由来のEvidenceは除きます)。

そのため、今回に限り以下を厳守してください。

・Evidenceで確認できない具体的な事実を新規生成しない
・根拠のない具体的な数値(市場規模・成長率・シェア等)を生成しない
・根拠のない企業名・サービス名・人物名を事実として追加しない
・Evidenceにない最新情報を推測で補完しない
・確認できない場合は「確認できない」「現時点で取得できる根拠が
  不足している」と明示する(limitations等の既存フィールドを使う)

ただし、これは「何も書かない」という意味ではありません。

・一般的な整理・構成・分析・比較軸の提示は、新しい事実の
  捏造を伴わない範囲で可能な限り継続してください
・ユーザーが添付したファイル由来のEvidence(sourceType: user_file)
  に基づく記述は、通常どおり行ってください
・もっともらしい架空の情報を作るくらいなら、
  「確認できない」と明示することを優先してください
`;

  }

}

// ===============================
// Writer Attachment Evidence Emphasis (STEP35)
// ===============================
//
// 背景: buildAttachmentEvidence()由来(sourceType: user_file)の
// Evidenceは、core/evidence/retrieveEvidence.ts(sourceTypeWeight・
// isPrimarySource)の改善により選ばれやすくなり、core/prompt/
// builder.tsのbuildEvidenceSummary()によりWeb由来Evidenceと
// 区別して提示されるようになった。ここではその上で、Writerが
// 「添付資料は今回のユーザーが直接提供した一次資料である」ことを
// 見落とさないよう、軽く後押しするだけの追加指示を加える。
// 「必ず使ってください」という命令ではなく、存在すれば積極的に
// 反映してほしいという位置づけの明示に留める
// (存在しない情報の追加は禁止のまま)。
let writerFileEmphasisBlock = "";

if (agent.id === "writer") {

  const fileEvidenceCount =
    relevantEvidence.filter(
      (e) => e.sourceType === "user_file"
    ).length;

  if (fileEvidenceCount > 0) {

    writerFileEmphasisBlock = `

========================
参考: 添付資料由来のEvidence(STEP35)
========================

Shared Evidence内の「ユーザー添付資料由来のEvidence」
(${fileEvidenceCount}件)は、ユーザーが今回の作業のために
直接提供した一次資料です。

今回のユーザー要求に関連する内容であれば、
その事実・数値・固有名詞・結論を成果物へ積極的に反映してください。

ただし、資料に存在しない情報を
「資料に書いてあった」として追加してはいけません。
`;

  }

}

// ===============================
// Writer Idea Mode Guidance (STEP39)
// ===============================
//
// core/conversation/reconstructTask.tsがcomposedTask
// (=context.userInput)へ埋め込んだIDEA_MODE_MARKERを検出した場合
// のみ、FACT/HYPOTHESIS/IDEA/OPINION/QUESTIONの区別をWriterへ
// 明示する。新しいEvidence種別・新しいWriter出力Schemaは追加せず、
// 既存のsections[].contentという自由記述の中で、自然な日本語表現
// によってこれらを区別するよう促すだけに留める。
let writerIdeaModeBlock = "";

if (
  agent.id === "writer" &&
  typeof context.userInput === "string" &&
  context.userInput.includes(IDEA_MODE_MARKER)
) {

  writerIdeaModeBlock = `

========================
Idea Modeでの情報の扱い(STEP39)
========================

今回はまだ正解のない仮説・アイデアを検討する会話です。
Evidenceが不足していること自体は問題ではありません。

ただし、以下の種類の情報を混同しないでください。

・FACT(事実): Evidence等で確認できている事実
・HYPOTHESIS(仮説): まだ検証されていない仮説
・IDEA(アイデア): 新しく提案する案
・OPINION(所見): 評価・判断・見解
・QUESTION(問い): まだ答えが出ていない問い

これらをラベルとして機械的に付ける必要はありませんが、
自然な日本語表現で区別してください。

例:
・確認できている事実は「〜であることが確認されています」
・仮説は「〜という仮説が考えられます」「〜の可能性があります」
・アイデアは「〜という案が考えられます」「提案として〜」
・所見は「〜と考えられます」「〜という懸念があります」

未検証の仮説・アイデアを、確認済みの事実であるかのように
断定して書いてはいけません。
`;

}

// ===============================
// Writer Classification Awareness (STEP75)
// ===============================
//
// STEP74でWorkflow層へ伝播したcontext.artifactType/context.destination
// (+STEP70/71のcontext.evidenceMode/context.qualityProfile)を、Writerが
// 明示的に認識できるようにするための追記ブロック。既存の
// buildArtifactStyleGuidance()(core/conversation/reconstructTask.ts、
// composedTaskへ既に埋め込み済みの文体・構成指示)は変更せず、
// あちらとは役割を分けた「現在どの条件で生成しているか」という
// 単純な状況認識だけを追加する。既存のwriterSafetyNetBlock等と
// 同じ「userPromptへ追記するだけ」のパターンを踏襲する。
//
// academic/micro/conversationのような、STEP73で検討されたが
// ArtifactType自体には追加しなかった概念は、QualityProfile/
// EvidenceModeの組み合わせ(既存の2軸)から自然文のヒントとして
// 表現するだけに留め、新しいArtifactType値は追加しない。
let writerClassificationBlock = "";

if (agent.id === "writer") {

  const artifactTypeLabel =
    context.artifactType ?? "(未指定)";

  const destinationLabel =
    context.destination ?? "tact";

  const evidenceModeLabel =
    context.evidenceMode ?? "(未指定)";

  const qualityProfileLabel =
    context.qualityProfile ?? "(未指定)";

  let qualityProfileHint = "";

  if (context.qualityProfile === "instant") {

    qualityProfileHint =
      "Quality Profileがinstantです。キャプション・短い言い換え・" +
      "文字数調整等、軽量な出力が想定されています。無理に長い構成に" +
      "する必要はありません。";

  } else if (context.qualityProfile === "maximum") {

    qualityProfileHint =
      "Quality Profileがmaximumです。論文・専門的調査等、高い厳密性が" +
      "求められています。Evidenceが支持する範囲を超えた断定を避けて" +
      "ください。";

  }

  let destinationHint = "";

  if (context.destination === "design") {

    destinationHint =
      "Destinationがdesignです。この成果物は後続でTACT Designへ渡され、" +
      "編集・構造化される前提です。既存のsections構造を明確に区切って" +
      "出力してください(新しいフィールドを作る必要はありません)。";

  }

  writerClassificationBlock = `

========================
今回の分類情報(STEP75)
========================

Artifact Type: ${artifactTypeLabel}
Destination: ${destinationLabel}
Evidence Mode: ${evidenceModeLabel}
Quality Profile: ${qualityProfileLabel}

これは既存の文体・構成の指示(Output Spec等)を置き換えるものではなく、
今回の成果物がどのような条件で生成されているかを示す参考情報です。

${qualityProfileHint}
${destinationHint}
`;

}

// =========================
// writerProblemFramingBlock (STEP83)
// =========================
//
// 背景: STEP80-82の実測で、以下が判明した。
// ・composedTask(Original User Request)にはユーザーの深い問い自体は
//   保持されているが、Task Reconstructionの言い換えにより、ユーザーが
//   実際に使った禁止表現の正確な文言が失われる場合がある
//   (STEP81/82と同じ問題)。
// ・Writerは既存の統合ルール(Evidence優先・Agent成果物の統合・
//   捏造禁止)には忠実だが、「ユーザーの元の問いが上流Agent
//   (Researcher/Analyst)の浅い分析でカバーされていない場合に、
//   Writer自身がその欠落に気づき埋める」という指示が一切存在しない
//   ため、上流の浅い分析をそのまま統合した結果、無難な一般論
//   (「AIスキルもクリティカルシンキングも重要」等)に収束していた
//   (STEP81/82で実測)。
// ・Critique/Revision(STEP81/82)による事後追加では、Writerの
//   最初の問題設定そのものを代替できないことも実測で判明した。
//
// 方針(STEP83 Phase2/3の判断): Plannerの構造(goal/task圧縮)は
// 変更せず、Writerの初回生成時点に限定した最小の追加指示のみを
// 行う。「深く考えてください」等の抽象的な指示ではなく、
// 具体的に確認・実行すべき手順を3点に絞って明記する。
// 新しいAgent・新しいLLM呼び出し・新しいcontextフィールドは
// 追加しない。既存のwriterClassificationBlock等と同じ
// 「userPromptへ追記するだけ」のパターンを踏襲する。
let writerProblemFramingBlock = "";

if (agent.id === "writer") {

  // STEP81/82と同じ判定(rawUserInputがcomposedTaskと異なる場合のみ
  // 追加で提示する)。新しい状態管理は追加しない。
  const rawUserRequestForWriter =
    context.rawUserInput &&
    context.rawUserInput !== context.userInput
      ? context.rawUserInput
      : null;

  writerProblemFramingBlock = `

========================
ユーザーの核心論点の保持(STEP83)
========================
${
  rawUserRequestForWriter
    ? `
"Original User Request"はTask Reconstructionによる要約を経ています。
ユーザーが実際に使った禁止表現・具体的な問いの文言を確認する際は、
以下の生の発言を優先してください。

------------------------
ユーザーの生の発言(参考)
------------------------

${rawUserRequestForWriter}
`
    : ""
}
執筆前に、ユーザーの発言(生の発言があればそちら、無ければ
Original User Request)について、以下の3点を確認してください。
該当しない場合は無視してください。新しいテーマを勝手に追加する
ことは禁止です。

1. 禁止された結論の形
ユーザーが「単に〜という結論にはしないでください」
「〜だけでなく」のように、避けるべき結論・不十分な回答の形を
明示している場合、成果物の結論(executiveSummary・keyFindings・
最後の段落)がその形に実質的に一致していないか出力前に確認して
ください。一致している場合、Workflow History内のAnalystの分析
(Evidenceから論理的に導ける範囲)を使って、その形から一段踏み込んだ
結論へ書き直してください。
${
  context.conclusionState?.status === "HOLD"
    ? `
重要(Conclusion State: HOLD、STEP108):
ただし、Workflow History内のANALYSTが現在HOLD状態(優先順位付けを
保留している状態)である場合、この「一段踏み込んだ結論」を、Analystが
示していない新しい優先順位・規範的結論の創作によって作ってはいけません。

この場合、禁止された結論パターンを避けるとは、以下のいずれかを意味します。

・なぜ現時点で優先順位を判断できないのか、Evidence間の緊張関係・
  対立点を具体的に掘り下げて説明すること
・どのような追加情報・比較調査があれば判断できるようになるかを
  具体的に示すこと
・Analystの保留状態を、単なる一般論ではなく、Evidenceに基づいた
  具体的な理由とともに伝えること

新しい優先順位や「〜すべき」という規範的結論を創作することで、
この確認に応えてはいけません。この制約は、後述のConclusion State
ブロックと同じ優先度を持ちます。
`
    : ""
}

2. 定義・前提を問う問い
ユーザーが「そもそも」「本質的に」「〜とは何か」のように、
定義・前提そのものを問うている場合、その問いにWorkflow Historyの
内容が直接答えているか確認してください。Researcher/Analystが
その問いに直接触れていない場合でも、Writerは新しい事実を作らない
範囲で、収集済みのEvidence・Analystの分析から論理的に導ける
整理・定義付けを行ってください(これは新しい事実の創作ではなく、
既存情報の統合・解釈です)。

3. 対立する立場の比較
ユーザーが賛成/反対、複数の立場の比較を求めている場合、単に
両方を並べるだけでなく、両者が前提としていることの違いや、
その対立から何が言えるかまで整理してください。
`;

}

// =========================
// conclusionStateBlock (STEP106)
// =========================
//
// 背景: 旧STEP94(writerProblemFramingBlockの項目4)は、「Analystの
// 保留を維持せよ」という指示を自由文でWriterへ伝えるものだった。
// STEP101-104の実測で、この自由文指示だけでは未支持結論の生成を
// 安定して防げない(Case B+C合算で73%が違反)ことが判明し、代わりに
// Analystの結論状態(HOLD/DECIDED)を構造化してWriterへ渡す方式
// (Structured HOLD/DECIDED)がCase B+C合算で10%まで改善することを
// 確認した(STEP104)。STEP105で設計を確定し、本ブロックはSTEP94の
// 項目4を置き換える形でSTEP106実装した。
//
// context.conclusionState(STEP106でAnalyst実行直後に設定。下記
// 「保存」セクション参照)が存在する場合のみ追記する。Analystが
// 実行されないWorkflow、またはAnalyst出力が異常でconclusionStateが
// 設定されなかった場合はundefinedのままとなり、このブロックは
// 空文字列のままになる(=旧挙動と同じく何も追記されない)。
let conclusionStateBlock = "";

if (
  agent.id === "writer" &&
  context.conclusionState
) {

  conclusionStateBlock =
    buildConclusionStateBlock(
      context.conclusionState
    );

}

// =========================
// outputsForWriterPrompt (STEP111)
// =========================
//
// 背景: STEP109の調査で、conclusionStateBlockを追記しても、
// buildPrompt()のpreviousOutputs経由でAnalystのrecommendations
// 配列自体は無加工のままWriterへ渡り続けていることが判明した。
// STEP108のRegression Testで、この生データ(特にHOLD状態なのに
// 決定文のように見えるrecommendationが混在するケース、Case E)を
// Writerがそのまま採用してしまう「模倣型」の失敗が実測された。
//
// buildPrompt()自体は変更せず(既存の整形専任という責務を維持)、
// Writer実行時にbuildPrompt()へ渡すoutputs引数だけを、
// buildWriterAnalystView()(STEP111、core/workflow/
// conclusionState.ts)で加工したコピーに差し替える。
// context.outputs自体(他Agent・後続処理が参照する生データ)は
// 一切変更しない。DECIDED時・conclusionState未定義時は
// buildWriterAnalystView()が無加工でanalystOutputを返すため、
// outputsForWriterPromptはcontext.outputsと実質的に同一になる
// (=Writer以外のAgent、およびDECIDED時のWriterには一切影響しない)。
const outputsForWriterPrompt =
  agent.id === "writer" && context.outputs?.analyst
    ? {
        ...context.outputs,
        analyst: buildWriterAnalystView(
          context.outputs.analyst,
          context.conclusionState
        ),
      }
    : context.outputs;

// =========================
// phase1DeferralBlock (STEP113)
// =========================
//
// HOLD時のみ、ExecutiveSummary生成を「事実・分析の要約(Phase1、この
// addendumが対象)」と「なぜ判断できないかの結論(Phase2、下記の
// generateHoldConclusion()が担当)」に分離する。DECIDED/未定義時は
// 空文字列のままとなり、既存の1回生成の挙動を一切変更しない。
let phase1DeferralBlock = "";

if (
  agent.id === "writer" &&
  context.conclusionState?.status === "HOLD"
) {

  phase1DeferralBlock =
    buildPhase1DeferralBlock(
      context.conclusionState
    );

}

// =========================
// analystProblemFramingBlock (STEP85)
// =========================
//
// 背景: STEP84の実測で、Final Outputの禁止された結論パターン
// (「AIスキルもクリティカルシンキングも重要」)は、Writerではなく
// Analystのrecommendations生成時点で既に確定しており、Writerは
// それをほぼそのまま継承していたことが判明した。Analystのsystem
// prompt・出力スキーマ(core/agents/analyst.ts、core/prompt/
// outputFormats.ts)は「Evidenceの分析」に厳密に閉じており、この
// 安全性制約自体は正しく機能している(STEP85でも変更しない)。
// 一方で、「ユーザーが問うている定義・前提」「安易な結論への
// 収束」を確認する指示は存在しなかった。
//
// 重要な区別(STEP85 Phase1の整理): 「独自仮説を生成する」ことは
// 「Evidenceにない事実を追加する」こととは異なる。Analystの既存
// system promptの"Insight Generation"は、既に「単なる要約ではなく、
// Evidenceから『なぜ重要なのか』を説明する」ことを求めており、
// 「Evidenceから論理的に導ける解釈」は元々許可されている。本
// ブロックは、この既存の解釈の許可範囲を、ユーザーが明示した
// 定義・前提の問いへ具体的に向けるだけであり、新しい権限を追加
// するものではない。「Evidenceだけが事実」「新しい事実を追加
// しない」という既存の安全性制約は一切変更しない。
//
// STEP81-83と同じパターンで、context.rawUserInputが
// context.userInput(composedTask)と異なる場合のみ、判定材料として
// 追加提示する(新しいcontextフィールドは追加しない)。
let analystProblemFramingBlock = "";

if (agent.id === "analyst") {

  const rawUserRequestForAnalyst =
    context.rawUserInput &&
    context.rawUserInput !== context.userInput
      ? context.rawUserInput
      : null;

  analystProblemFramingBlock = `

========================
問題設定の確認(STEP85)
========================
${
  rawUserRequestForAnalyst
    ? `
"Original User Request"はTask Reconstructionによる要約を経ています。
ユーザーが実際に使った問い・禁止表現の正確な文言を確認する際は、
以下の生の発言を優先してください。

------------------------
ユーザーの生の発言(参考)
------------------------

${rawUserRequestForAnalyst}
`
    : ""
}
分析を完了する前に、以下を確認してください。該当しない場合は
無視してください。

1. 問いの前提確認
ユーザーが「Xとは何か」「Xの価値とは何か」「Xは本当に必要か」の
ように、定義・前提そのものを問うている場合、単にXの重要性を
説明するだけで終わらせないでください。Xをどう定義するか、Xの
価値が何によって決まるか、AIによってその定義や価値が変化する
可能性があるかまで検討し、insights[].background/reasonへ反映して
ください。ただしEvidenceに存在しない具体的な事実・統計・出典を
新しく作ってはいけません(これは既存のInsight Generationの原則と
同じです。事実の追加ではなく、Evidenceから導ける解釈の一部として
記述してください)。

2. 無難な結論への収束確認
recommendations/insightsが、「AもBも重要」「両方バランスよく
必要」のような一般論だけで終わっていないか確認してください。
この形式自体が常に誤りというわけではありませんが、ユーザーが
明示的にこの種の結論を避けるよう求めている場合は、「なぜAとBを
両方重要とする必要があるのか」「AとBは本当に同じ階層の能力
なのか」「どちらかの前提が変わると結論は変わるのか」まで検討し、
その検討結果をreasonへ反映してください。Evidenceが不足している
場合は、無理に具体的な結論を出そうとせず、confidenceReasonで
その旨を正直に示すことを優先してください。

3. 仮説と事実の分離
Evidenceから直接確認できる事実(background)と、そこから
Analystが導いた解釈・仮説(reason/futureImplication)を明確に
分離してください。仮説を提示すること自体は問題ありません
(要約ではなく意味を説明することは、既存のMISSIONで既に
求められています)。ただし、Evidenceに存在しない具体的な事実・
数値・統計・出典を新しく作ることは、引き続き禁止です。

4. ユーザー制約の優先順位
recommendationsを生成する際は、以下の優先順位を厳守してください。

1. ユーザーが明示的に指定した禁止事項・避けるべき結論・問いの前提
2. Evidenceから導ける論理的な分析
3. recommendationsとしての具体的な施策提案

1より下位の要件を満たすために、1の制約を破ってはいけません。

特に、Evidenceから一般的な施策提案を作成できる場合でも、その提案が
ユーザーの明示した禁止結論と実質的に同型である場合は、その提案を
採用しないでください。

ユーザーの制約を満たしながら具体的なrecommendationを合理的に
導けない場合は、無理に一般的な施策を提示せず、「現時点のEvidence
からは具体的な施策を一意に導けない」と明示してください。

「Evidenceから何かrecommendationを出すこと」よりも、「ユーザーが
求めている問題設定と制約を維持すること」を優先してください。

なお、ユーザーの制約を守るために、Evidenceに存在しない事実・数値・
固有情報を追加してはいけません。
`;

}

  // ===============================
  // 1回目
  // ===============================
  //
  // STEP77: userPromptをrunLLM()呼び出しの引数式として直接書くのでは
  // なく、いったんローカル変数(userPrompt1)へ保持する。これにより、
  // 「実際にLLMへ送信した文字列」と「saveAgentLog()が保存する文字列」を
  // 同一のものにできる(buildPrompt()を保存直前に無関係に再構築する
  // 従来の不整合を解消する)。buildPrompt()のシグネチャ・addendum
  // ブロックの内容は一切変更しない。

  const userPrompt1 =
    buildPrompt(
      agent.id,
      context.userInput,
      step.task,
      outputsForWriterPrompt,
      context.stepOutputs,
      toolResults,
      context.memory,
      context.handoffs,
      relevantEvidence,
      context.mode,
      context.currentOutput,
      context.brainMemory
    ) + writerSafetyNetBlock + writerFileEmphasisBlock + writerIdeaModeBlock + writerClassificationBlock + writerProblemFramingBlock + conclusionStateBlock + phase1DeferralBlock + analystProblemFramingBlock;

  // STEP77: 実際にLLMへ送信した最新のuserPromptを保持する変数。
  // Tool Requestsが発生した場合、下の2回目の呼び出しで再代入される。
  let finalUserPrompt = userPrompt1;

  const result1 = await runLLMWithFallback({


    provider: executionStrategy.provider,

    model: executionStrategy.model,

    systemPrompt: agent.systemPrompt,

    userPrompt: userPrompt1,

  });

  let response = result1.response;

  // STEP159: Workflow全体のコスト集計へ加算する。
  accumulateLLMCost(context.costAccumulator, response.cost);

  // STEP168: 実際に使用されたProvider/Modelを記録する。
  recordActualExecution(
    context.actualExecution,
    result1.actualProvider,
    result1.actualModel
  );


  console.log("====================================");
  console.log("RAW RESPONSE (1)");
  console.dir(response, { depth: null });
  console.log("====================================");


  let cleaned = cleanJSON(
    response.content ?? ""
  );


  if (!cleaned) {

    throw new Error(
      `${agent.id} returned empty response.`
    );

  }


  let parsed: any;


  try {

    parsed = JSON.parse(cleaned);

  } catch (error) {

    console.error("JSON Parse Error");
    console.error(response.content);
    throw error;

  }

  if (
    agent.id === "planner" &&
    parsed.toolRequests
  ) {

    console.warn(
      "Planner returned toolRequests. Ignoring."
    );

    delete parsed.toolRequests;

  }


  // ===============================
  // Tool Requests
  // ===============================

  if (
    agent.tools.length > 0 &&
    Array.isArray(parsed.toolRequests) &&
    parsed.toolRequests.length > 0
  )  
  {

    console.log("Executing Tool Requests...");


    toolResults =
      await executeToolCalls(
        parsed.toolRequests,
        context.userInput,
        context.taskProfile?.searchIntensity
      );


    // ===============================
    // Tool Evidence共有
    // ===============================

for (const toolOutputs of Object.values(toolResults)) {

  if (!Array.isArray(toolOutputs)) continue;

  for (const toolResult of toolOutputs as any[]) {

    if (
      toolResult?.data?.evidence &&
      Array.isArray(toolResult.data.evidence)
    ) {

      context.evidence.push(
        ...toolResult.data.evidence
      );

    }

  }

}

    console.log("Re-running with Tool Results...");


    // STEP77: 1回目と同じ理由で、Tool Results再実行時のuserPromptも
    // ローカル変数(userPrompt2)へ保持し、finalUserPromptを更新する。
    const userPrompt2 =
      buildPrompt(
        agent.id,
        context.userInput,
        step.task,
        outputsForWriterPrompt,
        context.stepOutputs,
        toolResults,
        context.memory,
        context.handoffs,
        relevantEvidence,
        context.mode,
        context.currentOutput,
        context.brainMemory
      ) +
      `

重要：

Tool実行は完了しています。

Tool Results を利用して、
あなた本来のJSONを完成させてください。

toolRequestsだけを返して終了してはいけません。

toolRequestsは必ず空配列にしてください。

` + writerSafetyNetBlock + writerFileEmphasisBlock + writerIdeaModeBlock + writerClassificationBlock + writerProblemFramingBlock + conclusionStateBlock + phase1DeferralBlock;

    finalUserPrompt = userPrompt2;

    const result2 = await runLLMWithFallback({

      provider: executionStrategy.provider,

      model: executionStrategy.model,

      systemPrompt: agent.systemPrompt,

      userPrompt: userPrompt2,

    });

    response = result2.response;

    // STEP159: Workflow全体のコスト集計へ加算する。
    accumulateLLMCost(context.costAccumulator, response.cost);

    // STEP168: 実際に使用されたProvider/Modelを記録する。
    recordActualExecution(
      context.actualExecution,
      result2.actualProvider,
      result2.actualModel
    );


    console.log("====================================");
    console.log("RAW RESPONSE (2)");
    console.dir(response, { depth: null });
    console.log("====================================");


    cleaned = cleanJSON(
      response.content ?? ""
    );


    if (!cleaned) {

      throw new Error(
        `${agent.id} returned empty response.`
      );

    }


    try {

      parsed = JSON.parse(cleaned);

    } catch (error) {

      console.error("JSON Parse Error");
      console.error(response.content);
      throw error;

    }

  }


  // ===============================
  // Research Requirement Guard (STEP33)
  // ===============================
  //
  // 「外部検索が明確に必要な要求」なのに、Researcherが一度も
  // toolRequestsを発行しなかった場合を検知する。対象はResearcherの
  // みであり(web-searchを持つのはResearcherだけ)、他のAgentの
  // 挙動には一切影響しない。
  //
  // 検索するかどうかの判断自体は引き続きResearcher(LLM)が行う。
  // ここでは「必要そうな要求なのに一度も検索していない」場合の
  // 安全網(最大1回の再試行 + 下流でのEvidence遮断)としてのみ機能する。

  let researchRequired = false;

  let searchAttempted =
    Object.keys(toolResults).length > 0;

  let retryAttempted = false;

  if (agent.id === "researcher") {

    // STEP33: context.userInput(=composeTask()が組み立てた
    // currentTask全体)をそのまま判定に使うと、STEP17のpreserve
    // headings一覧・既収集情報の要約(pastFindingsSummary)に含まれる
    // 過去の章タイトルや年号(例:「2026年の〜レポート」)まで拾って
    // しまい、「この文章を短くして」のような検索と無関係な指示まで
    // 誤検知することを実機テストで確認した。
    //
    // composeTask()は必ず「今回の指示の要約(parsed.task)」を先頭の
    // 段落として組み立て、章立て一覧・過去情報要約等はその後に
    // "\n\n"区切りで続ける(core/conversation/reconstructTask.ts)。
    // そのため、先頭の段落だけを判定対象にすることで、今回の指示
    // そのものに絞り込む。composeTask()を経由しない単純な呼び出し
    // (区切りのない1文)ではsplit結果がそのまま全文になるため、
    // 従来どおりの挙動になる。
    //
    // STEP76: context.rawUserInput(STEP75で追加、Task Reconstruction
    // 前の生に近いユーザー発言)が存在する場合はそちらを優先する。
    // core/workflow/handlePlanner.ts(STEP70のevidenceMode判定)と
    // 同じ「rawUserInput ?? userInput」パターンを踏襲するだけであり、
    // 新しい判定ロジックは追加しない。
    //
    // OR結合(rawUserInputとcomposedTaskの両方で判定しどちらかが真なら
    // 採用する案)は採用しなかった。実際に
    // 「調査した文章を校正して」「市場調査という言葉を含む文章を
    // リライトして」を既存のdetectResearchRequirement()へ通したところ、
    // どちらもraw/composedのどちらを使っても同じくtrueになる
    // (研究依頼ではなく本文中の語彙への誤反応という、raw/composedの
    // 選択とは無関係な既存の正規表現側の特性)ことを実測で確認した。
    // OR結合は誤検知を減らさず、むしろcomposedTaskだけが持つ余分な
    // 文脈(過去の章タイトル等)由来の誤検知を追加するリスクがあるため、
    // 「rawUserInputがあれば優先、無ければ既存通りuserInputへ
    // フォールバック」という単純な優先順位に留めた。
    const currentInstruction =
      (
        (context.rawUserInput ?? context.userInput) ?? ""
      ).split("\n\n")[0] ?? "";

    researchRequired =
      detectResearchRequirement(
        currentInstruction
      );

    if (
      researchRequired &&
      !searchAttempted
    ) {

      retryAttempted = true;

      const retryResult =
        await retryResearcherSearch(
          agent,
          step,
          context,
          relevantEvidence
        );

      if (retryResult.parsed) {

        parsed = retryResult.parsed;

        // STEP77: retryResearcherSearch()が採用されたparsedを実際に
        // 生成した側のプロンプトへ、ログ用のfinalUserPromptも合わせて
        // 更新する(そうしないと、researcher再試行が発生したケースだけ
        // ログのpromptと実際の送信内容が再びずれてしまうため)。
        finalUserPrompt = retryResult.finalPrompt;

      }

      toolResults = retryResult.toolResults;

      searchAttempted =
        Object.keys(toolResults).length > 0;

    }

  }

  const searchSucceeded =
    hasSuccessfulToolResult(toolResults);

  const guardTriggered =
    researchRequired && !searchSucceeded;

  if (agent.id === "researcher") {

    // STEP34: Writer(このRunの後段Agent)がこの判定結果を参照
    // できるよう、context(Runをまたいで持続する)へ保持する。
    // Reviewer retryでResearcherが複数回実行される場合は、
    // 最後に実行された結果で上書きされる(=Writerは常に直近の
    // Researcher実行結果を見る)。
    context.researchGuard = {
      researchRequired,
      searchAttempted,
      searchSucceeded,
      guardTriggered,
      retryAttempted,
    };

    console.log("[ResearchGuard]", {
      researchRequired,
      searchAttempted,
      searchSucceeded,
      guardTriggered,
      retryAttempted,
    });

  }

  // ===============================
  // Writer Evidence Safety Net: 事後チェック (STEP34)
  // ===============================
  //
  // writerSafetyNetBlock(prompt指示)だけでは、Writerが引き続き
  // 具体的な数値を生成してしまうケースを実機で確認した。
  // 文章の一部だけを機械的に削除すると可読性を損なうため、
  // 生成結果そのものは書き換えない。その代わり、STEP20から
  // 再利用しているcontainsUnverifiedQuantitativeClaim()を
  // Writerの最終出力(sections[].content)にも適用し、未検証の
  // 可能性がある具体的数値を検出した場合は、Writer自身の既存
  // 出力フィールド(limitations)へ注記を追記するだけに留める。
  // 新しいEvidenceスキーマ・新しいUIは追加しない。
  //
  // STEP149: STEP148の実機E2Eで、上記のlimitationsへの注記が
  // どのUIコンポーネント(FinalOutput.tsx/DocumentRenderer.tsx/
  // buildOutputPptx.ts/formatOutputText.ts)からも一切参照・表示
  // されておらず、未検証の数値がexecutiveSummary(全てのUI経路で
  // 実際に表示される唯一の要約フィールド)にそのまま「確認済みの
  // 事実」として残ることを確認した。limitations自体は削除せず
  // 維持しつつ、同じ条件が成立した場合はexecutiveSummary本文の
  // 先頭にも短い注記を追記する(既存の本文は削除・書き換えない。
  // 先頭に1文加えるだけ)。これにより、limitationsがUIで表示され
  // ない現状でも、実際にユーザーが読む箇所に警告が届くようにする。
  if (
    agent.id === "writer" &&
    writerSafetyNetActive &&
    Array.isArray(parsed.sections)
  ) {

    const hasUnverifiedClaim =
      (parsed.sections as { content?: unknown }[]).some(
        (section) =>
          containsUnverifiedQuantitativeClaim({
            content: section?.content ?? "",
          })
      ) ||
      // STEP149: sections[]だけでなくexecutiveSummary自体に未検証の
      // 数値が含まれるケースも実機で確認したため、こちらも検査対象に含める。
      containsUnverifiedQuantitativeClaim({
        executiveSummary: parsed.executiveSummary ?? "",
      });

    if (hasUnverifiedClaim) {

      console.warn(
        "[WriterSafetyNet] unverified quantitative claim " +
        "detected in Writer output despite the safety net prompt."
      );

      if (!Array.isArray(parsed.limitations)) {
        parsed.limitations = [];
      }

      parsed.limitations.push(
        "今回はWeb検索によるEvidenceを取得できなかったため、" +
        "本文中の具体的な数値・統計は検証されていない可能性があります。"
      );

      // STEP149: limitationsがUIに表示されない現状の穴を埋めるため、
      // 実際に表示されるexecutiveSummaryの先頭にも同じ趣旨の注記を
      // 追記する。既存のexecutiveSummary本文は削除・書き換えない
      // (先頭に警告文を1つ加えるのみ)。
      if (typeof parsed.executiveSummary === "string") {

        const caveat =
          "【注意】今回はWeb検索によるEvidence(根拠)を取得できなかった" +
          "ため、以下に含まれる具体的な数値・統計は未検証です。";

        if (!parsed.executiveSummary.startsWith("【注意】")) {

          parsed.executiveSummary =
            caveat + "\n\n" + parsed.executiveSummary;

        }

      }

    }

  }


  console.log(
    `Parsed Output (${agent.id})`
  );


  console.log(
    JSON.stringify(parsed, null, 2)
  );

  saveAgentLog(
  agent.id,
  {

    // STEP77: 以前はここでbuildPrompt()をログ専用に再構築しており、
    // Writerのaddendumブロック(writerSafetyNetBlock等)が欠落した
    // 不正確なpromptが保存されていた。finalUserPromptは実際に
    // runLLM()へ渡した文字列そのもの(1回目のみで完了した場合は
    // userPrompt1、Tool Requestsで2回目まで進んだ場合はuserPrompt2)
    // であり、これをそのまま保存する。
    prompt: finalUserPrompt,

    response,

    parsed,

    evidence:
      relevantEvidence,

    toolResults,

    // STEP33: Researcherのみ、検索要否の判定・実行状況を記録する。
    // 新しい永続化機構は作らず、既存のlogs/*.jsonへ追記するだけ。
    ...(agent.id === "researcher"
      ? {
          researchGuard: {
            researchRequired,
            searchAttempted,
            searchSucceeded,
            guardTriggered,
            retryAttempted,
          },
        }
      : {})

  }
);

  // ===============================
  // Analyst evidenceId Validation
  // ===============================
  //
  // ResearcherのEvidence保存処理と同じ思想で、Analystの出力だけを対象に、
  // evidenceIdsがUUID形式かつ今回渡したEvidence pool(relevantEvidence)に
  // 実在するかを機械的に確認する。件数や論点の重複といった意味的判断は行わない。

  if (agent.id === "analyst") {

    const { cleaned, issues } =
      validateEvidenceIds(
        parsed,
        relevantEvidence
      );

    parsed = cleaned;

    if (issues.length > 0) {

      console.warn(
        "Analyst evidenceId issues:",
        issues
      );

    }

    // ===============================
    // Analyst Evidence Safety Net (STEP91)
    // ===============================
    //
    // 背景: STEP89/90の実測で、Researcher handoff経由でAnalystへ
    // 未検証の定量的主張が伝播する経路を確認した(別途Researcher
    // Handoff Guardで対処)。ただし、それとは独立に、Analyst自身が
    // insights[]/comparisons[]/opportunities[]/risks[]/
    // recommendations[]の自由記述フィールド(background・
    // causeAndEffect・reason・futureImplication・counterArguments・
    // action等)へ、evidenceIdsが空のまま具体的な定量的主張
    // (割合・金額・個数・年次+数値)を書いてしまう可能性も理論上
    // 残る。STEP20由来のcontainsUnverifiedQuantitativeClaim()を
    // 再利用し、この経路も検出する。
    //
    // 重要な方針: evidenceIds: [] 自体は正常な状態であり
    // (Evidence=0件のRunでは当然発生する)、これ単体を却下条件には
    // しない。「evidenceIdsが空 かつ 具体的な定量的主張を含む」
    // 組み合わせのときのみ対象とする。検出しても、該当insight/
    // 項目やAnalyst出力全体を削除しない(正しい分析まで失われる
    // ことを避けるため、Writer Safety Net(STEP34)と同じ「削除せず
    // 注記する」方針)。定性的な解釈・仮説・因果関係の推論・将来への
    // 含意は、この検査の対象にならない(数値・単位を伴わない文章は
    // containsUnverifiedQuantitativeClaim()自体が反応しないため)。
    const analystItemsToCheck: unknown[] = [
      ...(Array.isArray(parsed.insights) ? parsed.insights : []),
      ...(Array.isArray(parsed.comparisons) ? parsed.comparisons : []),
      ...(Array.isArray(parsed.opportunities) ? parsed.opportunities : []),
      ...(Array.isArray(parsed.risks) ? parsed.risks : []),
      ...(Array.isArray(parsed.recommendations) ? parsed.recommendations : []),
    ];

    const hasUnverifiedAnalystClaim =
      analystItemsToCheck.some((item) => {

        if (!item || typeof item !== "object") return false;

        const record = item as Record<string, unknown>;

        const evidenceIds = record.evidenceIds;

        const hasNoEvidence =
          !Array.isArray(evidenceIds) ||
          evidenceIds.length === 0;

        if (!hasNoEvidence) return false;

        // evidenceIds(空配列であることは上で確認済み)を含めても
        // UUID文字列は数値+単位のパターンに一致しないため、
        // 除外用の分割代入はせずrecordをそのまま渡す。
        return containsUnverifiedQuantitativeClaim(record);

      });

    if (hasUnverifiedAnalystClaim) {

      console.warn(
        "[EvidenceGuard] unverified quantitative claim detected " +
        "in analyst output (evidenceIds empty)."
      );

      const note =
        "一部の分析にEvidenceの裏付けがない具体的な数値・統計が" +
        "含まれている可能性があります。これらは検証されていない" +
        "推測として扱ってください。";

      parsed.confidenceReason =
        typeof parsed.confidenceReason === "string" &&
        parsed.confidenceReason
          ? parsed.confidenceReason + " " + note
          : note;

    }

  }

  // ===============================
  // Writer evidenceId Validation (STEP66)
  // ===============================
  //
  // Analystと同じ思想で、Writerの最終出力のうちevidenceIdsフィールドを
  // 持つ既存のsections[]だけを対象に、evidenceIdsがUUID形式かつ今回
  // 渡したEvidence pool(relevantEvidence)に実在するかを機械的に確認する。
  // keyFindings/recommendations/nextActionsにはevidenceIdsフィールドが
  // 存在しないため対象外(STEP66の範囲外、outputFormats.tsのschema変更
  // が必要になるため見送り)。
  //
  // 「Evidence IDが実在するか」という機械的な追跡性の確認のみを行い、
  // 「そのEvidenceが本当にその主張を支持しているか」という意味的な
  // 妥当性判定はvalidateEvidenceIds自体が元々行っていない(既存と同じ)。

  if (agent.id === "writer") {

    const { cleaned, issues } =
      validateEvidenceIds(
        parsed,
        relevantEvidence,
        ["sections"]
      );

    parsed = cleaned;

    if (issues.length > 0) {

      console.warn(
        "Writer evidenceId issues:",
        issues
      );

    }

  }

  // ===============================
  // Phase2: HOLD時の結論生成(STEP113)
  // ===============================
  //
  // Phase1(上記の生成本体。phase1DeferralBlockにより、HOLD時は
  // 意図的に結論を含まないexecutiveSummaryが生成されている)を受けて、
  // 「なぜ現時点で優先順位を決定できないか」という結論部分だけを
  // 追記する。DECIDED/未定義時はphase1DeferralBlockが空文字列のため
  // Phase1自体が通常どおりの単一生成のままであり、この分岐にも
  // 入らない(既存挙動を完全に維持)。
  //
  // 失敗時(generateHoldConclusion()がnullを返す)はPhase1の
  // executiveSummaryをそのまま採用する(安全側、Workflowを止めない)。

  if (
    agent.id === "writer" &&
    context.conclusionState?.status === "HOLD" &&
    typeof parsed.executiveSummary === "string"
  ) {

    try {

      const completedSummary =
        await generateHoldConclusion(
          agent,
          parsed.executiveSummary,
          context.outputs.analyst,
          context.conclusionState,
          relevantEvidence,
          // STEP157: 同一Workflow実行のExecutionStrategyを一貫させる
          // ため、context.taskProfileをそのまま渡す。
          context.taskProfile,
          // STEP159: この関数内のLLM呼び出し分のcostをWorkflow全体の
          // 集計へ加算するため、context.costAccumulatorをそのまま渡す。
          context.costAccumulator,
          // STEP163: context.effectiveModelTierをそのまま渡す。
          context.effectiveModelTier,
          // STEP168: 実際に使用されたProvider/Modelを記録するため、
          // context.actualExecutionをそのまま渡す。
          context.actualExecution
        );

      if (completedSummary) {
        parsed.executiveSummary = completedSummary;
      }

    } catch (error) {

      console.warn(
        "[HoldConclusion] failed, keeping Phase1 executiveSummary.",
        error
      );

    }

  }

  // ===============================
  // 保存
  // ===============================

context.outputs[agent.id] = parsed;

// STEP106: Analyst実行直後、その出力からConclusionState(HOLD/DECIDED)
// を判定し、Writer実行時にaddendum(conclusionStateBlock、上記
// 「1回目」セクション参照)として渡せるようcontextへ保持する。
// Analyst以外のAgentでは変更しない。
if (agent.id === "analyst") {
  context.conclusionState = resolveConclusionState(parsed);
}

if (agent.id === "reviewer") {
  context.reviewHistory.push(parsed);
}

context.stepOutputs[step.id] = {

  agent: agent.id,

  output: parsed,

};

// ===============================
// Handoff 保存
// ===============================

if (parsed.handoff) {

  context.handoffs[agent.id] = parsed.handoff;

}

if (agent.id === "reviewer") {
  context.reviewHistory.push(parsed);
}

if (
  agent.id === "reviewer" &&
  Array.isArray(parsed.improvements)
) {

for (const improvement of parsed.improvements) {

  // STEP157: gpt-4o-mini以外のモデル(standard/premium tier)を
  // 初めて実運用したところ、Reviewerのparsed.improvementsの要素が
  // 常に文字列とは限らない(オブジェクトが返るケースを実機で確認)
  // ことが判明し、improvement.toLowerCase()がTypeErrorで
  // Workflow全体を停止させていた。BrainRule.rule(下記)は既存の型
  // どおりstringである必要があるため、文字列以外の場合は
  // JSON.stringify()で安全に文字列化する(既存のstring要素に対する
  // 挙動は一切変えない)。
  const improvementText =
    typeof improvement === "string"
      ? improvement
      : JSON.stringify(improvement);

  const lower = improvementText.toLowerCase();

  let target = "reviewer";

  if (lower.includes("research")) {
    target = "researcher";
  }

  else if (lower.includes("design")) {
    target = "designer";
  }

  else if (lower.includes("engineer")) {
    target = "engineer";
  }

  else if (lower.includes("stakeholder")) {
    target = "stakeholder";
  }

  else if (lower.includes("planner")) {
    target = "planner";
  }

  else if (lower.includes("writer")) {
    target = "writer";
  }

  context.memory[target] ??= [];

  context.memory[target].push({
    rule: improvementText,
    reason: "Generated by Reviewer",
    priority: "medium",
    createdAt: Date.now(),
  });

}
}

// ===============================
// Researcher Evidence 保存
// ===============================

if (
  agent.id === "researcher" &&
  parsed.evidence
) {

  // STEP20: 今回のRunでResearcherが実際に検索Toolを実行し、
  // 成功結果を得たかどうか(searchSucceeded、STEP33のResearch
  // Requirement Guardブロックで既に算出済み)をそのまま再利用する。
  const searchPerformed = searchSucceeded;

  // STEP33: 「外部検索が明確に必要な要求なのに、検索できていない
  // (未実行・失敗のいずれでも)」場合は、STEP20の数値・統計限定の
  // 判定より広く、今回Researcherが新規生成したEvidence全件を
  // 対象に安全側(不採用)へ倒す。過去Turn・添付ファイル由来の
  // 既存Evidence(context.evidenceへ事前投入済み)はこのループの
  // 対象外であり、影響を受けない。
  let anyGuardRejection = false;

  for (const category of Object.keys(parsed.evidence)) {

    const items = parsed.evidence[category];

    if (!Array.isArray(items)) continue;

    // STEP20: Guardで却下したitemは、context.evidenceへ入れないだけでなく
    // parsed.evidence[category]自体からも取り除く。
    // parsed(=context.outputs.researcherとして保存される同一オブジェクト)を
    // そのまま残すと、"Outputs from Other Agents"経由でWriter等が
    // 未検証のEvidenceを直接参照できてしまい、また次回Turn以降の
    // collectPastEvidence()(STEP18)がそれを再び拾ってしまうため。
    const keptItems: unknown[] = [];

    for (const item of items) {

      const hash =
        (
          (item.claim ??
            item.name ??
            item.topic ??
            item.feature ??
            item.metric ??
            item.segment ??
            item.model ??
            item.headline ??
            "") +
          JSON.stringify(item)
        ).toLowerCase();

      const exists =
        context.evidence.some(
          (e: Evidence) => e.hash === hash
        );

      if (exists) {
        // 既存動作を変えない: 重複はcontext.evidenceへ追加しないが、
        // Researcherの生出力からは取り除かない。
        keptItems.push(item);
        continue;
      }

      // STEP20: Evidence安全網。
      // 検索実績がないRunで、具体的な数値・統計を含む新規Evidenceは
      // 無条件に採用しない(=context.evidence・Researcher生出力の
      // どちらにも残さない)。過去Turnから引き継いだEvidence
      // (context.evidenceへ事前投入済みのもの)はこのループの対象外
      // であり、影響を受けない。
      //
      // STEP33: 上記に加え、guardTriggered(=外部検索が明確に必要な
      // 要求なのに検索できていない)の場合は、数値・統計に限らず
      // 新規Evidence全件を対象とする。STEP32のcontrol testで、
      // 数値を含まない架空の出典(例:「TechCrunchの記事」「政府の
      // 公開資料」)がSTEP20の判定パターンをすり抜けることを確認した
      // ための拡張。
      //
      // STEP80: 実LLM E2Eで、EvidenceMode=helpful(=researchRequired
      // がfalseになりguardTriggeredも常にfalseになる)のRunで、
      // Tavily検索が全件失敗したにもかかわらず、数値を含まない
      // 出典名(「Forbes, 2023」「Gartner, 2023」等)がSTEP20/33どちらの
      // 判定にも一致せず素通りすることを確認した。
      // 「検索に成功していない情報を、検索結果由来のEvidenceとして
      // 扱わない」という原則に立ち返り、guardTriggered/数値パターンの
      // 有無に関わらず、!searchPerformed(=今回のRunで検索が
      // 成功していない)であれば新規Evidence全件を対象とする。
      // guardTriggered/containsUnverifiedQuantitativeClaimは、
      // 診断ログのreason区別のためだけに引き続き参照する
      // (判定条件そのものからは外す)。
      if (!searchPerformed) {

        anyGuardRejection = true;

        console.warn(
          "[EvidenceGuard] rejected unverified researcher evidence",
          {
            category,
            reason: guardTriggered
              ? "research-required-but-not-searched"
              : containsUnverifiedQuantitativeClaim(item)
              ? "unverified-quantitative-claim"
              : "search-not-succeeded",
            claim:
              item.claim ??
              item.name ??
              item.topic ??
              "(no claim)",
          }
        );

        continue;

      }

      keptItems.push(item);

      context.evidence.push({

        id: crypto.randomUUID(),

        claim:
          item.claim ??
          item.name ??
          item.topic ??
          item.feature ??
          item.metric ??
          item.segment ??
          item.model ??
          item.headline ??
          "Unknown",

        evidence: JSON.stringify(item),

        source:
          Array.isArray(item.sources)
            ? item.sources.join(", ")
            : item.sources ?? item.source,

        confidence:
          item.confidence >= 0.9
            ? "high"
            : item.confidence >= 0.7
            ? "medium"
            : "low",

        score: 0,

        hash,

        createdBy: "researcher",

        createdAt: Date.now(),

        tags: [category],

        references: [],

      });

    }

    parsed.evidence[category] = keptItems;

  }

  // STEP33: guardTriggeredによる却下が発生した場合、Researcher
  // 自身の既存出力フィールド(missingInformation)へその旨を追記する。
  // 新しいEvidenceスキーマ・新しいUIは追加しない。ユーザー・Writer
  // 双方に「検索できなかった/確認できなかった」状態を正直に伝える
  // ためのものであり、「調査した」「最新情報によると」等の誤解を
  // 招く表現をWriterが使わないようにする狙いがある。
  //
  // STEP80: rejectの発動条件を!searchPerformedのみへ広げたことに伴い、
  // 「外部検索が必要な要求でしたが」という原文言は、guardTriggered
  // (=researchRequired===trueの場合)以外でも表示されると不正確に
  // なる(researchRequiredがfalseのRunでも却下は起こり得るため)。
  // guardTriggeredの有無に関わらず正確な文言へ変更する。
  if (
    anyGuardRejection &&
    Array.isArray(parsed.missingInformation)
  ) {

    parsed.missingInformation.push(
      "今回のRunでは検索が成功していない" +
      "(未実行・失敗・0件のいずれかを含む)ため、" +
      "検索結果に基づかない情報はEvidenceとして採用しませんでした。"
    );

  }

}

// ===============================
// Researcher Handoff Guard (STEP91)
// ===============================
//
// 背景: STEP89/90の実測で、上記のEvidenceGuard(parsed.evidence
// [category]のみを検査)は正しく機能する一方、parsed.handoff
// (summary/importantPoints/recommendedFocus)は自由記述のテキスト
// であり、EvidenceGuardの走査対象外だった。このため、却下された
// はずの未検証Evidence(例:「学生の84%がAIスキルの重要性を
// 認識している」「最大60%向上」)と同じ内容が、handoff経由で
// Analystへそのまま伝播する実例が確認された
// (builder.tsのpreviousHandoffsセクションが"RESEARCHER Handoff"
// としてこれをそのまま提示するため)。
//
// 既存のcontainsUnverifiedQuantitativeClaim()(STEP20)を再利用し、
// !searchSucceeded(=今回のRunで検索が成功していない)の場合に、
// handoffの自由記述フィールドへ同じ検査を適用する。
//
// 重要な方針: handoff全体・Evidence pool・Analyst/Writerの分析
// 結果はいずれも削除しない。検出した場合も、Researcher Evidence
// 保存ブロックと同様に「事実として扱わない」旨をResearcher自身の
// 既存フィールド(handoff.missingInformation)へ追記するだけに
// 留める(handoff.summary/importantPoints/recommendedFocusの
// 内容そのものは書き換えない)。
if (
  agent.id === "researcher" &&
  parsed.handoff &&
  typeof parsed.handoff === "object" &&
  !searchSucceeded
) {

  const handoff = parsed.handoff as Record<string, unknown>;

  const handoffHasUnverifiedClaim =
    containsUnverifiedQuantitativeClaim({
      summary: handoff.summary ?? "",
      importantPoints: handoff.importantPoints ?? [],
      recommendedFocus: handoff.recommendedFocus ?? [],
    });

  if (handoffHasUnverifiedClaim) {

    console.warn(
      "[EvidenceGuard] unverified quantitative claim detected " +
      "in researcher handoff (search not succeeded this run)."
    );

    const handoffNote =
      "この申し送り内容(summary/importantPoints/recommendedFocus)には、" +
      "今回のRunで検索が成功していないにもかかわらず、具体的な数値・" +
      "統計が含まれている可能性があります。後続Agentはこれらを検証済みの" +
      "事実として扱わないでください。";

    if (Array.isArray(handoff.missingInformation)) {

      handoff.missingInformation.push(handoffNote);

    } else {

      handoff.missingInformation = [handoffNote];

    }

  }

}

context.logs.push({

    type: "finish",

    agent: agent.id,

    output: parsed,

    timestamp: new Date().toISOString(),

  });


  console.log(
    `${agent.name} COMPLETE`
  );


  return parsed;

}