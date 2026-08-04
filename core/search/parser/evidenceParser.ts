import { SearchResult } from "../types";

export type Evidence = {

  id: string;

  title: string;

  url: string;

  fact: string;

  confidence: number;

};

export function evidenceParser(
  results: SearchResult[]
): Evidence[] {

  return results.map((result, index) => ({

    id: String(index + 1),

    title: result.title,

    url: result.url,

    fact: result.content,

    confidence:
      Math.max(
        0,
        Math.min(1, result.score)
      ),

  }));

}