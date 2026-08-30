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
// 使って」「PC内の資料を参考に」「PCにある資料」等、ユーザーが明示的に
// ローカルの資料を参照してほしいと述べた場合のみtrueになる。
// 「ファイル」「資料」のような単体では一般的な語も、指示に明記された
// トリガー語として含める(強く判定してよい、という指示に基づく)。
// 誤判定した場合の安全性はcandidate側で担保する(0件ならWorkspaceは
// 使われない、threshold未満の無関係fileはreadしない)ため、多少
// 広めに拾うこと自体はリスクにならない。将来的な高度化(意味的な
// 参照検出等)を妨げないよう、単体の関数としてexportする
// (呼び出し元から差し替え可能な、独立した判定点として保つ)。
const EXPLICIT_WORKSPACE_INTENT_PATTERNS: readonly RegExp[] = [
  /ローカル/,
  /ワークスペース/,
  /workspace/i,
  /ファイル/,
  /資料/,
  /pc\s*内/i,
  /pcの中/i,
  /pcにある/i,
  /パソコン(の中|内|にある)/,
  /前に作った/,
  /手元(にある|の)資料/,
  /保存(した|してある)/,
  /自分のファイル/,
];

// =========================
// Explicit workspace opt-out (Section2/8)
// =========================
//
// 「ローカルは使わずに調べて」「Workspaceを参照しないで」のように、
// ユーザーが明示的にLocal Workspaceを使わないよう指示した場合、
// EXPLICIT_WORKSPACE_INTENT_PATTERNSに一致していても利用しない
// (Section8「明示的にWorkspaceを使わない指示がある場合は利用しない」)。
// Workspace参照語(ローカル/workspace/ワークスペース/資料/ファイル)の
// 近傍に否定表現(使わない/使わず/見ない/見ずに/参照しない/不要 等)が
// 現れるパターンのみを対象とする(無関係な文脈で"ない"が出現するだけで
// 誤ってopt-out判定しないよう、参照語と否定表現をセットで要求する)。
const WORKSPACE_OPT_OUT_PATTERNS: readonly RegExp[] = [
  /ローカル.{0,8}(使わ|参照し|見)(ない|ず)/,
  /(workspace|ワークスペース).{0,8}(使わ|参照し|見)(ない|ず)/i,
  /資料.{0,8}(使わ|見)(ない|ず)/,
  /ファイル.{0,8}(使わ|見)(ない|ず)/,
  /ローカル(は|を)?(なし|不要|無し)/,
];

export function detectExplicitWorkspaceIntent(query: string): boolean {

  if (typeof query !== "string" || !query.trim()) {
    return false;
  }

  return EXPLICIT_WORKSPACE_INTENT_PATTERNS.some((pattern) => pattern.test(query));

}

export function detectWorkspaceOptOut(query: string): boolean {

  if (typeof query !== "string" || !query.trim()) {
    return false;
  }

  return WORKSPACE_OPT_OUT_PATTERNS.some((pattern) => pattern.test(query));

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
// ranking優先順位(3 tier、指示に基づく):
//   1) filename/path exact/strong match … fileName・directory部分への
//      一致(最優先)
//   2) content index match             … 本文一致(2番目)
//   3) weaker metadata match           … 拡張子一致等の弱い一致(最後)
// 各tierの重みは、あるtierの1件の一致が、常に下位tierの1件の一致を
// 上回るよう間隔を空けて設定する(tier間の逆転が起きない値、
// tier1=4/3・tier2=2・tier3=1)。スコア0(=どのtermとも一致しない)の
// fileは候補にしない(threshold未満の無関係fileはreadしない)。
const NAME_MATCH_WEIGHT = 4;
const PATH_MATCH_WEIGHT = 3;
const CONTENT_MATCH_WEIGHT = 2;
const EXTENSION_MATCH_WEIGHT = 1;

function countMatchingTerms(haystack: string, terms: string[]): number {

  const lower = haystack.toLowerCase();

  return terms.reduce(
    (count, term) => count + (lower.includes(term) ? 1 : 0),
    0
  );

}

// entry.nameは常に"<basename>.<extension>"の形をしている(拡張子付き
// fileの場合)ため、nameへの一致判定をそのまま使うと、拡張子と一致した
// termがname一致としても二重にカウントされ、tier1(name/path)と
// tier3(拡張子)が実質的に分離できなくなる。ここでnameから拡張子
// suffixを取り除いたbasenameだけをtier1判定に使うことで、
// 「拡張子にしか一致しないtermはtier3としてのみ扱う」という3 tierの
// 分離を保証する。
function stripExtensionSuffix(name: string, extension?: string): string {

  if (!extension) {
    return name;
  }

  const suffix = `.${extension}`;

  return name.toLowerCase().endsWith(suffix.toLowerCase())
    ? name.slice(0, name.length - suffix.length)
    : name;

}

export interface RankedWorkspaceCandidate {
  entry: ContextSourceEntryMetadata;
  // fileName・directory部分・拡張子一致の合計(後方互換のため維持する
  // 集計値。tier別の内訳はscore計算時にのみ使う)。
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

    // relativePathは"directory部分 + fileName"の形で構築されている
    // (browserAdapter.tsのwalkEntries())ため、末尾からfileName長を
    // 引くだけでdirectory部分(末尾の"/"を含む、rootならば空文字)を
    // 安全に取り出せる。
    const directoryPortion = entry.relativePath.slice(
      0,
      entry.relativePath.length - entry.name.length
    );

    const nameMatchCount = countMatchingTerms(
      stripExtensionSuffix(entry.name, entry.extension),
      terms
    );
    const pathMatchCount = countMatchingTerms(directoryPortion, terms);
    const extensionMatchCount = entry.extension
      ? countMatchingTerms(entry.extension, terms)
      : 0;

    const content = contentByPath.get(entry.relativePath);
    const contentMatchCount = content ? countMatchingTerms(content, terms) : 0;

    const metadataMatchCount = nameMatchCount + pathMatchCount + extensionMatchCount;

    const score =
      nameMatchCount * NAME_MATCH_WEIGHT +
      pathMatchCount * PATH_MATCH_WEIGHT +
      contentMatchCount * CONTENT_MATCH_WEIGHT +
      extensionMatchCount * EXTENSION_MATCH_WEIGHT;

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
