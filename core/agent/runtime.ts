import { Agent } from "./types";

export async function runAgent(
  agent: Agent,
  input: string
) {
  console.log(`Running Agent: ${agent.name}`);

  return {
    output: input,
  };
}