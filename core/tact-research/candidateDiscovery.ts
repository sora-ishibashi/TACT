// =========================
// candidateDiscovery (Phase93)
// =========================
//
// Root Cause(Phase92投資調査、Repository Evidence: Phase90〜92の3回の
// 実Reality Test): Discoveryの検索結果はポータル/一覧ページ(「キャリタス
// 就活」「ONE CAREER」等)に集中し、それら自身がEntityとして
// parseStructuredEntitiesFromText()(tact-conversation層)へ渡っても、
// 開催日・参加費・定員のような個別属性がEvidence本文に含まれないため
// Groundingを通過できない(実データで確認済み)。
//
// 目的: Discoveryで得たEvidence(core/context/types.tsのEvidence[]、
// 新しい型は増やさない)から、「ポータルではなく個別の調査対象らしい
// もの」をCandidate Entityとして決定論的に抽出する(LLM不使用)。
// これはtact-conversation層のparseStructuredEntitiesFromText()/
// groundParsedEntities()(LLM回答テキストからEntityを抽出・検証する、
// Phase79/83)とは別の、より早い段階の処理であり、責務が重複しない
// (こちらはSearch結果そのものから「何を深掘りすべきか」を決めるだけで、
// 最終的なArtifact用Entity/Fieldの確定は従来通りtact-conversation層が
// 担う)。
//
// 決定論的heuristicのみ(新しいNLU・LLM呼び出しは追加しない、Section2
// 絶対条件): タイトルにポータル/一覧を示す語が含まれていないEvidenceを
// Candidateとみなす。完全ではない(語彙に一致しない一覧ページを
// 誤ってCandidate扱いする場合がある)が、その場合でも後段のGrounding
// (tact-conversation層、Phase83、無変更)が実際にEvidence本文で
// 裏付けられない値を採用しないため、捏造には繋がらない
// (Candidate判定の誤りは「無駄なDeepening検索1件」に留まる)。

import type { Evidence } from "../context/types";
import { DEFAULT_DEEPENING_ATTRIBUTES } from "./queryGeneration";

const PORTAL_TITLE_MARKERS = [
  "一覧",
  "ポータル",
  "検索",
  "まとめサイト",
  "トップ",
  "TOP",
  "求人サイト",
  "情報サイト",
];

// =========================
// Phase97: Candidate判定の追加heuristic
// =========================
//
// Root Cause(Phase96投資調査、Repository Evidence: Phase95の実
// Reality Test結果): PORTAL_TITLE_MARKERS(固定8語の部分文字列一致)は
// Phase90〜92で観測された「一覧」「ポータルサイト」等を含むタイトルしか
// 捕捉できず、Phase95で実際に観測された以下3パターンを見逃していた。
//   1. 件数付き一覧(例:「愛知県のインターン・インターンシップ（2212件）」)
//   2. 案内文型タイトル(例:「〜はこちら」「〜のインターンシップ情報」)
//   3. 複数主体型イベント・集合ページ(例: EXPO/合同説明会/フェア)
// このうち1・2は「タイトルの型」だけでほぼ確実にCollection/Portalと
// 判定できるため、既存PORTAL_TITLE_MARKERSと同じ「強いシグナル即除外」
// として扱う。一方3は、「合同説明会」「EXPO」自体が独立した1つの
// イベント(比較対象として成立するEntity)である可能性があるため
// (Phase97 Section4の絶対条件)、単語一致だけでは除外せず、URLが
// Collection/Portalらしいパターンと一致した場合のみ組み合わせて除外する
// (Phase97 Section2: URL単独でも除外しない、個別EntityのURLに
// 偶然「search」等が含まれる可能性があるため)。
//
// ドメイン固有(インターンシップ・愛知県等)の語彙は一切追加しない
// (Phase97絶対条件)。

// STEP: 件数付き一覧(「（2212件）」「(123件)」等)。全角/半角括弧・
// 間の空白揺れを許容するが、語彙自体は完全に汎用(業界・地域を問わない)。
const LISTING_COUNT_PATTERN = /[（(]\s*\d+\s*件\s*[）)]/;

