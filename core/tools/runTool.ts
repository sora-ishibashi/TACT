import { toolRegistry } from "./registry";

export async function runTool(
  toolId: string,
  input: Record<string, unknown>
) {

  const tool =
    toolRegistry.get(toolId);


  if (!tool) {

    throw new Error(
      `Tool '${toolId}' not found.`
    );

  }


  return await tool.execute(input);

}