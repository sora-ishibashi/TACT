import { createWorkflow, runWorkflow } from "./workflow";

export async function runTACT() {

  const workflow = createWorkflow({
    id: "basic",
    name: "Basic Workflow",

    steps: [
      {
        id: "1",
        agent: "planner",
        task: "Create a plan",
      },
      {
        id: "2",
        agent: "researcher",
        task: "Research the topic",
      },
      {
        id: "3",
        agent: "reviewer",
        task: "Review the result",
      },
      {
        id: "4",
        agent: "writer",
        task: "Write the final answer",
      },
    ],
  });

  const result = await runWorkflow(
    workflow,
    "TACTの設計を考えたい",
    "think",
    (event) => {
      console.log("Workflow Event:", event);
    }
  );

  return result;

}