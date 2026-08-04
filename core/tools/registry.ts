import { tools } from "./index";

export const toolRegistry =
  new Map(
    tools.map(tool => [
      tool.id,
      tool,
    ])
  );