import { tools } from "../tools";

export function buildToolsSection() {

  if (tools.length === 0) {

    return `
========================
Available Tools
========================

No tools are available.
`;

  }

  const toolDescriptions =
    tools
      .map(
        (tool) => `
Tool

${tool.id}

Description

${tool.description}

Parameters

${JSON.stringify(
  tool.parameters,
  null,
  2
)}

When to use

Use this Tool only when
required information
cannot be obtained from
Research Evidence
or Workflow History.

Do NOT use this Tool
if sufficient evidence
already exists.
`
      )
      .join("\n");

  return `
========================
Available Tools
========================

The following tools are available.

${toolDescriptions}

========================
Tool Usage Rules
========================

Only request a Tool when:

• Verified information is missing

• Research Evidence is insufficient

• Current data is required

Never request a Tool
for information that already exists.

Never call the same Tool repeatedly
for the same purpose.

If Tool Results already exist,
use them instead of requesting
another Tool.
`;

}