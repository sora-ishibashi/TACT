import type { Agent } from "../core/agent/types";
import { LLMProvider } from "../core/router/types";

export interface WorkflowStep {
  id: string;
  title: string;

  agent: Agent;

  provider: LLMProvider;
}

export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
}