export type TaskStatus =
  | "waiting"
  | "planning"
  | "running"
  | "completed";

export interface Task {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
}