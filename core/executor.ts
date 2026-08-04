import { Workflow } from "../types/workflow";

export async function execute(workflow: Workflow) {
  const results = [];

  for (const step of workflow.steps) {
    console.log(
      `Executing ${step.agent.name} using ${step.provider}...`
    );

    results.push({
      agent: step.agent.name,
      provider: step.provider,
      output: `${step.agent.name} completed.`,
    });
  }

  return results;
}