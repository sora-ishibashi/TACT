// =========================
// TACT Context Source — Local Workspace Context Resolver (LW-P3)
// =========================
//
// 目的: Research userInputから、Local Workspace内の関連ファイルを
// deterministicに(LLM/Search API 0で)絞り込むための純粋関数群。
// 実際にfile本文を読む処理(FileSystemFileHandle経由)はここに含めない
// (browserAdapter.tsのresolveWorkspaceContext()が、ここのpure
// functionと既存read()の安全確認パイプラインを組み合わせて実行する)。
// DOM/Browser API/Node fsのいずれにも依存しない。
//
// 重要: ここでの一連の判定は「Workspace参照の意図が明示された場合の
// みsearch/readを行う」という前提を支える(Section2)。
// detectExplicitWorkspaceIntent()がfalseを返す通常のResearch
// (例:「トヨタについて調べて」)では、呼び出し元(browserAdapter.ts)は
// directoryHandleへ一切アクセスしない設計になっている
// (=このモジュールのランキング関数まで到達しない)。

import type { ContextSourceEntryMetadata } from "../types";
import type { LocalWorkspaceContentIndex } from "./contentIndex";
import type { LocalWorkspaceEvidence } from "./types";

// =========================
// Bounded retrieval limits(Section3)
// =========================

export const MAX_WORKSPACE_QUERY_TERMS = 8;
export const MAX_WORKSPACE_SEARCH_CANDIDATES = 10;
export const MAX_WORKSPACE_READ_FILES = 3;
export const MAX_WORKSPACE_TOTAL_CONTEXT_CHARS = 50_000;

// =========================
// Explicit workspace intent (Section2)
// =========================
//
// 「ローカル資料を参考に」「Workspaceから探して」「前に作ったSROI資料を
// 使って」「PC内の資料を参考に」等、ユーザーが明示的にローカルの資料を
// 参照してほしいと述べた場合のみtrueになる。将来的な高度化(意味的な
// 参照検出等)を妨げないよう、単体の関数としてexportする
// (呼び出し元から差し替え可能な、独立した判定点として保つ)。
const EXPLICIT_WORKSPACE_INTENT_PATTERNS: readonly RegExp[] = [
  /ローカル/,
  /ワークスペース/,
  /workspace/i,
  /pc\s*内/i,
  /pcの中/i,
  /パソコン(の中|内)/,
  /前に作った/,
  /手元(にある|の)資料/,
  /保存(した|してある)資料/,
  /自分のファイル/,
];

export function detectExplicitWorkspaceIntent(query: string): boolean {

  if (typeof query !== "string" || !query.trim()) {
    return false;
  }

  return EXPLICIT_WORKSPACE_INTENT_PATTERNS.some((pattern) => pattern.test(query));

}

// =========================
// Deterministic query term extraction
// =========================
//
// 日本語はASCIIのような単語区切り(space)を持たないため、スクリプト別に
// 独立した正規表現で走査する。1本の文字クラス(\p{L}等)で両方を賄うと、
// 区切り文字が無い限りASCIIと日本語が1つの巨大なtermへ結合されてしまい、
// "ローカルのSROI資料を参考に"のような文中に埋め込まれたASCII固有名詞
// ("SROI")が実質的に検索不能になる。ASCII用パターンと日本語(ひらがな・
// カタカナ・漢字)用パターンを別々に走査することで、区切り文字が無くても
// スクリプトの切り替わり自体が自然な境界として働く。
const ASCII_TERM_PATTERN = /[A-Za-z0-9][A-Za-z0-9_-]{1,}/g;
// ぀-ヿ: ひらがな・カタカナ、一-龯: CJK統合漢字(基本部分)。
const CJK_TERM_PATTERN = /[぀-ヿ一-龯]{2,}/g;

