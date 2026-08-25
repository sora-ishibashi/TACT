// =========================
// answerability (STEP180)
// =========================
//
// 「この質問はCoreにある情報だけで安全に回答できるか？」をLLMを
// 使わずに判定する純関数。STEP179監査の結論(CODE化可能な判定を
// LLMへ投げない)を反映した、Research Pipelineの②Answerability判定。
//
// 重要: 「Coreに関連情報が1件見つかった」だけでLLM 0回経路へ倒しては
// いけない(STEP180絶対条件)。以下の条件をすべて満たす場合のみ
// canAnswerFromCoreOnly=trueとする。
//
//   1. Simple fact pattern に一致する(曖昧な質問・比較・推論を伴う
//      質問は対象外)
//   2. 時間依存シグナルを含まない(「最新」「現在」「2026年」等)
//   3. Core内に十分関連度の高いKnowledge/Memoryが存在する
//      (MIN_RELEVANCE_SCORE以上)
//   4. 上位候補が拮抗していない(僅差で複数ヒットする場合は、矛盾・
//      曖昧さの可能性を疑い0回経路を見送る)
//
// 1つでも満たさない場合は必ずfalseを返し、呼び出し元(runResearch.ts)は
// Web Research経路(LLM最大1回)へ進む。

import type { CoreContext, CoreMemory, KnowledgeItem } from "../tact-core";
import { scoreRelevance } from "./relevance";

// STEP179監査で確認した、core/evidence/researchRequirement.ts・
// evidenceMode.tsと同じ考え方(正規表現ベースの機械判定)を、
// TACT Research内で独立して適用する。既存ファイル自体はimportも
// 変更もしない(STEP180絶対条件: core/evidence/*は変更禁止。
// importして再利用することは許可されているが、ここでの判定基準は
// Research固有の「Core-onlyで答えてよいか」であり、Legacy Workflowの
// 「検索が必要か」の判定とは目的が異なるため独立実装とした)。
const TIME_SENSITIVE_PATTERNS: RegExp[] = [
  /最新/,
  /現在/,
  /今日/,
  /今年/,
  /今月/,
  /今週/,
  /最近/,
  /直近/,
  /今の/,
  /現時点/,
  /トレンド/,
  /将来/,
  /今後/,
  /20\d{2}年/,
  /\blatest\b/i,
  /\bcurrent\b/i,
  /\btoday\b/i,
  /\bnow\b/i,
  // Phase42: 「〜は誰ですか/どなたですか」は、具体的な役職名(社長/CEO/
  // 学長/市長/知事等)を列挙しなくても、「ある役職・地位に現在誰が
  // 就いているか」を問う質問全般を包括的に捉えられる、文法的に
  // 一般化された時間依存シグナル(役職の在任者は交代しうるため)。
  // 特定の役職名を辞書として大量列挙する場当たり的な対応
  // (Phase42絶対条件18で明示的に禁止)を避けつつ、Phase41で発見した
  // 「代表者/CEO/学長等は本質的に時間依存だが明示的な時制語を伴わない」
  // 問題の主要な形(「〜は誰ですか」という質問形)を、hasTimeSensitiveSignal()
  // (assessAnswerability()・knowledgeGap.tsのcanAnswerAllFromCoreOnly()
  // 両方から共有される既存の唯一の判定関数)経由でカバーする。
  /は誰/,
  /はどなた/,
];

// STEP180の指示に挙げられた例(「○○とは？」「○○の所在地は？」等)を
// そのまま反映した、意図的に狭い正規表現セット。判定を緩くしすぎない
// ため、曖昧な質問・比較・分析を要求する質問には一致しないようにする。
//
// Phase42: "代表者"はSTEP180制定時からここに含まれていたが、Phase41の
// 調査で「本質的に時間依存(在任者が交代しうる)な属性」であることが
// 判明した(所在地/設立年/目的/定義は比較的durableなのに対し、代表者は
// 性質が異なる)。durableな他の4語とは別カテゴリのため、この4語は
// 維持しつつ"代表者"のみ除外する(Phase42絶対条件18: 大量のキーワード
// 追加/削除ではなく、根拠のある1語の是正に留める)。
const SIMPLE_FACT_PATTERNS: RegExp[] = [
  /とは[?？]?$/,
  /の(所在地|設立年|目的|定義)は/,
  /(以前|前回)決めた.*は(何|なに|どれ)/,
];

