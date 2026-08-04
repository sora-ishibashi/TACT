export interface WorkflowStep {
  id: string;
  agent: string;
  task: string;
  description?: string;
}

export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
}