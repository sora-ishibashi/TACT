import { Evidence } from "../context/types";

export function rankEvidence(
  evidences: Evidence[]
) {

  return [...evidences].sort((a, b) => {

    const scoreA =
      calculateScore(a);

    const scoreB =
      calculateScore(b);

    return scoreB - scoreA;

  });

}
function calculateScore(
  evidence: Evidence
) {

  // sourceType / confidence / publishedAt由来の鮮度は
  // scoreEvidence()がevidence.score算出時に既に評価済みのため、
  // ここで同じ軸を再評価すると二重加点になる。
  // ここではevidence.scoreに含まれていない軸
  // （一次情報かどうか・freshnessScore）だけを追加で評価する。

  let score =
    evidence.score ?? 0;

  if (evidence.isPrimarySource)
    score += 20;

  score +=
    evidence.freshnessScore ?? 0;

  return score;

}