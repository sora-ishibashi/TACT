import { Task } from "../types/task";
import { plan } from "./planner";
import { execute } from "./executor";

export async function orchestrate(task: Task) {
  console.log("===== TACT START =====");

  const workflow = plan();

  console.log("Workflow");
  console.log(workflow);

  const results = await execute(workflow);

  console.log("Results");
  console.log(results);

  return results;
}