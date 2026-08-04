export interface NormalizedEvidence {

  claim: string;

  evidence: string;

  source: string;

  score?: number;

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

  };

}