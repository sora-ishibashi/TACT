import { Workflow } from "../types/workflow";

import { planner } from "./agents/planner";
import { researcher } from "./agents/researcher";
import { writer } from "./agents/writer";
import { reviewer } from "./agents/reviewer";

export function plan(): Workflow {  return {
    id: crypto.randomUUID(),

    name: "Report Workflow",

    steps: [
      {
        id: crypto.randomUUID(),
        title: "計画",

        agent: planner,
        provider: "openai",
      },

      {
        id: crypto.randomUUID(),
        title: "調査",

        agent: researcher,
        provider: "gemini",
      },

      {
        id: crypto.randomUUID(),
        title: "執筆",

        agent: writer,
        provider: "claude",
      },

      {
        id: crypto.randomUUID(),
        title: "レビュー",

        agent: reviewer,
        provider: "openai",
      },
    ],
  };
}