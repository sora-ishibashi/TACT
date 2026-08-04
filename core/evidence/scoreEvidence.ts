import { Evidence } from "../context/types";

export function scoreEvidence(
  evidence: Evidence
): number {

  let score = 0;

  // =====================
  // Confidence
  // =====================

  switch (evidence.confidence) {

    case "high":
      score += 30;
      break;

    case "medium":
      score += 20;
      break;

    case "low":
      score += 10;
      break;

  }

  // =====================
  // Source Type
  // =====================

  switch (evidence.sourceType) {

    case "government":
      score += 50;
      break;

    case "official":
      score += 45;
      break;

    case "paper":
      score += 45;
      break;

    case "news":
      score += 35;
      break;

    case "media":
      score += 20;
      break;

    case "community":
      score += 10;
      break;

    default:
      score += 5;

  }

  // =====================
  // Freshness
  // =====================

  if (evidence.publishedAt) {

    const year =
      new Date(
        evidence.publishedAt
      ).getFullYear();

    const now =
      new Date().getFullYear();

    const diff =
      now - year;

    if (diff <= 0) {

      score += 20;

    } else if (diff === 1) {

      score += 15;

    } else if (diff === 2) {

      score += 10;

    }

  }

  return score;

}