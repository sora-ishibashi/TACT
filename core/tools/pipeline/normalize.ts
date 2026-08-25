export interface NormalizedEvidence {

  claim: string;

  evidence: string;

  source: string;

  score?: number;

  // Phase43: SearchResult.publishedAt(Provider側で取得できた場合のみ
  // 設定される、core/search/types.ts参照)をそのまま素通しする。
  // ここでは正規化・推測を行わない(既にProvider側で正規化済みのため)。
  publishedAt?: string;

}

export function normalizeResult(
  item: any
): NormalizedEvidence {

  return {

    claim:
      item.title ??
      item.fact ??
      "",

    evidence:
      item.content ??
      item.snippet ??
      "",

    source:
      item.url ??
      item.source ??
      "",

    score:
      item.score,

    publishedAt:
      item.publishedAt,

  };

}