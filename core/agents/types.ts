import type { Provider } from "../agent/types";

export type AgentId =
  | "planner"
  | "queryBuilder"
  | "researcher"
  | "designer"
  | "engineer"
  | "stakeholder"
  | "reviewer"
  | "writer";


export interface Agent {

  id: AgentId;

  name: string;

  role: string;

  provider: Provider;

  tools: string[];

  rules: string[];

  systemPrompt: string;

}