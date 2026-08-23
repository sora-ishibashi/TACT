// =========================
// contextAssembly (STEP180/186/188)
// =========================
//
// ④Context Assembly。最終LLMへ渡す情報をCODEで組み立てる。
// LLMには「検索結果を整理して」とは依頼しない
// (STEP180絶対条件9: Evidence整理・重複排除・confidence付与は
// CODEの仕事)。ここで渡すのは、既にCODE側で選定・整理済みの
// Core Knowledge / Relevant Memory / Relevant Examples / Selected
// Web Evidenceだけであり、不要な履歴や巨大なドキュメントは含めない。
//
// STEP186: Knowledge Gap Detection(knowledgeGap.ts、STEP185)の
// 判定結果(covered/partial/missing)をContext Assemblyへ明示的に
// 伝達する。Requirement単位で「Coreにある情報」と「Webで補った
// 情報」をLLMが区別できるようにすることが目的(STEP186絶対条件)。
//
// 重要: 新しい関連度アルゴリズムは作らない。EvidenceがどのRequirement
// に対応するかは、既存のscoreRelevance()(relevance.ts)を再利用して
// 割り当てる(Requirement単位のEvidence追跡フィールドをwebResearch.ts
// /Evidence型へ新設することはしない。Search層は無変更のまま)。
//
// 既存の「query全体に対する関連度選定」(selectTopRelevant()による
// Core Knowledge/Memory/Examples)は、Requirementに紐付かない
// 補足的な文脈(General Context)として維持する(STEP186絶対条件:
// 既存の関連度選定ロジックを捨てない)。
//
// STEP188: assignEvidenceToRequirements()を「最高スコアのRequirement
// 1件のみへ割当」から「一定の関連度条件を満たす全Requirementへ
// 割当」へ変更した。1つのEvidenceが複数Requirementを同時に支える
// 場合の情報損失(STEP187監査で発見)を解消するため。閾値は新しい
// 値を作らず、knowledgeGap.tsのcovered判定と同じ
// MIN_RELEVANCE_SCORE(answerability.ts)を再利用する(理由:
// 「EvidenceがこのRequirementを十分に裏付けている」という基準は、
// 「Core Knowledgeがこの Requirementを十分にカバーしている」という
// 既存の基準と本質的に同じ強度であるべきであり、新しい閾値を
// 追加すると「Core側はcoveredの基準がXなのに、Evidence側はYで
// 割り当てられる」という不整合を生むため)。

import type { CoreContext } from "../tact-core";
import type { Evidence } from "../context/types";
import { selectTopRelevant, scoreRelevance } from "./relevance";
import { MIN_RELEVANCE_SCORE } from "./answerability";
import type { ResearchRequirement } from "./knowledgeGap";

const MAX_CORE_KNOWLEDGE = 5;
const MAX_CORE_MEMORY = 5;
const MAX_CORE_EXAMPLES = 3;

export interface AssembledResearchContext {

  systemPrompt: string;

  userPrompt: string;

  usedKnowledgeIds: string[];

  usedMemoryIds: string[];

  usedExampleIds: string[];

}

// STEP186: Research LLMの責務に、「Requirement単位でcovered/partial/
// missingを考慮すること」「CoreとWeb Evidenceの由来を区別すること」
// 「Evidenceが無い不足情報を推測しないこと」を明示的に追加した。
// 出力JSON形式自体(answer/keyFindings/evidenceIds/uncertainty)は
// STEP180から変更していない(既存のvalidateEvidenceIds()契約を
// 維持するため)。
const RESEARCH_LLM_SYSTEM_PROMPT = `
あなたはTACT ResearchのLLMです。

あなたの仕事は、渡されたCore情報とWeb Evidenceだけを根拠として、
ユーザーの質問に回答することです。

以下は禁止です。

・Evidenceに存在しない新しい事実を作ること
・Evidence一覧をそのまま転記すること(統合・分析した上で回答すること)
・確認できない情報を断定すること

Evidenceの重複排除・confidence評価・出典整理は既にコード側で
完了しています。あなたはそれを再度行う必要はありません。

========================
Requirement単位の情報構造について(STEP186)
========================

ユーザーの質問は、いくつかの情報要求(Requirement)に分解されています。
各Requirementには以下のいずれかの状態が付いています。

・covered  … Core(TACTが過去に蓄積した情報)だけで十分に回答できる
・partial  … Coreに一部関連する情報があるが、不足分をWebで補った
・missing  … Coreに十分な情報がなく、Webで調査した

Coreは「TACTが過去に蓄積した情報」、Web Evidenceは「今回のResearchで
新たに取得した情報」です。この2つの由来を混同せず、必要に応じて
どちらに基づく記述かが分かるようにしてください。

partialなRequirementについては、Core情報とWeb Evidenceの両方を
統合して回答してください。「Web Evidenceだけを見る」という扱いは
しないでください。

missingなRequirementについて、対応するWeb Evidenceが0件の場合は、
その情報が確認できなかったことを明示してください(uncertaintyへ
記載する等)。存在しない事実を推測で補ってはいけません。

========================
出力形式
========================

必ず以下のJSON形式のみで回答してください。

{
  "answer": "ユーザーの質問への回答本文",
  "keyFindings": ["回答の根拠となった重要な事実を短く列挙"],
  "evidenceIds": ["回答の根拠として実際に使用したWeb EvidenceのID"],
  "uncertainty": "確認できなかった点や限界(なければ省略可)"
}

evidenceIdsには、渡されたWeb Evidence一覧に実在するIDのみを
含めてください。存在しないIDを作成してはいけません。
`.trim();

