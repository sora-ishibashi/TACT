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

    .filter((item) => !PORTAL_TITLE_MARKERS.some((marker) => item.claim.includes(marker)))

    .map((item) => ({

      name: item.claim.trim(),

      url: item.source,

      source: item.source,

      evidenceId: item.id,

      evidenceText: `${item.claim} ${item.evidence ?? ""}`,

    }));

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
