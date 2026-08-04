export function buildWorkflowSection(
  stepOutputs?: Record<
    string,
    {
      agent: string;
      output: unknown;
    }
  >
) {

  if (
    !stepOutputs ||
    Object.keys(stepOutputs).length === 0
  ) {

    return `
========================
Workflow Progress
========================

No workflow has been executed yet.
`;

  }

  const completed = Object.values(stepOutputs)
    .map(
      (step, index) =>
        `${index + 1}. ${step.agent} ✓`
    )
    .join("\n");

  const details = Object.entries(stepOutputs)
    .map(
      ([stepId, step]) => `
------------------------
Step ${stepId}

Agent
${step.agent}

Output
${JSON.stringify(
  step.output,
  null,
  2
)}
`
    )
    .join("\n");

  return `
========================
Workflow Progress
========================

Completed Agents

${completed}

========================
Workflow Details
========================

${details}
`;

}