// 「十分関連度が高い」の閾値。scoreRelevance()はn-gram単位の重複を
// 加点していくため、真に関連するKnowledge/Memoryは複数のn-gramが
// 重複して比較的高いスコアになりやすい。偶然の短い部分一致だけで
// 0回経路に倒れないよう、単純な空白区切りtoken一致数(STEP177時点の
// 閾値=2)より高めに設定する。
//
// STEP185: knowledgeGap.tsのcovered/partial/missing判定でも、
// 「新しい関連度アルゴリズムを勝手に作らない」という絶対条件に
// 従い、この閾値をそのまま再利用する(exportして共有する)。
export const MIN_RELEVANCE_SCORE = 4;

// 上位候補と次点候補が僅差(次点 × 1.5 > 上位)の場合は、複数の
// Knowledge/Memoryが競合している可能性が高いとみなし、拮抗と判定する。
const DOMINANCE_RATIO = 1.5;

export interface AnswerabilityMatch {

  knowledge: KnowledgeItem[];

  memories: CoreMemory[];

}

export interface AnswerabilityResult {

  canAnswerFromCoreOnly: boolean;

  reason: string;

  match: AnswerabilityMatch;

}

// STEP185: knowledgeGap.tsの「全Requirementがcoveredであっても、
// 元のqueryが時間依存なら0回経路(Core-only)を許可しない」という
// 安全弁でもこの判定をそのまま再利用する(exportして共有する)。
// 時間依存性の判定基準を2箇所で別々に持たない。
export function hasTimeSensitiveSignal(query: string): boolean {
  return TIME_SENSITIVE_PATTERNS.some((pattern) => pattern.test(query));
}

// =========================
// Volatile Research Knowledge除外 (Phase94)
// =========================
//
// Root Cause(Phase91〜93投資調査、Repository Evidence: 3回の独立した
// 実Reality Testで再現): memoryCandidateBuilder.tsのbuildResearchCandidate()
// は、Web Research由来のKnowledgeを"freshness: volatile"(絶対条件10
// 「Web検索結果は将来変わりうる情報として扱う」)として区別していたが、
// この値がPhase94まで一切recordKnowledge()へ渡っておらず、"durable"な
// Knowledgeと区別なく永続化されていた。その結果、あるConversationの
// Research結果がscope:"user"のKnowledgeとして永続化された後、全く
// 別のConversationの後続Turnがそれを拾い、このassessAnswerability()や
// knowledgeGap.tsのcanAnswerAllFromCoreOnly()がCore-only経路
// (LLM 0回・Search 0回)へ短絡してしまうことを確認した(claim=古い
// User Input、source=古いtask IDがそのままEvidenceとして混入)。
//
// hasTimeSensitiveSignal()による安全弁は、判定対象がその時点で
// runResearch()へ渡された「query文字列そのもの」に限られる(STEP180/
// 185の既存設計)。extractResearchTopic()(Phase88)・
// buildSupplementalResearchQuery()(Phase78)のような、後続Turnの
// トピック凝縮処理が「最初の文だけ」を対象とするため、元の依頼文の
// 後半にあった時間依存語(例:「2026年8月〜10月」)が凝縮後のqueryから
// 失われることがあり、Turn1では機能した時間依存性ガードがTurn2/Turn3
// では機能しなくなる。トピック凝縮ロジック自体(Phase88/92)は意図通り
// 動作しているため変更しない。
//
// 修正方針: core/tact-core/supabaseCoreCapability.tsのselectKnowledgeByOwner()
// (loadContext()・retrieveKnowledge()共有の取得箇所、既存の
// isLegacyResearchKnowledge()がここで除外を行う)では除外しない。
// retrieveKnowledge()はapp/api/tact/knowledge/route.ts(UI「過去の
// Research/Knowledge」タブ)からも呼ばれており、ここで一律除外すると、
// ユーザーが過去のResearch結果を閲覧するという正当な機能まで壊して
// しまう(isLegacyResearchKnowledge()が「内容として壊れているデータ」を
// 除外するのに対し、こちらは「内容は正しいが、新しい質問への即答の
// 根拠としては安全ではない」という別種の問題であり、同じ場所で同じ
// ように除外すべきではない)。
//
// 代わりに、Core-only Answerability(LLM 0回・Search 0回)を判定する
// 2箇所——このファイルのassessAnswerability()・knowledgeGap.tsの
// classifyRequirement()——でのみ、context.knowledgeをスコアリングする
// 直前にこの関数がtrueを返すKnowledgeItemを候補から除外する。
// durable(継続的な事実)なKnowledge・Memory・Research以外の経路
// (explicit_intent/preference)は対象外(絶対条件: 過剰な無効化をしない)。
//
// 判定条件(いずれかを満たせば除外):
//   1. source が "orchestrator:research:" で始まる —— buildResearchCandidate()
//      (memoryCandidateBuilder.ts)は現在の実装上、この形式のsourceを
//      持つ候補を常にfreshness:"volatile"としてのみ生成するため
//      (durableなResearch知識を生成する分岐は存在しない)、source自体が
//      実質的な判定条件として十分であり、かつPhase94修正より前に
//      書き込まれた既存の古いRow(metadataが無い)も遡って除外できる
//      (実Reality Testで確認したPhase91起源の混入データがこれに該当する)。
//   2. metadata.freshness === "volatile" —— 1で捕捉できない将来の
//      Research由来source命名の変化に備えた保険。
export function isVolatileResearchKnowledge(item: KnowledgeItem): boolean {

  return (
    item.source.startsWith("orchestrator:research:") ||
    item.metadata?.freshness === "volatile"
  );

}