// STEP: 案内文型タイトル。「〜はこちら」「〜◯◯情報」のように、単一の
// 具体的な開催情報ではなく「案内・入口」であることを示すタイトル末尾の
// パターン。末尾一致のみを対象とする(タイトル中間に「情報」が含まれる
// だけの個別Entityまで誤って除外しないため、既存PORTAL_TITLE_MARKERSの
// 「部分文字列ならどこでも一致」より厳しい条件にする)。
const GUIDANCE_TITLE_SUFFIX_PATTERN = /(はこちら|情報)$/;

// Phase97 Section4: 単語単体では除外条件にしない弱いシグナル。
// 「合同説明会」「EXPO」等の複数主体型イベント名を含んでいても、
// それ自体が独立した開催日・参加費・対象者を持つ1つのEntityで
// あり得るため、この語彙単独で機械的に除外しない(下記
// isLikelyCollectionOrPortal()でURLシグナルと組み合わせた場合のみ使う)。
const MULTI_PARTY_EVENT_MARKERS = [
  "EXPO",
  "合同説明会",
  "合同企業説明会",
  "フェア",
];

// Phase97 Section2: Collection/Portalらしさの補助シグナルとなる
// URLパターン。個別EntityのURLにも偶然含まれ得るため、単独では
// Candidateを除外しない(下記isLikelyCollectionOrPortal()参照)。
const PORTAL_URL_MARKERS = [
  "/list",
  "/lists",
  "/search",
  "/kw/",
  "/area/",
  "/areas/",
  "/category/",
  "/categories/",
  "/lst-",
  "/result",
  "/results",
  "/ranking",
];

function hasStrongPortalTitleSignal(title: string): boolean {

  return (
    PORTAL_TITLE_MARKERS.some((marker) => title.includes(marker)) ||
    LISTING_COUNT_PATTERN.test(title) ||
    GUIDANCE_TITLE_SUFFIX_PATTERN.test(title.trim())
  );

}

function hasWeakMultiPartyEventSignal(title: string): boolean {

  return MULTI_PARTY_EVENT_MARKERS.some((marker) => title.includes(marker));

}

function hasPortalUrlSignal(url: string | undefined): boolean {

  if (!url) {
    return false;
  }

  const lower = url.toLowerCase();

  return PORTAL_URL_MARKERS.some((marker) => lower.includes(marker));

}

// Phase97: タイトル単体の強いシグナル(既存PORTAL_TITLE_MARKERS +
// 件数付き一覧 + 案内文型)であれば即Collection/Portal判定とする。
// 弱いシグナル(複数主体型イベント語)は、URLもCollection/Portalらしい
// 場合にのみ組み合わせて判定する(Section2・4の両方の絶対条件を満たす)。
function isLikelyCollectionOrPortal(item: {
  claim: string;
  source?: string;
}): boolean {

  if (hasStrongPortalTitleSignal(item.claim)) {
    return true;
  }

  if (
    hasWeakMultiPartyEventSignal(item.claim) &&
    hasPortalUrlSignal(item.source)
  ) {
    return true;
  }

  return false;

}

const MIN_CANDIDATE_TITLE_LENGTH = 6;

export interface CandidateEntity {

  // Evidence.claim(タイトル)をそのまま採用する。LLMによる言い換え・
  // 要約は行わない(Section3「調査対象Entityを分離する」の最小実装)。
  name: string;

  url?: string;

  source?: string;

  // 由来元Evidenceのid(Deepening対象選定・後段のEvidence参照に使う、
  // Artifactへは反映しない内部情報)。
  evidenceId: string;

  // Deepening対象選定(needsDeepening())にのみ使う、由来元Evidenceの
  // claim+evidence本文。Candidate自体の表示・Artifact化には使わない。
  evidenceText: string;

}

// Discovery結果から、ポータル/一覧ページらしいものを除いた
// Candidate Entityを抽出する。
export function discoverCandidateEntities(
  evidence: Evidence[]
): CandidateEntity[] {

  return evidence

    .filter((item) => !!item.claim && item.claim.trim().length >= MIN_CANDIDATE_TITLE_LENGTH)

    .filter((item) => !isLikelyCollectionOrPortal({ claim: item.claim, source: item.source }))

    .map((item) => ({

      name: item.claim.trim(),

      url: item.source,

      source: item.source,

      evidenceId: item.id,

      evidenceText: `${item.claim} ${item.evidence ?? ""}`,

    }));

}

