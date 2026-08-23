// =========================
// relevance (STEP180)
// =========================
//
// TACT Research内部で共有する、決定論的な(LLM不要の)関連度スコアリング
// ヘルパー。
//
// 単純な空白区切りtokenだけでは、日本語の文章(例:「TACTの目的は？」)が
// 空白を含まないために文章全体が1tokenとして扱われ、
// 「Knowledgeの本文にその文章全体が一字一句含まれていない限り
// マッチしない」という実用に耐えない挙動になる
// (core/tact-core/mockCoreCapability.tsのSTEP177実装が抱える、
// 同じ弱点)。
//
// そのため、既存のcore/evidence/retrieveEvidence.tsが採用している
// 「文字n-gram(2文字・3文字)によるcompact文字列同士の部分一致」という
// 技法を、TACT Research内で独立して適用する
// (retrieveEvidence.ts自体のqueryTokens/overlapScore等はexportされて
// いないためimportできない。ロジックの技法だけを踏襲した独立実装。
// Evidence[]専用の重み付け(sourceType/confidence/freshness)は
// Research側のスコアリングには不要なため持ち込まない)。

function normalize(text: string): string {

  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

}

function compact(text: string): string {
  return normalize(text).replace(/\s+/g, "");
}

function wordTokens(text: string): string[] {

  return normalize(text)
    .split(/\s+/)
    .filter(Boolean);

}

function ngrams(text: string, size: number): string[] {

  const source = compact(text);

  if (source.length < size) return [];

  const result: string[] = [];

  for (let i = 0; i <= source.length - size; i++) {
    result.push(source.slice(i, i + size));
  }

  return result;

}

function queryTokens(query: string): string[] {

  const words = wordTokens(query);
  const grams2 = ngrams(query, 2);
  const grams3 = ngrams(query, 3);

  return Array.from(new Set([...words, ...grams2, ...grams3]));

}

export function scoreRelevance(
  searchableText: string,
  query: string
): number {

  const tokens = queryTokens(query);

  if (tokens.length === 0) {
    return 0;
  }

  const normalized = normalize(searchableText);
  const compacted = compact(searchableText);

  let score = 0;

  for (const token of tokens) {

    if (!token) continue;

    if (normalized.includes(token) || compacted.includes(token)) {

      // 3文字以上のtoken(=空白区切りの単語、または3-gram)が一致した
      // 場合は、2-gram単独一致より重みを大きくする(偶然の2文字一致で
      // スコアが膨らみすぎないようにするため)。
      score += token.length >= 3 ? 2 : 1;

    }

  }

  return score;

}

export function selectTopRelevant<T>(
  items: T[],
  toSearchableText: (item: T) => string,
  query: string,
  limit: number
): T[] {

  return items
    .map((item) => ({
      item,
      score: scoreRelevance(toSearchableText(item), query),
    }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((scored) => scored.item);

}