function formatKnowledgeBlock(
  items: CoreContext["knowledge"]
): string {

  if (items.length === 0) {
    return "(なし)";
  }

  return items
    .map((item) => `- [${item.id}] ${item.title}: ${item.content}`)
    .join("\n");

}

function formatMemoryBlock(
  items: CoreContext["memories"]
): string {

  if (items.length === 0) {
    return "(なし)";
  }

  return items
    .map((item) => `- [${item.id}] ${item.content}`)
    .join("\n");

}

function formatExampleBlock(
  items: CoreContext["examples"]
): string {

  if (items.length === 0) {
    return "(なし)";
  }

  return items
    .map(
      (item) =>
        `- [${item.id}] ${item.title}` +
        (item.reason ? `（${item.reason}）` : "")
    )
    .join("\n");

}

function formatEvidenceList(
  evidence: Evidence[]
): string {

  if (evidence.length === 0) {
    return "(なし)";
  }

  return evidence
    .map(
      (item) =>
        `- [${item.id}] ${item.claim}: ${item.evidence}` +
        ` (source: ${item.source ?? "unknown"}, confidence: ${item.confidence})`
    )
    .join("\n");

}

// =========================
// assignEvidenceToRequirements (STEP186)
// =========================
//
// 各Web Evidenceが、どのRequirementの調査によって得られたものかを
// 明示的に追跡する仕組みはSearch層(webResearch.ts)に存在しない
// (buildGapResearchQueries()がRequirement単位でQueryを生成した後、
// performWebResearch()は全Queryの結果を1つのEvidence配列へ集約する
// ため)。ここでは新しいEvidence追跡フィールドを追加する代わりに、
// 既存のscoreRelevance()を使ってEvidenceを最も関連度の高い
// Requirementへ事後的に割り当てる(表示上のグルーピングのみ。
// generateLLMAnswer()へ渡すevidencePool自体は変更しない)。
//
// どのRequirementとも関連度0の場合は、"unassigned"として別枠へ入れ、
// Evidence自体を握りつぶさないようにする。
function assignEvidenceToRequirements(
  requirements: ResearchRequirement[],
  evidence: Evidence[]
): { byRequirementId: Map<string, Evidence[]>; unassigned: Evidence[] } {

  const byRequirementId = new Map<string, Evidence[]>();

  for (const requirement of requirements) {
    byRequirementId.set(requirement.id, []);
  }

  const unassigned: Evidence[] = [];

  for (const item of evidence) {

    const searchableText = `${item.claim} ${item.evidence}`;

    // STEP188: 「最高スコア1件のみ」ではなく、MIN_RELEVANCE_SCORE
    // (既存、covered判定と同じ閾値)以上のRequirement全てを割当対象
    // とする。これにより、複数Requirementを同時に裏付けるEvidenceの
    // 情報損失を防ぐ(Rule 2)。閾値未満のRequirementへは割り当てない
    // (Rule 3: 低関連度Requirementへの無差別割当を禁止)。
    const qualifyingRequirementIds = requirements
      .map((requirement) => ({
        id: requirement.id,
        score: scoreRelevance(searchableText, requirement.query),
      }))
      .filter((scored) => scored.score >= MIN_RELEVANCE_SCORE)
      .map((scored) => scored.id);

    if (qualifyingRequirementIds.length > 0) {

      // Rule 5: 同一Evidenceを同一Requirementへ複数回入れない
      // (requirementsは一意なidを持つため、qualifyingRequirementIds
      // 自体に重複は生じない)。
      for (const requirementId of qualifyingRequirementIds) {
        byRequirementId.get(requirementId)!.push(item);
      }

    } else {

      // Rule 4: 割当されたEvidenceはOther Web Evidenceには出さない。
      // どのRequirementの閾値も満たさなかった場合のみここに入る
      // (Evidence自体は破棄しない)。
      unassigned.push(item);

    }

  }

  return { byRequirementId, unassigned };

}