// =========================
// Phase99: 最終Evidence選定でのIndividual Entity優先
// =========================
//
// Root Cause(Phase98投資調査、Repository Evidence: Phase98実
// Reality Test結果): discoverCandidateEntities()/selectDeepeningCandidates()
// はDeepening「検索対象」の選定にのみ関わり、Deepeningで実際に個別
// Entityらしい検索結果(例:「2025年度 愛知県『留学生地域定着・活躍
// 促進事業』留学生インターンシップ（夏季）について」)が得られても、
// runResearch.tsのcombinedEvidence統合ではcore/evidence/selectEvidence.ts
// (retrieveEvidence.ts、キーワード一致度中心の共有ランキング)がそのまま
// 適用されるため、汎用的な地域・属性キーワードを多く含むPortal/一覧
// ページ(SEO的にタイトルへ広域キーワードを含みやすい)に押し出されて
// 最終的にLLMへ渡らないことが実データで確認された。
//
// 設計方針(Phase99絶対条件): 共有関数のcore/evidence/retrieveEvidence.ts・
// rankEvidence.ts・selectEvidence.tsは一切変更しない(Legacy Workflow
// core/workflow/runAgent.tsが同じ関数を直接利用しているため、変更すると
// Research以外のConsumerにも影響が及ぶ、Phase99投資調査で確認済み)。
// 代わりに、Research Pipeline側(runResearch.ts)でのみ、既存の
// selectEvidence()の結果(関連度順にランク済みのEvidence[])に対して、
// 「Portal/Collectionらしくないもの」を優先する決定論的な後処理を
// 追加する。isLikelyCollectionOrPortal()はcandidateDiscovery.ts
// (Phase93/97)で既に検証済みの同じ判定をそのまま再利用するだけであり、
// 新しいheuristic・新しいLLM呼び出し・新しいSchemaは一切追加しない。
//
// 重要な制約:
//   - Portal Evidenceを排除しない。個別Entityらしい項目が無い/足りない
//     場合は、既存通りPortal Evidenceで埋める(全面排除の禁止)。
//   - 各項目内の相対順序(既存selectEvidence()が付けた関連度順)は、
//     Individual/Portalそれぞれのグループ内で維持する(安定ソート、
//     titleBonus等の既存シグナルを完全に上書きしない)。
//   - Evidence自体の内容(claim/evidence本文/confidence等)は一切
//     変更しない。並び替えと件数の絞り込みのみを行う(捏造なし)。
export function prioritizeIndividualEntityEvidence(
  relevanceRankedEvidence: Evidence[],
  limit: number
): Evidence[] {

  const individualLike = relevanceRankedEvidence.filter(
    (item) => !isLikelyCollectionOrPortal({ claim: item.claim, source: item.source })
  );

  const portalLike = relevanceRankedEvidence.filter((item) =>
    isLikelyCollectionOrPortal({ claim: item.claim, source: item.source })
  );

  return [...individualLike, ...portalLike].slice(0, limit);

}

// Phase93 Section9: 「すべてのCandidateについて無条件にDeepeningする
// のではなく」— 既にEvidence本文中に要求Attributeがひととおり揃って
// いるCandidateは、追加検索の価値が低いため除外する。
function needsDeepening(
  candidate: CandidateEntity,
  attributes: string[]
): boolean {

  return attributes.some((attribute) => !candidate.evidenceText.includes(attribute));

}

// Phase93 Section7・20: Deepeningは無制限に増やさない。既定の上限
// (MAX_DEEPENING_CANDIDATES)と、指定があればrequestedRowCountの
// どちらか小さい方を採用する(要求件数が1件なら1件しか深掘りしない)。
const MAX_DEEPENING_CANDIDATES = 5;

export function selectDeepeningCandidates(
  candidates: CandidateEntity[],
  options: { attributes?: string[]; requestedRowCount?: number } = {}
): CandidateEntity[] {

  const attrs =
    options.attributes && options.attributes.length > 0
      ? options.attributes
      : DEFAULT_DEEPENING_ATTRIBUTES;

  const cap =
    options.requestedRowCount !== undefined
      ? Math.max(1, Math.min(MAX_DEEPENING_CANDIDATES, options.requestedRowCount))
      : MAX_DEEPENING_CANDIDATES;

  return candidates.filter((candidate) => needsDeepening(candidate, attrs)).slice(0, cap);

}
