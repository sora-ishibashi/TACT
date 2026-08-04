export function buildMemorySection(
  memory?: Record<string, string[]>,
  agentId?: string
) {

  const agentMemory =
    agentId &&
    memory?.[agentId] &&
    memory[agentId].length > 0
      ? memory[agentId]
      : [];

  if (agentMemory.length === 0) {

    return `
========================
Reviewer Memory
========================

None

No unresolved improvement requests exist.

Proceed with your normal responsibility.
`;

  }

  const improvements =
    agentMemory
      .map(
        (item, index) =>
          `${index + 1}. ${item}`
      )
      .join("\n");

  return `
========================
Reviewer Memory
========================

The following improvements were requested
by the Reviewer.

These requests have the highest priority
after Research Evidence.

Do NOT ignore them.

If they have already been addressed,
do NOT repeat them.

Improvement Requests

${improvements}
`;

}