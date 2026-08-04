import { Agent } from "../agent/types";

export function selectTools(
  agent: Agent,
  task: string
): string[] {

  const tools: string[] = [];

  const text = task.toLowerCase();

  if (
    text.includes("調査") ||
    text.includes("検索") ||
    text.includes("情報")
  ) {
    tools.push("web-search");
  }

  if (
    text.includes("github") ||
    text.includes("コード")
  ) {
    tools.push("github");
  }

  if (
    text.includes("ライブラリ") ||
    text.includes("npm")
  ) {
    tools.push("npm");
  }

  return tools.filter(tool =>
    agent.tools.includes(tool)
  );
}