function formatRequirementBlock(
  requirement: ResearchRequirement,
  context: CoreContext,
  requirementEvidence: Evidence[]
): string {

  const matchedKnowledge = context.knowledge.filter((item) =>
    requirement.matchedKnowledgeIds.includes(item.id)
  );

  const matchedMemories = context.memories.filter((item) =>
    requirement.matchedMemoryIds.includes(item.id)
  );

  const coreBlock =
    matchedKnowledge.length === 0 && matchedMemories.length === 0
      ? "(なし)"
      : [
          ...matchedKnowledge.map(
            (item) => `- [${item.id}] ${item.title}: ${item.content}`
          ),
          ...matchedMemories.map((item) => `- [${item.id}] ${item.content}`),
        ].join("\n");

  // STEP186絶対条件(F): coveredなRequirementはWeb Evidenceを
  // 無理に要求しない。covered以外でEvidence 0件の場合は、
  // 「検索したが取得できなかった」ことを明示し、LLMが推測で
  // 補完しないよう促す。
  let evidenceBlock: string;

  if (requirement.status === "covered") {

    evidenceBlock =
      requirementEvidence.length > 0
        ? formatEvidenceList(requirementEvidence)
        : "(Coreで充足済みのため、Web検索は行っていません)";

  } else if (requirementEvidence.length === 0) {

    evidenceBlock =
      "(Web検索を行いましたが、有効なEvidenceを取得できませんでした。" +
      "この点については推測で補完せず、不足していることを明示してください)";

  } else {

    evidenceBlock = formatEvidenceList(requirementEvidence);

  }

  return `
[${requirement.id}] "${requirement.query}" — status: ${requirement.status}

  Core情報:
  ${coreBlock}

  Web Evidence:
  ${evidenceBlock}
`.trim();

}

export function assembleResearchContext(params: {

  query: string;

  context: CoreContext;

  evidence: Evidence[];

  // STEP186: Knowledge Gap Detection(knowledgeGap.ts)の判定結果。
  // Web Research分岐では常にdetectKnowledgeGap()の結果が渡される
  // (runResearch.ts参照)。
  requirements: ResearchRequirement[];

}): AssembledResearchContext {

  const { query, context, evidence, requirements } = params;

  // ---- 既存の「query全体に対する関連度選定」(General Context) ----
  // STEP186絶対条件: 既存の関連度選定ロジックを捨てない。
  // Requirementに紐付かない補足的な文脈として維持する。
  const selectedKnowledge = selectTopRelevant(
    context.knowledge,
    (item) => `${item.title} ${item.description ?? ""} ${item.content}`,
    query,
    MAX_CORE_KNOWLEDGE
  );

  const selectedMemories = selectTopRelevant(
    context.memories,
    (item) => item.content,
    query,
    MAX_CORE_MEMORY
  );

  const selectedExamples = selectTopRelevant(
    context.examples,
    (item) => `${item.title} ${item.description ?? ""} ${item.reason ?? ""}`,
    query,
    MAX_CORE_EXAMPLES
  );

  // ---- Requirement単位のGap-aware Context ----
  const { byRequirementId, unassigned } =
    assignEvidenceToRequirements(requirements, evidence);

  const requirementBlocks = requirements
    .map((requirement) =>
      formatRequirementBlock(
        requirement,
        context,
        byRequirementId.get(requirement.id) ?? []
      )
    )
    .join("\n\n");

  const unassignedBlock =
    unassigned.length > 0
      ? `\n\n========================\nOther Web Evidence(特定のRequirementに紐付かなかったもの)\n========================\n${formatEvidenceList(unassigned)}`
      : "";

  const userPrompt = `
========================
User Query
========================
${query}

========================
Requirement Breakdown(Knowledge Gap Detection結果)
========================
${requirementBlocks || "(Requirementへの分解結果がありません)"}
${unassignedBlock}

========================
General Context(query全体に対する参考情報)
========================

Core Knowledge:
${formatKnowledgeBlock(selectedKnowledge)}

Relevant Memory:
${formatMemoryBlock(selectedMemories)}

Relevant Examples:
${formatExampleBlock(selectedExamples)}
`.trim();

  // STEP186: usedKnowledgeIds/usedMemoryIds/usedExampleIdsは、
  // Requirement単位でCoreとして提示したもの(matchedKnowledgeIds等)と、
  // General Contextとして提示したもの(selectedKnowledge等)の両方の
  // 合併とする(重複除去)。「実際にLLMへ提示した」という既存の意味を
  // 維持したまま、Requirement単位の情報も反映する。
  const requirementKnowledgeIds = requirements.flatMap(
    (requirement) => requirement.matchedKnowledgeIds
  );

  const requirementMemoryIds = requirements.flatMap(
    (requirement) => requirement.matchedMemoryIds
  );

  const usedKnowledgeIds = Array.from(
    new Set([...selectedKnowledge.map((item) => item.id), ...requirementKnowledgeIds])
  );

  const usedMemoryIds = Array.from(
    new Set([...selectedMemories.map((item) => item.id), ...requirementMemoryIds])
  );

  const usedExampleIds = selectedExamples.map((item) => item.id);

  return {
    systemPrompt: RESEARCH_LLM_SYSTEM_PROMPT,
    userPrompt,
    usedKnowledgeIds,
    usedMemoryIds,
    usedExampleIds,
  };

}
