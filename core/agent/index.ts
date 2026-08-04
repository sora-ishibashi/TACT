import { Agent } from "./types";

export function createAgent(
  agent: Agent
) {

  console.log(
    "Agent created:",
    agent.name
  );

  return agent;
}