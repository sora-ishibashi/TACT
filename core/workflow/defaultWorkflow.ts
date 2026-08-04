import { createWorkflow } from ".";

export const defaultWorkflow =
  createWorkflow({

    id: "default",

    name: "Default Workflow",

    steps: [

      {
        id: "1",
        agent: "planner",
        task: "Create a plan.",
      },

      {
        id: "2",
        agent: "researcher",
        task: "Research the topic.",
      },

      {
        id: "3",
        agent: "reviewer",
        task: "Review the result.",
      },

    ],

  });