import { classifyIntent } from "../tact-intent/ruleRouter";
import type { OrchestrationRequest } from "./types";
import type { Task, TaskExecutionSummary } from "./task";
import type { MemoryCandidate, MemoryCandidateType } from "./memoryCandidate";

// =========================
// buildMemoryCandidates (Phase 5)
// =========================
//
// 「Task Result → Memory Candidate Generation」の段階(絶対条件8:
// Candidate生成・保存判断・DB書き込みは別関数に分離する)。ここでは
// まだ何も保存しない。保存すべきかどうかの判断はmemoryPolicy.tsの
// 責務、実際の書き込みはmemoryWriter.tsの責務。
//
// Phase 5では追加LLM呼び出しを行わない(絶対条件7)。Task種別・
// Capability・result metadata(evidence件数/researchExecutionMode)・
// 明示的なMemory intent(core/tact-intent/ruleRouter.ts、STEP216で
// 確立済みのclassifyIntent()を再利用)という、既に手元にある決定論的な
// 情報だけでCandidateを組み立てる。
//
// 3つの経路(絶対条件14):
//   1. 明示的Memory Intent("覚えて"/"記憶して"等、STEP216のcore_push
//      判定と同じパターン) → 最優先。Candidateを必ず1件生成する。
//   2. 明示的な「好み」表明("今後は..."等) → user_preference候補。
//      1と2は独立した信号であり、どちらか一方だけが一致することも
//      両方一致しないこともある。
//   3. Research(web-research経路 かつ Evidenceを伴う場合のみ) →
//      knowledge_memory候補。Coreに既にあった情報(core-only経路)を
//      再度候補化しない(重複防止、絶対条件11の一部)。根拠のない
//      Agent発言は候補化しない(絶対条件9)。
// 上記いずれにも該当しないTask(挨拶・雑談・単純質問等)は候補0件
// (絶対条件6: 「覚えない」判断)。

// STEP216のCORE_PUSH_PATTERNと同じ思想: 辞書形("プロジェクトを使う"等)
// 単体には反応しない、依頼を表す活用形を伴う語だけを拾う既存方針を
// 踏襲する。ここでは「候補の種類」をさらに細かく分類するためだけに
// 使う、Candidate Builder専用の副次的な分類器。
function classifyExplicitMemoryType(text: string): MemoryCandidateType {

  if (/プロジェクト|project/i.test(text)) {
    return "project_memory";
  }

  if (/決め|採用|正式|標準とする/.test(text)) {
    return "decision_memory";
  }

  if (/(好み|方針|重視)/.test(text)) {
    return "user_preference";
  }

  return "other";

}

// 「今後は」/「これからは」で始まり、依頼形で終わる入力を、継続的な
// 好み(User Preference)の表明とみなす。STEP216のCORE_PUSH_PATTERN
// (「覚えて」等の明示的な保存語)とは独立した、別の信号であることに
// 注意(「今後はできるだけ簡潔に答えて」は"覚えて"を含まないため
// classifyIntent()単体ではcore_push と判定されない)。
const PREFERENCE_PATTERN =
  /^(今後は|これからは).*?(して|してください|お願いします|答えて)/;

// Research由来のcontentをそのまま無制限に保存しない(絶対条件1)。
// STEP198のEvidence.snippet(「最大500文字程度、単純な文字列切り
// 出し、要約LLMは使わない」)と同じ考え方を採用する。
const RESEARCH_CONTENT_MAX_LENGTH = 500;

function truncate(text: string, maxLength: number): string {

  return text.length > maxLength
    ? `${text.slice(0, maxLength)}...`
    : text;

}

function buildExplicitIntentCandidate(
  task: Task,
  request: OrchestrationRequest
): MemoryCandidate {

  return {

    content: task.description,

    memoryType: classifyExplicitMemoryType(task.description),

    scope: "user",

    ownerId: request.userId,

    source: `orchestrator:explicit_intent:task=${task.id}`,

    confidence: "high",

    // ユーザーが直接明言した情報は、Research由来の推測より重要度を
    // 高めに設定する(既存importanceスケール1〜10のうち、上寄り)。
    importance: 7,

    freshness: "durable",

    originTaskId: task.id,

    originCapability: task.assignedCapability,

    createdAt: new Date().toISOString(),

  };

}

