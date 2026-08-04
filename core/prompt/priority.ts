export function buildPrioritySection() {

  return `
========================
Context Priority
========================

Use information in the following order.

1.
System Prompt

2.
Current Task

3.
Research Evidence

4.
Reviewer Memory

5.
Workflow History

6.
Outputs from Other Agents

7.
Tool Results

Higher priority information always overrides lower priority information.

Never allow lower priority information to contradict higher priority information.

Never invent facts.

Never guess.

When information is missing,
request a Tool instead.
`;

}