function isSimpleFactPattern(query: string): boolean {
  return SIMPLE_FACT_PATTERNS.some((pattern) => pattern.test(query));
}

type ScoredItem =
  | { type: "knowledge"; item: KnowledgeItem; score: number }
  | { type: "memory"; item: CoreMemory; score: number };

const EMPTY_MATCH: AnswerabilityMatch = { knowledge: [], memories: [] };

export function assessAnswerability(
  query: string,
  context: CoreContext
): AnswerabilityResult {

  if (hasTimeSensitiveSignal(query)) {

    return {
      canAnswerFromCoreOnly: false,
      reason:
        "時間依存の質問(最新/現在/年号等)と判定したため、" +
        "Core情報のみでは回答せずWeb Researchへ進む。",
      match: EMPTY_MATCH,
    };

  }

  if (!isSimpleFactPattern(query)) {

    return {
      canAnswerFromCoreOnly: false,
      reason:
        "単純な事実質問のパターンに一致しないため、比較・分析・推論が" +
        "必要な可能性があると判断し、Web Research経路へ進む。",
      match: EMPTY_MATCH,
    };

  }

  // Phase94: Core-only Answerabilityの根拠としては、volatileな
  // Research由来Knowledgeを対象外とする(isVolatileResearchKnowledge()
  // 参照)。context.knowledge自体は変更しない(このスコアリング専用の
  // 絞り込み)。
  const scoredKnowledge: ScoredItem[] = context.knowledge
    .filter((item) => !isVolatileResearchKnowledge(item))
    .map((item) => ({
      type: "knowledge",
      item,
      score: scoreRelevance(
        `${item.title} ${item.description ?? ""} ${item.content}`,
        query
      ),
    }));

  const scoredMemories: ScoredItem[] = context.memories.map((item) => ({
    type: "memory",
    item,
    score: scoreRelevance(item.content, query),
  }));

  const candidates = [...scoredKnowledge, ...scoredMemories]
    .filter((scored) => scored.score >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {

    return {
      canAnswerFromCoreOnly: false,
      reason:
        "十分に関連度の高いKnowledge/Memoryが見つからなかったため、" +
        "Web Research経路へ進む。",
      match: EMPTY_MATCH,
    };

  }

  const top = candidates[0];
  const second = candidates[1];

  if (second && second.score * DOMINANCE_RATIO > top.score) {

    return {
      canAnswerFromCoreOnly: false,
      reason:
        "複数のKnowledge/Memoryが拮抗しており、矛盾または曖昧さの" +
        "可能性があるため、0回経路を見送りWeb Research経路へ進む。",
      match: EMPTY_MATCH,
    };

  }

  const match: AnswerabilityMatch =
    top.type === "knowledge"
      ? { knowledge: [top.item], memories: [] }
      : { knowledge: [], memories: [top.item] };

  return {
    canAnswerFromCoreOnly: true,
    reason:
      "単純な事実質問であり、時間依存性がなく、Coreに十分関連する" +
      "情報が一意に存在するため、LLMを使わずCore情報のみで回答する。",
    match,
  };

}
