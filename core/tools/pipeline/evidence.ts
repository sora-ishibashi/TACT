import { normalizeResult } from "./normalize";
import { Evidence } from "@/core/context/types";
import { removeDuplicates } from "./removeDuplicates";
import { autoTag } from "./autoTag";
import { scoreEvidence } from "@/core/evidence/scoreEvidence";
import { inferSourceType } from "@/core/evidence/retrieveEvidence";

export function executeEvidencePipeline(
  results: any[],
  createdBy = "researcher"
): Evidence[] {

  const evidence =
    buildEvidence(
      results,
      createdBy
    ).map(autoTag);

  return removeDuplicates(

    evidence,

    item =>
      `${item.claim}${item.source}`

  );

}

export function buildEvidence(
  results: any[],
  createdBy = "researcher"
): Evidence[] {

  return results.map((item) => {

    const normalized =
      normalizeResult(item);

    const evidence: Evidence = {

      id: crypto.randomUUID(),

      claim:
        normalized.claim,

      evidence:
        normalized.evidence,

      source:
        normalized.source,

      confidence:
        convertConfidence(
          normalized.score
        ),

      score: 0,

      publishedAt: undefined,

      sourceType:
        inferSourceType(
          normalized.source
        ),

      createdBy,

      createdAt: Date.now(),

      tags: [],

    };

    evidence.score =
      scoreEvidence(evidence);

    return evidence;

  });

}

function convertConfidence(
  score: number | undefined
): "low" | "medium" | "high" {

  if (!score) return "medium";

  if (score >= 0.9) return "high";

  if (score >= 0.7) return "medium";

  return "low";

}