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

  let score = 0;

  switch (evidence.sourceType) {

    case "official":
      score += 100;
      break;

    case "government":
      score += 95;
      break;

    case "paper":
      score += 90;
      break;

    case "news":
      score += 70;
      break;

    case "media":
      score += 50;
      break;

    case "community":
      score += 30;
      break;

    default:
      score += 10;

  }

  if (evidence.isPrimarySource)
    score += 20;

  score +=
    evidence.freshnessScore ?? 0;

  score +=
    evidence.score ?? 0;

  return score;

}