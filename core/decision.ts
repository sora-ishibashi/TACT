import { Task } from "../types/task";

export function decide(task: Task) {
  const title = task.title.toLowerCase();

  if (title.includes("レポート")) {
    return "report";
  }

  if (title.includes("面接")) {
    return "interview";
  }

  if (title.includes("コード")) {
    return "coding";
  }

  return "general";
}