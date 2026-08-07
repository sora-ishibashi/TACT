import { createWorkflow } from ".";

export const defaultWorkflow =
  createWorkflow({

    id: "default",

    name: "Default Workflow",

    steps: [

      {
        id: "1",
        agent: "planner",
        task: "Create an execution plan.",
      },

      {
        id: "2",
        agent: "queryBuilder",
        task: "Generate search strategy.",
      },

      {
        id: "3",
        agent: "researcher",
        task: "Collect factual evidence from reliable sources.",
      },

      {
        id: "4",
        agent: "analyst",
        task: "Analyze market, competitors, trends, and insights using collected evidence.",
      },

      {
        id: "5",
        agent: "designer",
        task: "Design the best solution based on the analysis.",
      },

      {
        id: "6",
        agent: "engineer",
        task: "Propose technical implementation and architecture.",
      },

      {
        id: "7",
        agent: "stakeholder",
        task: "Evaluate business value, risks, and recommendations.",
      },

      {
        id: "8",
        agent: "reviewer",
        task: "Review quality, consistency, and evidence coverage.",
      },

      {
        id: "9",
        agent: "writer",
        task: "Generate the final report.",
      },

    ],

  });