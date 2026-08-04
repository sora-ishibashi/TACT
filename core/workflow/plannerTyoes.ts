export interface PlannerStep {
  id: string;

  agent: string;

  task: string;
}

export interface PlannerResult {
  plan: PlannerStep[];
}