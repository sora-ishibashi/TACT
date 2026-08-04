import { Evidence } from "../context/types";

export interface EvidenceIssue {

  type: "missing-source";

  message: string;

}

export function checkEvidence(

  evidence: Evidence[]

): EvidenceIssue[] {

  const issues: EvidenceIssue[] = [];

  for (const item of evidence) {

    if (!item.source) {

      issues.push({

        type: "missing-source",

        message: `Evidence '${item.claim}' has no source.`

      });

    }

  }

  return issues;

}