export function extractWorkspaceQueryTerms(
  query: string,
  maxTerms: number = MAX_WORKSPACE_QUERY_TERMS
): string[] {

  if (typeof query !== "string" || !query.trim()) {
    return [];
  }

  const asciiMatches = query.match(ASCII_TERM_PATTERN) ?? [];
  const cjkMatches = query.match(CJK_TERM_PATTERN) ?? [];

  const seen = new Set<string>();
  const terms: string[] = [];

  for (const raw of [...asciiMatches, ...cjkMatches]) {

    const term = raw.toLowerCase();

    if (!seen.has(term)) {
      seen.add(term);
      terms.push(term);
    }

  }

  if (terms.length <= maxTerms) {
    return terms;
  }

  // 上限を超える場合、より長い(=より固有性が高いと想定される)termを
  // 優先する。同じ長さのterm間は元の出現順を保つ(安定ソート)。
  return [...terms].sort((a, b) => b.length - a.length).slice(0, maxTerms);

}

// =========================
// Deterministic ranking (Section3)
// =========================
//
// ranking基準: filename/path一致(重み2倍)・content index一致・
// query term coverage(一致したterm数そのもの)。スコア0(=どのtermとも
// 一致しない)のfileは候補にしない(threshold未満の無関係fileはread
// しない)。

function countMatchingTerms(haystack: string, terms: string[]): number {

  const lower = haystack.toLowerCase();

  return terms.reduce(
    (count, term) => count + (lower.includes(term) ? 1 : 0),
    0
  );

}

export interface RankedWorkspaceCandidate {
  entry: ContextSourceEntryMetadata;
  metadataMatchCount: number;
  contentMatchCount: number;
  score: number;
}

export function rankWorkspaceCandidates(
  entries: ContextSourceEntryMetadata[],
  contentIndex: LocalWorkspaceContentIndex,
  terms: string[],
  limit: number = MAX_WORKSPACE_SEARCH_CANDIDATES
): RankedWorkspaceCandidate[] {

  if (terms.length === 0) {
    return [];
  }

  const contentByPath = new Map(
    contentIndex.map((item) => [item.relativePath, item.contentLower])
  );

  const scored: RankedWorkspaceCandidate[] = [];

  for (const entry of entries) {

    if (entry.type !== "file") {
      continue;
    }

    const metadataMatchCount = countMatchingTerms(
      `${entry.name} ${entry.relativePath} ${entry.extension ?? ""}`,
      terms
    );

    const content = contentByPath.get(entry.relativePath);
    const contentMatchCount = content ? countMatchingTerms(content, terms) : 0;

    const score = metadataMatchCount * 2 + contentMatchCount;

    if (score > 0) {
      scored.push({ entry, metadataMatchCount, contentMatchCount, score });
    }

  }

  // 決定論的な並び: score降順 → metadataMatchCount降順 →
  // relativePath昇順(完全な安定順序を保証する)。
  scored.sort((a, b) => {

    if (b.score !== a.score) {
      return b.score - a.score;
    }

    if (b.metadataMatchCount !== a.metadataMatchCount) {
      return b.metadataMatchCount - a.metadataMatchCount;
    }

    return a.entry.relativePath.localeCompare(b.entry.relativePath);

  });

  return scored.slice(0, limit);

}

export function selectFilesWithinReadLimit(
  ranked: RankedWorkspaceCandidate[],
  maxFiles: number = MAX_WORKSPACE_READ_FILES
): RankedWorkspaceCandidate[] {

  return ranked.slice(0, maxFiles);

}

// =========================
// Total context char budget (Section3)
// =========================
//
// 個々のEvidence本文を途中で切り詰めることはしない(1file単位の
// truncationは既にread()側で行われている、readPolicy.ts参照)。
// ここでは「読んだ結果を全部足すと大きすぎる場合、優先順位の低い
// fileから丸ごと除外する」というfile単位の予算管理のみを行う
// (順位が高い後続のfileがまだ予算内に収まる可能性があるため、
// 超過したfileはskipして次を試す)。
export function boundWorkspaceEvidenceByCharBudget(
  evidenceList: LocalWorkspaceEvidence[],
  maxTotalChars: number = MAX_WORKSPACE_TOTAL_CONTEXT_CHARS
): LocalWorkspaceEvidence[] {

  const result: LocalWorkspaceEvidence[] = [];
  let total = 0;

  for (const item of evidenceList) {

    const length = item.evidence.evidence.length;

    if (total + length > maxTotalChars) {
      continue;
    }

    result.push(item);
    total += length;

  }

  return result;

}
