import { Evidence } from "../context/types";

export function buildEvidenceSection(
  evidence: Evidence[]
) {

  if (evidence.length === 0) {

    return `
========================
Research Evidence
========================

None

No verified evidence exists yet.

If factual information is required,
use an appropriate Tool.
`;

  }

  const text = evidence
    .map((item, index) => {

      return `

Evidence #${index + 1}

Claim
${item.claim}

Evidence
${item.evidence}

Source
${item.source ?? "Unknown"}

Confidence
${item.confidence}

Tags
${item.tags.length
  ? item.tags.join(", ")
  : "None"}
`;

    })
    .join("\n");

  return `
========================
Research Evidence
========================

The following evidence has already been verified.

Always prioritize this evidence.

Never invent facts.

${text}
`;

}