function buildPreferenceCandidate(
  task: Task,
  request: OrchestrationRequest
): MemoryCandidate {

  return {

    content: task.description,

    memoryType: "user_preference",

    scope: "user",

    ownerId: request.userId,

    source: `orchestrator:preference_pattern:task=${task.id}`,

    confidence: "medium",

    importance: 6,

    freshness: "durable",

    originTaskId: task.id,

    originCapability: task.assignedCapability,

    createdAt: new Date().toISOString(),

  };

}

function buildResearchCandidate(
  task: Task,
  summary: TaskExecutionSummary,
  request: OrchestrationRequest
): MemoryCandidate | null {

  if (!summary.output) {
    return null;
  }

  const evidenceSource = summary.memoryUsed?.[0];

  return {

    // Phase36修正: 以前は"Q: {質問}\nA: {回答}"という内部形式で
    // 保存していたが、coreOnlyAnswer.tsのCore-only Answerability
    // (STEP180)がcontentを一切加工せずそのままユーザーへ返す設計の
    // ため、この内部形式がそのまま回答として露出する不具合を
    // Phase34/35のReality Testで実測確認した(coreOnlyAnswer.ts側は
    // 変更しない、絶対条件)。回答本文のみをcontentへ保存する。
    content: truncate(summary.output, RESEARCH_CONTENT_MAX_LENGTH),

    // 質問文はcontentから分離し、description(既存KnowledgeItem
    // フィールド、DB schema変更不要)へ保持する。
    description: truncate(task.description, RESEARCH_CONTENT_MAX_LENGTH),

    memoryType: "knowledge_memory",

    scope: "user",

    ownerId: request.userId,

    source: `orchestrator:research:task=${task.id}`,

    // Research自身が返すEvidence本体は複製せず、件数と最初の1件の
    // 参照だけを保持する(絶対条件9: 追跡可能にするだけで、根拠なき
    // 高信頼Memoryとしては扱わない)。
    evidence: evidenceSource
      ? [{ source: `core:${evidenceSource.kind}:${evidenceSource.id}` }]
      : undefined,

    // web-research経路(新規にWeb検索して得た情報)のみがこの関数へ
    // 到達する(呼び出し元でフィルタ済み)ため、confidenceは
    // "medium"に留める(Researchの成功=事実の確からしさの保証では
    // ないため、"high"にはしない、絶対条件9)。
    confidence: "medium",

    importance: 5,

    // Web検索結果は将来変わりうる情報として扱う(絶対条件10)。
    freshness: "volatile",

    originTaskId: task.id,

    originCapability: task.assignedCapability,

    createdAt: new Date().toISOString(),

  };

}

export function buildMemoryCandidates(
  task: Task,
  summary: TaskExecutionSummary,
  request: OrchestrationRequest
): MemoryCandidate[] {

  // 失敗・未実行(cancelled)のTaskからは候補を作らない。
  if (summary.status !== "completed") {
    return [];
  }

  const candidates: MemoryCandidate[] = [];

  const intentDecision = classifyIntent(task.description);

  if (intentDecision.intent === "core_push") {

    candidates.push(buildExplicitIntentCandidate(task, request));

  }

  if (PREFERENCE_PATTERN.test(task.description.trim())) {

    candidates.push(buildPreferenceCandidate(task, request));

  }

  if (
    task.assignedCapability === "research" &&
    summary.researchExecutionMode === "web-research" &&
    (summary.evidenceCount ?? 0) > 0
  ) {

    const researchCandidate = buildResearchCandidate(task, summary, request);

    if (researchCandidate) {
      candidates.push(researchCandidate);
    }

  }

  return candidates;

}
